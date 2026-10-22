'use strict';
/**
 * 码率模型：按「像素数 × 帧率 × bpp」给每个文件算目标码率。
 *
 * 锚点：1978×1080 @ 25fps → 2213k（用户参考样本，已验证 PSNR 46.6dB）
 *       bpp = 2,213,000 / (1978 × 1080 × 25) = 0.041437 → 取 0.0414
 *
 * 为什么必须用「缩放后」尺寸：编码器实际编码的就是它。
 * 若用源尺寸，4K→1080p 会算出 4293k，直接破坏锚点。
 *
 * 改这里的常量时，必须同步 public/index.html 里同名的那份（前端无构建工具）。
 */
const Paths = require('./paths');

/** 三档 bpp（bit per pixel per frame） */
const BPP_TIERS = { small: 0.0300, balanced: 0.0414, high: 0.0524 };

const FPS_FALLBACK = 25;   // 剧集最常见帧率
const FPS_MAX = 120;       // 夹住 120/1 这类脏数据
const FLOOR_KBPS = 600;    // 软下限：480p25 算出 424k 会糊，抬到 600k
const CEIL_KBPS = 12000;   // 绝对上限：4K60 会算出 20603k，必须封顶
const HARD_MIN_KBPS = 150; // 极低源码率时的保命值
const SRC_RATIO = 0.85;    // 低码率源保护：保证任何片子压完都更小
const DEFAULT_KBPS = 2213; // 元数据全缺失时的兜底

function normalizeFps(fps) {
  const f = Number(fps);
  if (!Number.isFinite(f) || f <= 0) return FPS_FALLBACK;
  return Math.min(FPS_MAX, Math.max(1, f));
}

function bppOf(tier) {
  return BPP_TIERS[tier] > 0 ? BPP_TIERS[tier] : BPP_TIERS.balanced;
}

/**
 * 小分辨率补偿系数。
 *
 * 纯 bpp 模型假设「画质只取决于每像素比特数」，但编码效率随画面变小而下降：
 * CTU 尺寸固定，小画面里的块数少、冗余少，平分到每块的比特效率更低。
 * 实测同一 720p 素材，同 bpp 的 PSNR 比 1080p 低约 5dB。
 *
 * 采用 sqrt 曲线：720p → 1.22x，480p → 1.50x，1080p 及以上不补偿。
 * 与业界码率表吻合（1080p→720p 像素少 2.25 倍，推荐码率只低约 1.8 倍）。
 */
function sizeBoost(shortSide) {
  const s = Number(shortSide) || 0;
  if (s <= 0 || s >= 1080) return 1;
  return Math.min(1.5, Math.max(1, Math.sqrt(1080 / s)));
}

/**
 * 只算码率。width/height 必须是「缩放后」尺寸。
 * 返回 null 表示尺寸不可用（调用方自行兜底）。
 */
function estimateKbps(opt) {
  const o = opt || {};
  const w = Math.floor(Number(o.width) || 0);
  const h = Math.floor(Number(o.height) || 0);
  if (w < 2 || h < 2) return null;

  const fps = normalizeFps(o.fps);
  const boost = sizeBoost(Math.min(w, h));
  let k = Math.round((w * h * fps * bppOf(o.tier) * boost) / 1000);

  // ① 先夹绝对值区间
  k = Math.max(FLOOR_KBPS, Math.min(CEIL_KBPS, k));

  // ② 再叠加源码率保护（顺序不能反：否则 300k 的源会被 floor 抬到 600k）
  const src = Math.round(Number(o.srcKbps) || 0);
  if (src > 0) k = Math.min(k, Math.max(HARD_MIN_KBPS, Math.round(src * SRC_RATIO)));

  return k;
}

/**
 * 从 probe 的归一化元数据里推导源码率（kbps）。
 * video.bitrate 在部分 MKV/TS 里为 0，此时用「整体码率 - 音频码率」兜底。
 */
function srcKbpsOf(meta) {
  const m = meta || {};
  const vBit = Number(m.video && m.video.bitrate) || 0;
  const aBit = Number(m.audio && m.audio.bitrate) || 0;
  const total = Number(m.bitrate) || 0;

  let bps = vBit;
  if (!(bps > 0) && total > 0) {
    bps = Math.max(0, total - (aBit || 192000));
  }
  return Math.round(bps / 1000);
}

/**
 * 单文件完整规划：缩放尺寸 + 目标码率。
 * server 的磁盘预检与 TM 建任务共用这一个函数，保证两处数字一致。
 *
 * opt = { width, height, fps, srcKbps, capShort, rateMode, fixedKbps, tier }
 */
function planFile(opt) {
  const o = opt || {};
  const srcW = Math.floor(Number(o.width) || 0);
  const srcH = Math.floor(Number(o.height) || 0);
  const cap = Math.floor(Number(o.capShort) || 0);

  const dim = Paths.targetSize(srcW, srcH, cap);
  const outW = dim ? dim.w : srcW;
  const outH = dim ? dim.h : srcH;

  const fixed = parseInt(String(o.fixedKbps == null ? '' : o.fixedKbps), 10);

  let kbps;
  if (o.rateMode === 'fixed' && fixed > 0) {
    // 用户显式锁定码率：完全覆盖自适应，且不施加 0.85 保护
    kbps = fixed;
  } else {
    kbps = estimateKbps({
      width: outW, height: outH,
      fps: o.fps, srcKbps: o.srcKbps, tier: o.tier
    });
    if (!kbps) kbps = fixed > 0 ? fixed : DEFAULT_KBPS;
  }

  return { srcW, srcH, outW, outH, scaled: !!dim, kbps };
}

/** 预估字节数（1000 进位，与 ffmpeg 的 kbps 定义一致） */
function estimateBytes(kbps, audioKbps, seconds) {
  return ((Number(kbps) || 0) + (Number(audioKbps) || 0)) * 1000 / 8 * (Number(seconds) || 0);
}

module.exports = {
  BPP_TIERS, FPS_FALLBACK, FPS_MAX, FLOOR_KBPS, CEIL_KBPS, HARD_MIN_KBPS, SRC_RATIO, DEFAULT_KBPS,
  normalizeFps, bppOf, sizeBoost, estimateKbps, srcKbpsOf, planFile, estimateBytes
};
