'use strict';
/**
 * 转码耗时预估。
 *
 * 实测（RTX 4070 Ti SUPER + i9，1080p30 testsrc2 60 秒片源）：
 *   nvenc 无 multipass        2.86x  ~ 3.43x   ← 随分辨率变化
 *   nvenc + -multipass qres   1.79x(1080p) / 1.84x(720p)  ← 几乎不随分辨率变化
 *   x265 medium               1.09x(1080p) / 约 2.7x(720p) ← 随分辨率变化
 *
 * 关键发现：开了 multipass 之后，720p 并不会比 1080p 快——它的分析遍是
 * 按帧推进的，实测封顶约 55fps，与分辨率无关。所以单靠"像素吞吐"一个
 * 尺子必然把 720p 估快一倍。
 *
 * 模型因此分两项，取较大者：
 *   编码耗时 = 像素数 / 编码器吞吐(像素/秒)
 *   multipass 耗时 = 帧数 / 帧率上限（仅 nvenc + multipass）
 *
 * 三条取值来源，优先级从高到低：
 *   1. 本次运行中已完成任务的实测（observe，EMA 平滑）
 *   2. data/history.jsonl 里往次同编码器的实测（中位数，样本够才采信）
 *   3. 内置默认值
 */

const fs = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, '..', 'data', 'history.jsonl');

// 纯编码吞吐（像素/秒）。按本机实测取值，宁可略保守——
// 「说要 10 分钟、结果 8 分钟」比反过来舒服得多。
const DEFAULT_PPS = {
  nvenc: 1.9e8,   // ≈ 1080p30 的 3.1x
  qsv: 1.3e8,
  amf: 1.3e8,
  x265: 8.2e7     // ≈ 1080p30 的 1.3x
};

// NVENC 的帧率上限：实测 1080p/720p 都撞这条线（1.79x@1080p 与 1.84x@720p 几乎相同）。
// 不开 multipass 时约 100fps，开了 -multipass qres 掉到 50fps 上下——
// 也就是说开了 multipass 之后，720p 并不比 1080p 快，光看像素量必然估快一倍。
const NV_FPS_CAP = 100;
const NV_FPS_CAP_MP = 50;

const MIN_SEC = 0.8;      // ffmpeg 启动 + 收尾（faststart 二次封装）的固定开销
const TAIL = 1.04;        // 预留一点余量，宁可略晚不要常常超时
const MIN_PIXELS = 160 * 120;

const mem = Object.create(null);   // kind -> 实测像素吞吐
const memCap = { nv: 0, nvMp: 0 }; // 实测帧率上限（分开/不开 multipass）
let histCache = null;              // { mtimeMs, pps }

/** 把编码器名归到几档 */
function kindOf(encoder) {
  const s = String(encoder || '').toLowerCase();
  if (s.indexOf('nvenc') >= 0) return 'nvenc';
  if (s.indexOf('qsv') >= 0) return 'qsv';
  if (s.indexOf('amf') >= 0 || s.indexOf('vaapi') >= 0) return 'amf';
  return 'x265';           // libx265 以及任何未知软件编码，按最慢的算
}

function mpOn(o) {
  return !!(o && o.multipass !== false && o.multipass !== 'false');
}

function median(nums) {
  const a = nums.slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * 从历史记录里学吞吐。只在文件变动后重读一次。
 * 开了 multipass 的样本会被帧上限支配，pixels/sec 偏低，学进去会把
 * 纯编码吞吐带歪，所以这类样本直接跳过。
 */
function historyPps() {
  let st;
  try { st = fs.statSync(HISTORY_FILE); } catch (e) { return null; }
  if (histCache && histCache.mtimeMs === st.mtimeMs) return histCache.pps;

  const groups = Object.create(null);
  let raw = '';
  try { raw = fs.readFileSync(HISTORY_FILE, 'utf8'); } catch (e) { return null; }
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let r;
    try { r = JSON.parse(s); } catch (e) { continue; }
    if (!r || r.t !== 'job') continue;
    if (r.phase !== 'done' || r.skipped || r.preview) continue;
    const dur = Number(r.duration) || 0;
    const sec = (Number(r.endedAt) - Number(r.startedAt)) / 1000;
    if (!(dur > 1) || !(sec > 0.8)) continue;
    const w = Number(r.targetW) || Number(r.srcW) || 0;
    const h = Number(r.targetH) || Number(r.srcH) || 0;
    const fps = Number(r.srcFps) || 30;
    const pixels = w * h * fps * dur;
    if (pixels < MIN_PIXELS) continue;
    const k = kindOf(r.encoder);
    const frames = fps * dur;
    const fpsReal = frames / sec;
    // 低于 10fps 的样本不可能是正常编码：要么机器被别的程序占满，
    // 要么片源异常难压。学进去只会把往后的预估全带慢。
    if (fpsReal < 10) continue;
    // nvenc 开 multipass 时撞帧率墙（约 50fps）的样本，反映的是分析遍的帧率上限，
    // 不是"这台机器编 1080p 有多快"，混进像素吞吐会把 1080p 也估慢。
    if (k === 'nvenc' && r.multipass !== false && fpsReal < 65) continue;
    const pps = pixels / sec;
    if (pps < DEFAULT_PPS[k] * 0.3) continue;
    (groups[k] || (groups[k] = [])).push(pps);
  }

  const pps = Object.create(null);
  for (const k in groups) {
    if (groups[k].length < 3) continue;
    pps[k] = median(groups[k]);
  }
  histCache = { mtimeMs: st.mtimeMs, pps };
  return pps;
}

/** 当前该编码器的纯编码吞吐（像素/秒） */
function ppsFor(kind) {
  if (mem[kind] > 0) return mem[kind];
  const h = historyPps();
  if (h && h[kind] > 0) return h[kind];
  return DEFAULT_PPS[kind] || DEFAULT_PPS.x265;
}

function mpFps(o) {
  const key = mpOn(o) ? 'nvMp' : 'nv';
  if (memCap[key] > 0) return memCap[key];
  return mpOn(o) ? NV_FPS_CAP_MP : NV_FPS_CAP;
}

/** 输出像素总量 */
function pixelsOf(job) {
  const w = Number(job.targetW) || Number(job.srcW) || 1280;
  const h = Number(job.targetH) || Number(job.srcH) || 720;
  const fps = Math.min(120, Number(job.srcFps) || 30);
  const dur = Number(job.duration) || 0;
  return w * h * fps * dur;
}

/** 帧数：multipass 的分析遍按帧走，所以这一项和分辨率无关 */
function framesOf(job) {
  const fps = Math.min(120, Number(job.srcFps) || 30);
  return (Number(job.duration) || 0) * fps;
}

/** 该任务单独跑完大约要多少秒 */
function jobSeconds(job) {
  const dur = Number(job.duration) || 0;
  if (!(dur > 0)) return 0;
  const o = job.o || {};
  const kind = kindOf(o.encoder);
  let sec = pixelsOf(job) / ppsFor(kind);
  // NVENC 还有第二道墙：帧率封顶，跟分辨率无关
  if (kind === 'nvenc') sec = Math.max(sec, framesOf(job) / mpFps(o));
  return Math.max(1, sec * TAIL + MIN_SEC);
}

/**
 * 任务完成时喂回实测。
 * 只认正常跑完的；太短的样本不学（启动开销占一半，会严重低估）。
 * 如果这次明显是被 multipass 帧上限卡住的，就学帧率、不动像素吞吐——
 * 否则 720p 的实测会冒充成"这台机器编 720p 很慢"，把 1080p 的预估也带歪。
 */
function observe(job) {
  if (!job || job.skipped || job.preview) return;
  if (job.phase !== 'done') return;
  const sec = (Number(job.endedAt) - Number(job.startedAt)) / 1000;
  const dur = Number(job.duration) || 0;
  if (!(sec > 3) || !(dur > 3)) return;
  const pixels = pixelsOf(job);
  if (pixels < MIN_PIXELS) return;

  const o = job.o || {};
  const kind = kindOf(o.encoder);
  const encSec = pixels / ppsFor(kind);

  // 明显被帧率墙卡住：学到的是"每秒能过多少帧"，不是"能编多少像素"。
  // 两者混在一起会让 720p 的实测冒充成"这台机器编 720p 很慢"，把 1080p 也带歪。
  if (kind === 'nvenc' && sec > encSec * 1.3) {
    const f = framesOf(job) / sec;
    if (f > 5) {
      const key = mpOn(o) ? 'nvMp' : 'nv';
      memCap[key] = memCap[key] > 0 ? memCap[key] * 0.6 + f * 0.4 : f;
    }
    histCache = null;
    return;
  }

  mem[kind] = mem[kind] > 0 ? mem[kind] * 0.6 + (pixels / sec) * 0.4 : pixels / sec;
  histCache = null;
}

/** 仅供测试 */
function reset() {
  for (const k of Object.keys(mem)) delete mem[k];
  memCap.nv = 0;
  memCap.nvMp = 0;
  histCache = null;
}

module.exports = {
  jobSeconds, observe, reset, ppsFor, kindOf, mpFps,
  DEFAULT_PPS, NV_FPS_CAP, NV_FPS_CAP_MP
};
