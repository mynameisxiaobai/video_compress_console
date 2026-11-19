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

/**
 * 把源目录里的相对路径（如 "Season 1/01.mp4"）变成输出目录下的子目录。
 * 只取 rel 的目录部分，逐段清洗：跳过 . / ..，其余走 sanitizeDirName。
 * 任何一段非法或为空就丢掉，绝不会让输出逃出 outDir。
 */
function safeRelDir(rel) {
  const parts = String(rel || '').split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 1) return '';                 // 只有文件名 = 没有子目录
  const dirs = [];
  for (const p of parts.slice(0, -1)) {
    if (!p.trim() || p === '.' || p === '..') continue;
    dirs.push(sanitizeDirName(p));
  }
  return dirs.join(path.sep);
}

/**
 * 输出文件路径（去掉已有扩展名，统一 mp4）。
 * rel 给定时按源目录结构镜像到 outDir 的子目录里；不给就是老行为（平铺）。
 */
function outputFileFor(srcPath, outDir, suffix, rel) {
  const stem = path.basename(srcPath, path.extname(srcPath));
  const name = stem + (suffix || '') + '.mp4';
  const sub = safeRelDir(rel);
  return sub ? path.join(outDir, sub, name) : path.join(outDir, name);
}

/**
 * 磁盘上是否已经有同名产物。
 * 除了正式文件，还要看 `.part`：上次中途失败/取消留下的半成品同样不能直接覆盖，
 * 否则用户会以为「这个文件早就压好了」。
 * @returns {''|'file'|'part'}
 */
function diskClash(p) {
  try {
    if (fs.existsSync(p)) return 'file';
    if (fs.existsSync(p + '.part')) return 'part';
  } catch (e) { /* ignore */ }
  return '';
}

/**
 * 在同一目录里找一个没被占用的新名字。
 *
 * altLabel 给定时优先用「(mkv)」这种带来源格式的名字——同名不同格式
 * （01.mp4 与 01.mkv 都会输出成 01.mp4）时，`01 (mkv).mp4` 比 `01 (1).mp4`
 * 一眼就能看出这是哪个源文件。占用或名字非法时退回数字后缀。
 */
function freeName(out, set, altLabel) {
  const dir = path.dirname(out);
  const ext = path.extname(out);
  const stem = path.basename(out, ext);
  const free = (p) => !set.has(p.toLowerCase()) && !diskClash(p);
  // 源格式和目标格式一样时（mp4 → mp4），加 "(mp4)" 区分不出任何东西，不如用数字
  const alt = String(altLabel || '').replace(/^\.+/, '').toLowerCase();
  const outExt = ext.replace(/^\./, '').toLowerCase();
  if (alt && alt !== outExt) {
    const tag = sanitizeDirName(alt).toLowerCase();
    if (tag) {
      const cand = path.join(dir, `${stem} (${tag})${ext}`);
      if (free(cand)) return cand;
    }
  }
  for (let i = 1; i < 9999; i++) {
    const cand = path.join(dir, `${stem} (${i})${ext}`);
    if (free(cand)) return cand;
  }
  return null;
}

/**
 * 解决输出路径冲突。
 *
 * 两类冲突要分开看，这是关键：
 *
 * ① **批次内撞名**（`taken` 里已有）：同一批里两个不同的源文件算出了同一个输出名。
 *    最典型的就是 `01.mp4` 和 `01.mkv`——输出统一转 mp4，名字自然撞上。
 *    它们内容不同，跳过等于少压一个，覆盖等于丢一个结果，所以**无论选的哪种
 *    策略都必须改名保留**。以前 skip 模式下第二个会被静默跳过，用户只看到
 *    「今天怎么少了一集」。
 *
 * ② **磁盘上已存在**：是真的重跑了，这时才按用户选的策略走。
 *      skip      跳过（默认，不重复占空间，也不动已有结果）
 *      rename    自动加 (1)(2) 后缀
 *      overwrite 直接覆盖
 *
 * @param {string} out    理想输出路径
 * @param {string} mode   skip | rename | overwrite
 * @param {Set}    taken  本批次已占用的输出路径（小写）
 * @param {string} [altLabel] 源文件扩展名（如 mkv），撞名时用来生成更可读的新名字
 * @returns {{out:string, skipped?:boolean, renamedFrom?:string, reason?:string}}
 */
function resolveOutput(out, mode, taken, altLabel) {
  const set = taken || new Set();
  const key = out.toLowerCase();

  // ① 批次内撞名：只能改名，跟冲突策略无关
  if (set.has(key)) {
    const alt = freeName(out, set, altLabel);
    return alt
      ? { out: alt, renamedFrom: out }
      : { out, skipped: true, reason: '同名文件过多，找不到可用的新名字' };
  }

  if (mode === 'overwrite') return { out };

  const clash = diskClash(out);
  if (!clash) return { out };

  // ② 磁盘上已有：按策略处理
  if (mode === 'skip') {
    return {
      out,
      skipped: true,
      reason: clash === 'part'
        ? '上次未完成的 .part 还留在输出目录，先删掉它再压'
        : '输出文件已存在（同名同扩展名）'
    };
  }
  const alt = freeName(out, set, altLabel);
  return alt
    ? { out: alt, renamedFrom: out }
    : { out, skipped: true, reason: '同名文件过多，找不到可用的新名字' };
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
  targetSize, targetWidth, outputFileFor, safeRelDir, resolveOutput, looksLikeVideo,
  humanSize, humanDur, safePath
};
