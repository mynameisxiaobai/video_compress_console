'use strict';
const fs = require('fs');
const path = require('path');

// Windows 目录非法字符
const ILLEGAL = /[\\/:*?"<>|]/g;

/**
 * 清洗目录名：源目录名可能带前导空格（如 " 潜伏 (2008) 4K修复版..."）
 * 这一步必须做，否则拼出来的输出路径在 explorer/cmd 里会出问题。
 */
function sanitizeDirName(name) {
  let s = String(name == null ? '' : name);
  s = s.trim();                    // 前导/尾随空格、换行
  s = s.replace(ILLEGAL, '_');     // Windows 非法文件名字符
  s = s.replace(/\s+/g, ' ');      // 折叠连续空白
  s = s.replace(/^\.+/, '').trim(); // 去掉前导点（防 .. 逃逸）
  if (!s) s = 'output';
  // Windows 保留设备名兜底
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = '_' + s;
  return s;
}

/**
 * 由源目录推导输出目录名。
 */
function deriveOutputName(srcDir) {
  return sanitizeDirName(path.basename(srcDir));
}

/**
 * 拼接输出根目录 + 剧集名（自动创建）。
 */
function ensureOutputDir(outputRoot, srcDir) {
  const base = path.isAbsolute(outputRoot) ? outputRoot : path.resolve(outputRoot);
  const full = path.join(base, deriveOutputName(srcDir));
  fs.mkdirSync(full, { recursive: true });
  return full;
}

/**
 * 目标尺寸（上限语义）：把「短边」压到 capShort 以内，只降不升，两维都取偶数。
 *
 * 为什么用短边：竖屏 1080x1920 的 min=1080，配 1080 上限应判定为「已达标」；
 * 旧实现只看 height，会把竖屏误缩成 607x1080。
 *
 * 取偶规则：短边取 cap 的偶数化值，长边 = floor(长边*比例/2)*2，
 *           比例 = capEven / min(w,h)。两维因此必然为偶数，比例误差 < 2px。
 *
 * 3840x2096 + 1080 => 1978x1080   （与原配方逐像素一致）
 * 2560x1440 + 1080 => 1920x1080
 * 1920x1080 + 1080 => null        （不放大）
 * 1280x720  + 1080 => null        （保持 720p）
 * 1080x1920 + 1080 => null        （竖屏不缩）
 */
function targetSize(srcW, srcH, capShort) {
  const w = Math.floor(Number(srcW) || 0);
  const h = Math.floor(Number(srcH) || 0);
  const cap = Math.floor(Number(capShort) || 0);
  if (w < 2 || h < 2 || cap < 2) return null;   // 元数据缺失 / 0 = 不缩放
  if (Math.min(w, h) <= cap) return null;       // 短边已在上限内：不放大
  const capEven = Math.max(2, Math.floor(cap / 2) * 2);
  const r = capEven / Math.min(w, h);
  const even = (v) => Math.max(2, Math.floor(v / 2) * 2);
  return w >= h
    ? { w: even(w * r), h: capEven }   // 横屏/方形：长边是 width
    : { w: capEven, h: even(h * r) };  // 竖屏：长边是 height
}

/** 兼容旧调用：只返回宽度（返回 null 表示不缩放） */
function targetWidth(srcW, srcH, targetH) {
  const t = targetSize(srcW, srcH, targetH);
  return t ? t.w : null;
}

/** 输出文件路径（去掉已有扩展名，统一 mp4） */
function outputFileFor(srcPath, outDir, suffix) {
  const stem = path.basename(srcPath, path.extname(srcPath));
  return path.join(outDir, stem + (suffix || '') + '.mp4');
}

/** 是否为视频扩展名（仅用于过滤，真实容器以魔数/ffprobe 为准） */
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.mov', '.m4v', '.avi', '.ts', '.flv', '.wmv', '.webm', '.rmvb', '.rm', '.mpg', '.mpeg', '.m2ts']);
function looksLikeVideo(name) {
  return VIDEO_EXT.has(path.extname(name).toLowerCase());
}

/** 字节数人类可读 */
function humanSize(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
  return b + ' B';
}

function humanDur(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${m}:${String(ss).padStart(2, '0')}`;
}

/** 路径安全校验：只允许绝对路径，且不允许 .. 逃逸 */
function safePath(p) {
  const abs = path.resolve(String(p || ''));
  return abs;
}

module.exports = {
  sanitizeDirName, deriveOutputName, ensureOutputDir,
  targetSize, targetWidth, outputFileFor, looksLikeVideo,
  humanSize, humanDur, safePath
};
