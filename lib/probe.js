'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Paths = require('./paths');
const FFmpeg = require('./ffmpeg');

/**
 * 容器魔数嗅探：只读前 12 字节。
 * 关键场景 —— 源文件扩展名是 .mp4 但真实容器是 Matroska（1A 45 DF A3），
 * 必须在 UI 里提示用户，并据此外显式传给 ffmpeg 正确的 demuxer。
 */
function sniffContainer(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    const hex = buf.toString('hex');
    if (hex.startsWith('1a45dfa3')) return 'matroska';
    if (buf.toString('latin1', 4, 8) === 'ftyp') return 'mp4';
    if (hex.startsWith('52494646')) return 'riff';
    if (hex.startsWith('000001ba') || hex.startsWith('000001b3')) return 'mpeg';
    if (hex.startsWith('3026b275')) return 'asf';
    if (hex.startsWith('1f43b675')) return 'webm';
    return 'unknown';
  } catch (e) {
    return 'error';
  }
}

const CONTAINER_LABEL = {
  matroska: 'Matroska (MKV)',
  mp4: 'MP4',
  riff: 'AVI',
  mpeg: 'MPEG-PS',
  asf: 'ASF/WMV',
  webm: 'WebM',
  unknown: '未知'
};

/** 字幕是否可以转成 mov_text（位图字幕不行） */
const UNSUPPORTED_SUB = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'xsub', 'dvb_subtitle', 'dvb_teletext']);

/**
 * 用 ffprobe 取元数据。返回归一化结构。
 * 注意：本机 spawnSync 会 EBUSY，必须用异步 execAsync。
 */
async function probeFile(exe, file) {
  const base = { file, name: path.basename(file), size: 0, error: null };
  try { base.size = fs.statSync(file).size; } catch (e) { base.error = '无法访问文件'; return base; }

  const container = sniffContainer(file);
  base.container = container;
  base.containerLabel = CONTAINER_LABEL[container] || container;
  base.ext = path.extname(file).toLowerCase().replace('.', '');
  // 伪装判定：扩展名与实际容器不符
  base.disguised = (
    (base.ext === 'mp4' && container === 'matroska') ||
    (base.ext === 'mkv' && container === 'mp4') ||
    (base.ext === 'mp4' && container === 'riff') ||
    (base.ext === 'avi' && container !== 'riff')
  );

  if (!exe) { base.error = 'ffprobe 不可用'; return base; }

  let out = '';
  try {
    const r = await FFmpeg.execAsync(exe, [
      '-v', 'error', '-show_entries',
      'format=format_name,duration,size,bit_rate',
      '-show_entries', 'stream=index,codec_type,codec_name,codec_tag_string,width,height,sample_rate,channels,bit_rate,r_frame_rate',
      '-of', 'json', file
    ], 60000);
    if (r.error) throw r.error;
    out = String(r.stdout || '');
  } catch (e) {
    base.error = '探测失败: ' + e.message;
    return base;
  }

  let data;
  try { data = JSON.parse(out); } catch (e) { base.error = 'ffprobe 输出无法解析'; return base; }

  const fmt = (data && data.format) || {};
  const streams = (data && data.streams) || [];

  const v = streams.find(s => s.codec_type === 'video');
  const au = streams.find(s => s.codec_type === 'audio');
  const subs = streams.filter(s => s.codec_type === 'subtitle');

  let duration = parseFloat(fmt.duration);
  if (!isFinite(duration) || duration <= 0) {
    const sd = Math.max(...streams.map(s => parseFloat(s.duration) || 0), 0);
    duration = sd || 0;
  }
  base.duration = duration;

  const fb = parseInt(fmt.bit_rate, 10);
  base.bitrate = isFinite(fb) && fb > 0 ? fb : Math.round(base.size * 8 / (duration || 1));

  if (v) {
    base.video = {
      codec: v.codec_name,
      width: v.width, height: v.height,
      bitrate: parseInt(v.bit_rate, 10) || 0,
      fps: parseFps(v.r_frame_rate)
    };
  }
  if (au) {
    base.audio = {
      codec: au.codec_name,
      sampleRate: parseInt(au.sample_rate, 10) || 0,
      channels: au.channels || 0,
      // 视频码率缺失时，"整体码率 - 音频码率" 是唯一的兜底依据
      bitrate: parseInt(au.bit_rate, 10) || 0
    };
  }
  base.subtitles = subs.map(s => ({
    codec: s.codec_name,
    convertible: !UNSUPPORTED_SUB.has(s.codec_name)
  }));
  base.hasSubtitle = subs.length > 0;
  base.subtitleOk = subs.length > 0 && subs.some(s => !UNSUPPORTED_SUB.has(s.codec_name));

  // 由 ffprobe 报的 format_name 复核容器（权威来源）
  if (fmt.format_name) {
    const fn = String(fmt.format_name).toLowerCase();
    if (fn.includes('matroska')) base.container = 'matroska';
    else if (fn.includes('mp4') || fn.includes('mov')) base.container = 'mp4';
    base.formatName = fmt.format_name;
  }
  base.disguised = base.disguised || (base.ext === 'mp4' && base.container === 'matroska');

  base.sizeHuman = Paths.humanSize(base.size);
  base.durHuman = Paths.humanDur(base.duration);
  return base;
}

function parseFps(rr) {
  if (!rr) return 0;
  const m = /^(\d+)\/(\d+)$/.exec(String(rr));
  if (!m) { const n = parseFloat(rr); return isFinite(n) ? Math.round(n * 1000) / 1000 : 0; }
  const d = parseInt(m[2], 10);
  if (!d) return 0;
  return Math.round((parseInt(m[1], 10) / d) * 1000) / 1000;
}

/** 递归扫描时跳过的目录，避免把 node_modules 之类当成剧集目录 */
const SKIP_SCAN = new Set(['node_modules', '$recycle.bin', 'system volume information', 'appdata', '.git']);

/**
 * 列出目录里的视频文件。
 * @param {string} dir
 * @param {{recursive?:boolean, maxDepth?:number}} [opts]
 *        拖拽进来的文件夹常常是「剧集/Season 1/01.mp4」这种结构，
 *        所以拖拽路径会传 recursive；手动选文件夹保持原来的单层行为。
 */
function listVideos(dir, opts) {
  opts = opts || {};
  const maxDepth = opts.recursive ? Math.max(1, Math.min(4, Number(opts.maxDepth) || 3)) : 0;
  const out = [];

  const walk = (d, depth) => {
    const ents = fs.readdirSync(d, { withFileTypes: true });
    for (const e of ents) {
      if (e.isDirectory()) {
        if (depth >= maxDepth) continue;
        const nm = e.name;
        if (!nm || nm.charCodeAt(0) === 46) continue;
        if (SKIP_SCAN.has(nm.toLowerCase())) continue;
        try { walk(path.join(d, nm), depth + 1); } catch (err) { /* 无权限等，跳过 */ }
        continue;
      }
      if (!Paths.looksLikeVideo(e.name)) continue;
      const full = path.join(d, e.name);
      try {
        const st = fs.statSync(full);
        out.push({
          file: full, name: e.name, size: st.size, sizeHuman: Paths.humanSize(st.size),
          rel: path.relative(dir, full)
        });
      } catch (err) { /* skip */ }
    }
  };

  try { walk(dir, 0); }
  catch (e) { return { error: e.message, files: [] }; }
  out.sort((a, b) => String(a.rel || a.name).localeCompare(String(b.rel || b.name), 'zh-Hans-CN', { numeric: true }));
  return { files: out };
}

/** 列出子目录（用于浏览） */
function listDirs(dir) {
  const dirs = [];
  const files = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) dirs.push({ name: e.name, path: path.join(dir, e.name) });
      else if (Paths.looksLikeVideo(e.name)) {
        try {
          const st = fs.statSync(path.join(dir, e.name));
          files.push({ name: e.name, path: path.join(dir, e.name), size: st.size, sizeHuman: Paths.humanSize(st.size) });
        } catch (err) { /* skip */ }
      }
    }
  } catch (e) {
    return { error: e.message, dirs, files };
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
  files.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
  return { dirs, files };
}

module.exports = { sniffContainer, probeFile, listVideos, listDirs, CONTAINER_LABEL, UNSUPPORTED_SUB };
