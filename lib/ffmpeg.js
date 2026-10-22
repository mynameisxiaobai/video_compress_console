'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const Paths = require('./paths');

const DEFAULTS = [
  path.join(os.homedir(), 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe'),
  path.join(os.homedir(), 'tools', 'ffmpeg', 'bin', 'ffmpeg'),
  'C:\\ffmpeg\\bin\\ffmpeg.exe'
];

/** 在给定 ffmpeg.exe 路径旁找 ffprobe.exe */
function siblingProbe(ffmpegPath) {
  const dir = path.dirname(ffmpegPath);
  for (const n of ['ffprobe.exe', 'ffprobe']) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function resolve(config) {
  const cfg = config || {};
  const candidates = [];
  if (cfg.ffmpegPath && fs.existsSync(cfg.ffmpegPath)) candidates.push(cfg.ffmpegPath);
  for (const d of DEFAULTS) candidates.push(d);
  // tools\ffmpeg*\bin\ffmpeg.exe 通配
  try {
    const toolsDir = path.join(os.homedir(), 'tools');
    for (const e of fs.readdirSync(toolsDir)) {
      if (!/^ffmpeg/i.test(e)) continue;
      candidates.push(path.join(toolsDir, e, 'bin', 'ffmpeg.exe'));
    }
  } catch (e) { /* ignore */ }
  // PATH
  for (const seg of String(process.env.PATH || '').split(path.delimiter)) {
    if (!seg) continue;
    candidates.push(path.join(seg, 'ffmpeg.exe'));
    candidates.push(path.join(seg, 'ffmpeg'));
  }
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return { ffmpeg: c, ffprobe: siblingProbe(c) }; }
    catch (e) { /* ignore */ }
  }
  return { ffmpeg: null, ffprobe: cfg.ffprobePath && fs.existsSync(cfg.ffprobePath) ? cfg.ffprobePath : null };
}

const MAX_BUF = 40 * 1024 * 1024;

/**
 * 异步执行 ffmpeg/ffprobe 并收齐输出。
 *
 * 重要：本机实测 `spawnSync` 一律报 EBUSY（Node/libuv 在 Windows 上与文件系统
 * 过滤驱动冲突），而异步 `spawn` 正常。因此本项目全面禁用 spawnSync。
 * stdout/stderr 收的是 Buffer，显式 utf8 解码，避免中文路径出现乱码。
 */
function execAsync(exe, args, timeoutMs) {
  return new Promise((resolve) => {
    let so = '', se = '';
    let done = false;
    const finish = (status, error) => {
      if (done) return; done = true;
      clearTimeout(timer);
      resolve({ status, error, stdout: so, stderr: se });
    };
    let ch;
    try {
      ch = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return finish(null, e); }
    const timer = setTimeout(() => { try { ch.kill('SIGKILL'); } catch (e) {} finish(null, new Error('执行超时')); }, timeoutMs || 30000);
    ch.stdout.on('data', d => { if (so.length < MAX_BUF) so += Buffer.from(d).toString('utf8'); });
    ch.stderr.on('data', d => { if (se.length < MAX_BUF) se += Buffer.from(d).toString('utf8'); });
    ch.on('error', e => finish(null, e));
    ch.on('close', c => finish(c, null));
  });
}

/** 跑一次 -version，拿首行版本串（异步） */
async function version(exe) {
  try {
    const r = await execAsync(exe, ['-version'], 20000);
    const line = String(r.stdout || '').split('\n')[0] || '';
    const m = /version\s+([^\s]+)/i.exec(line);
    return { raw: line.trim(), ver: m ? m[1] : null, ok: r.status === 0 };
  } catch (e) {
    return { raw: '', ver: null, ok: false, error: e.message };
  }
}

/**
 * 能力探测：编码器 + 滤镜。结果缓存（缓存的是 Promise，避免并发重复调用）。
 */
const _capsCache = new Map();

function capabilities(exe) {
  if (!exe) return Promise.resolve({});
  if (_capsCache.has(exe)) return _capsCache.get(exe);
  const p = computeCaps(exe).catch(() => ({}));
  _capsCache.set(exe, p);
  return p;
}

async function computeCaps(exe) {
  const caps = {
    hevc_nvenc: false, h264_nvenc: false, libx265: false, libx264: false,
    scale_cuda: false, support_multipass: false, support_tune_hq: false,
    support_spatial_aq: false, support_aq_strength: false,
    support_lookahead: false, support_bref: false
  };
  const r = await execAsync(exe, ['-hide_banner', '-encoders'], 30000);
  const enc = String(r.stdout || '') + String(r.stderr || '');
  caps.hevc_nvenc = /\bhevc_nvenc\b/.test(enc);
  caps.h264_nvenc = /\bh264_nvenc\b/.test(enc);
  caps.libx265 = /\blibx265\b/.test(enc);
  caps.libx264 = /\blibx264\b/.test(enc);

  const rf = await execAsync(exe, ['-hide_banner', '-filters'], 30000);
  caps.scale_cuda = /\bscale_cuda\b/.test(String(rf.stdout || '') + String(rf.stderr || ''));

  if (caps.hevc_nvenc) {
    const rh = await execAsync(exe, ['-hide_banner', '-h', 'encoder=hevc_nvenc'], 30000);
    const h = String(rh.stdout || '') + String(rh.stderr || '');
    caps.support_multipass = /\b-?multipass\b/.test(h);
    caps.support_tune_hq = /\btune\b[\s\S]{0,120}\bhq\b/.test(h);
    // 以下四个用于「同码率提质」，老版本 ffmpeg 缺了就自动降级，不影响主流程
    caps.support_spatial_aq = /\bspatial-aq\b/.test(h);
    caps.support_aq_strength = /\baq-strength\b/.test(h);
    caps.support_lookahead = /\brc-lookahead\b/.test(h);
    caps.support_bref = /\bb_ref_mode\b/.test(h);
  }
  return caps;
}

/**
 * 构造 ffmpeg 参数数组。全程返回数组，由调用者用 spawn(shell:false) 执行，
 * 绝不拼成命令行字符串 —— 源目录名含前导空格，拼串必炸。
 *
 * opts = {
 *   src, out, container, srcW, srcH,
 *   targetW, targetH,            // 已由 bitrate.planFile 算好的输出尺寸
 *   targetKbps, videoBitrate,    // targetKbps 优先，videoBitrate 仅作回退
 *   audioBitrate, encoder, nvencPreset, x265Preset,
 *   keepSubtitle, vbv, faststart, multipass,
 *   aqStrength, rcLookahead, bref,
 *   support_multipass, support_tune_hq, support_spatial_aq, support_lookahead, support_bref
 * }
 */
function buildArgs(opts) {
  const a = [];
  a.push('-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-nostats');

  if (opts.encoder === 'nvenc') {
    a.push('-hwaccel', 'cuda');
  }

  // 输入：容器伪装时显式指定 demuxer（源是 .mp4 扩展名的 Matroska）
  if (opts.container === 'matroska') a.push('-f', 'matroska');
  else if (opts.container === 'riff') a.push('-f', 'avi');

  a.push('-i', opts.src);

  // 流映射：视频必须有；音频用 ? 容忍无音轨的源（录屏/监控/默片），
  // 否则 ffmpeg 会以 "matches no streams" 直接失败。
  a.push('-map', '0:v:0', '-map', '0:a:0?');
  if (opts.keepSubtitle) a.push('-map', '0:s:0?');

  // 缩放：短边上限语义（只降不升，两维偶数）。
  // targetW/targetH 由 bitrate.planFile 预先算好；未提供时用同一函数兜底。
  const size = (Number(opts.targetW) >= 2 && Number(opts.targetH) >= 2)
    ? { w: Math.round(Number(opts.targetW)), h: Math.round(Number(opts.targetH)) }
    : Paths.targetSize(opts.srcW, opts.srcH, opts.targetH);
  if (size && (size.w < Number(opts.srcW) || size.h < Number(opts.srcH))) {
    a.push('-vf', `scale=${size.w}:${size.h}:flags=lanczos`);
  }

  // 码率统一入口：优先用逐文件算好的 targetKbps，回退到外部字符串
  const kbps = Number(opts.targetKbps) > 0
    ? Math.round(Number(opts.targetKbps))
    : (parseInt(String(opts.videoBitrate), 10) || 2213);
  const vRate = kbps + 'k';
  // VBV：峰值 1.5x、缓冲 2 秒。倍率天然随 kbps 缩放，无需额外换算。
  const vbvArgs = () => {
    const maxr = Math.round(kbps * 1.5);
    const bufs = Math.round(maxr * (opts.vbufFactor || 2));
    return ['-maxrate', maxr + 'k', '-bufsize', bufs + 'k'];
  };

  // ---- 视频编码器 ----
  if (opts.encoder === 'nvenc') {
    a.push('-c:v', 'hevc_nvenc');
    a.push('-preset', opts.nvencPreset || 'p6');
    if (opts.support_tune_hq) a.push('-tune', 'hq');
    a.push('-profile:v', 'main', '-pix_fmt', 'yuv420p');
    a.push('-rc', 'vbr', '-b:v', vRate);
    if (opts.vbv) a.push(...vbvArgs());
    // 帧内自适应量化：把码率从平坦区挪给复杂区，老剧暗部/色带收益最直接，
    // 同一趟编码内完成，速度代价近似为零。strength 保持默认 8 ——
    // 提到 12+ 会把胶片颗粒当噪声抹掉，产生蜡像感。
    if (opts.support_spatial_aq) {
      a.push('-spatial-aq', '1');
      const st = Math.min(15, Math.max(1, Number(opts.aqStrength) || 8));
      a.push('-aq-strength', String(st));
    }
    // 前瞻：与 multipass qres 功能重叠，默认不开（0 = 不指定）
    if (opts.support_lookahead && Number(opts.rcLookahead) > 0) {
      a.push('-rc-lookahead', String(Math.round(Number(opts.rcLookahead))));
    }
    // B 帧作参考：能省 3-5%，但老播放器/电视盒子兼容性有风险，默认关
    if (opts.support_bref && opts.bref) {
      a.push('-bf', '3', '-b_ref_mode', 'middle');
    }
    // 合法值只有 disabled/qres/fullres（早先注释写的 quickest/full 在本版本不存在）。
    // fullres 慢 40-70% 但相对 qres 收益很小，批量场景只用 qres。
    if (opts.support_multipass && opts.multipass !== false && opts.multipass !== 'false') {
      const mp = ['qres', 'fullres'].indexOf(opts.multipass) >= 0 ? opts.multipass : 'qres';
      a.push('-multipass', mp);
    }
    // 注意：NVENC 的 -rc vbr 绝不可同时指定 -cq，否则 -b:v 失去意义
  } else {
    a.push('-c:v', 'libx265');
    a.push('-preset', opts.x265Preset || 'medium');
    a.push('-b:v', vRate);
    a.push('-pix_fmt', 'yuv420p', '-profile:v', 'main');
    // x265 同样必须有 VBV：裸 ABR 时峰值完全不可控，长片会明显超出预估
    if (opts.vbv) a.push(...vbvArgs());
    a.push('-x265-params', 'log-level=error:aq-mode=2');
  }

  // ---- 音频 ----
  a.push('-c:a', 'aac', '-b:a', opts.audioBitrate || '192k', '-ar', '44100', '-ac', '2');

  // ---- 字幕 ----
  if (opts.keepSubtitle) {
    a.push('-c:s', 'mov_text');
    a.push('-metadata:s:s:0', 'language=chi');
    a.push('-metadata:s:s:0', 'title=简体中文');
  }

  a.push('-tag:v', 'hvc1');
  a.push('-map_metadata', '0');
  if (opts.faststart) a.push('-movflags', '+faststart');

  a.push('-progress', 'pipe:1');
  // 输出走临时文件（*.part）以实现原子提交，但 ffmpeg 靠扩展名推断容器，
  // .part 不是已知后缀会直接报 "Unable to choose an output format"，必须显式指定。
  a.push('-f', 'mp4');
  a.push(opts.out);
  return a;
}

module.exports = { resolve, version, capabilities, buildArgs, execAsync };
