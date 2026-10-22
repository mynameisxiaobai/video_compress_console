'use strict';

/**
 * 把「拖进浏览器的名字」还原成「磁盘上的真实路径」。
 *
 * 浏览器出于安全限制，drop 事件只给出 File / FileSystemEntry，拿不到绝对路径
 * （Electron 才有 file.path）。所以这里反过来做：拿名字在本机常见位置搜一遍。
 *
 * 搜索策略是广度优先 + 时间预算，根目录按「可能性」排序：
 *   1. 上次用过的源目录及其兄弟目录（用户大概率还在原地操作）
 *   2. 用户目录下的 Downloads / Desktop / Videos / Documents
 *   3. 各盘根（最后兜底）
 * 找到一个就继续跑最多 3 秒，凑够几个候选就收手，避免整盘扫描。
 */

const fs = require('fs');
const path = require('path');

/** 这些目录里基本不可能有用户视频，进去只会烧掉时间预算 */
const SKIP_DIRS = new Set([
  'windows', 'winsxs', 'program files', 'program files (x86)', 'programdata',
  '$recycle.bin', 'system volume information', 'recovery', 'perflogs', 'msocache',
  'config.msi', 'appdata', 'node_modules', '.git', '.svn', '.vs', '.idea', '.cache',
  '.npm', '.gradle', '.m2', 'documents and settings', '$windows.~bt', '$windows.~ws',
  'windows.old', '__pycache__', 'site-packages', 'dist-packages'
]);

const VIDEO_EXT = /\.(mp4|mkv|mov|avi|wmv|flv|ts|m2ts|m4v|webm|rmvb|mpg|mpeg|vob|3gp|ogv)$/i;

const MAX_DEPTH = 6;
const MAX_VISIT = 150000;

function driveRoots() {
  const out = [];
  for (let c = 67; c <= 90; c++) {           // C: .. Z:
    const r = String.fromCharCode(c) + ':\\';
    try { if (fs.existsSync(r)) out.push(r); } catch (e) { /* ignore */ }
  }
  return out;
}

function userRoots() {
  const home = process.env.USERPROFILE || ('C:\\Users\\' + (process.env.USERNAME || ''));
  const names = ['Downloads', 'Desktop', 'Videos', 'Movies', 'Documents'];
  const out = [];
  for (const n of names) {
    out.push(path.join(home, n));
    out.push(path.join(home, 'OneDrive', n));
  }
  return out.filter(p => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } });
}

function normName(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

/** 目录里有多少个视频文件。用来给同名候选排序，也用来给用户一个「像不像剧集目录」的提示。 */
function countVideos(dir) {
  try {
    let n = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && VIDEO_EXT.test(e.name)) n++;
    }
    return n;
  } catch (e) { return 0; }
}

/**
 * @param {Array<{name:string, kind:'dir'|'file'}>} items 拖入的条目
 * @param {{hint?:string, budget?:number}} opts hint = 上次的源目录
 * @returns {{matches:Array, scanned:number, ms:number}}
 */
function locate(items, opts) {
  opts = opts || {};
  const t0 = Date.now();

  const targets = [];
  for (const it of (items || [])) {
    if (!it || !it.name) continue;
    const lower = normName(it.name);
    if (!lower) continue;
    if (targets.some(t => t.lower === lower && t.kind === (it.kind === 'dir' ? 'dir' : 'file'))) continue;
    targets.push({ name: String(it.name), lower: lower, kind: it.kind === 'dir' ? 'dir' : 'file' });
  }
  if (!targets.length) return { matches: [], scanned: 0, ms: 0 };

  const budget = Math.max(1500, Math.min(20000, Number(opts.budget) || 7000));
  const deadline = t0 + budget;

  /* ---- 排根 ---- */
  const roots = [];
  const push = r => {
    if (!r) return;
    let abs;
    try { abs = path.resolve(String(r)); } catch (e) { return; }
    if (roots.some(x => x.toLowerCase() === abs.toLowerCase())) return;
    try { if (fs.statSync(abs).isDirectory()) roots.push(abs); } catch (e) { /* 不存在就跳过 */ }
  };

  const hint = String(opts.hint || '').replace(/[\\/]+$/, '');
  if (hint) {
    push(hint);                                   // 上次的目录本身
    try { push(path.dirname(hint)); } catch (e) {}               // 兄弟目录
    try { push(path.dirname(path.dirname(hint))); } catch (e) {}
  }
  userRoots().forEach(push);
  driveRoots().forEach(push);

  /* ---- 广度优先 ---- */
  const found = new Map();       // key: dir 小写 -> 匹配记录
  const seen = new Set();
  const queue = roots.map(r => ({ dir: r, depth: 0 }));
  let visited = 0;

  const noteDir = (dir, videos, depth) => {
    const key = dir.toLowerCase();
    if (found.has(key)) return;
    found.set(key, { dir: dir, kind: 'dir', hits: 0, names: [], videos: videos, depth: depth });
  };
  const noteFiles = (dir, names, videos, depth) => {
    const key = dir.toLowerCase();
    const prev = found.get(key);
    if (prev && prev.kind === 'file' && prev.names.length >= names.length) return;
    found.set(key, { dir: dir, kind: 'file', hits: names.length, names: names, videos: videos, depth: depth });
  };

  while (queue.length) {
    if (visited >= MAX_VISIT) break;
    if (Date.now() > deadline) break;
    // 已经有结果了，再给 1.1 秒找找同名候选就够了，别让用户干等整盘扫描
    if (found.size && Date.now() - t0 > 1100) break;

    const node = queue.shift();
    const dir = node.dir;
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    visited++;

    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { continue; }                      // 权限不足 / 已被删除

    // 统计当前目录里的视频数：既用于给目录候选打分，也能顺手判断是不是剧集目录
    let videos = 0;
    const fileSet = new Set();
    for (const e of ents) {
      if (e.isFile()) {
        fileSet.add(normName(e.name));
        if (VIDEO_EXT.test(e.name)) videos++;
      }
    }

    // 1) 当前目录本身是「被拖入的文件夹」
    const base = normName(path.basename(dir));
    for (const t of targets) {
      if (t.kind === 'dir' && base && base === t.lower) noteDir(dir, videos, node.depth);
    }

    // 2) 当前目录里的子目录就是「被拖入的文件夹」
    //    在这一层就比对，能省掉「必须先进入子目录才知道它叫什么」的大量 readdir，
    //    否则等着被访问到的深路径会把时间预算吃光。
    const dirTargets = targets.filter(t => t.kind === 'dir');
    if (dirTargets.length) {
      for (const e of ents) {
        if (!e.isDirectory()) continue;
        const nm = normName(e.name);
        for (const t of dirTargets) {
          if (nm !== t.lower) continue;
          const abs = path.join(dir, e.name);
          if (!found.has(abs.toLowerCase())) noteDir(abs, countVideos(abs), node.depth + 1);
        }
      }
    }

    // 3) 当前目录里存在「被拖入的视频文件」
    const fileTargets = targets.filter(t => t.kind === 'file');
    if (fileTargets.length) {
      const hitNames = [];
      for (const t of fileTargets) if (fileSet.has(t.lower)) hitNames.push(t.name);
      if (hitNames.length) {
        // 用磁盘上的真实大小写，避免后面拼路径时大小写不一致
        const real = new Map();
        for (const e of ents) if (e.isFile()) real.set(normName(e.name), e.name);
        noteFiles(dir, hitNames.map(n => real.get(normName(n)) || n), videos, node.depth);
      }
    }

    if (node.depth >= MAX_DEPTH) continue;
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const nm = e.name;
      if (!nm || nm.charCodeAt(0) === 46) continue;            // . 开头
      if (SKIP_DIRS.has(normName(nm))) continue;
      if (nm.endsWith('~')) continue;
      queue.push({ dir: path.join(dir, nm), depth: node.depth + 1 });
    }
  }

  const matches = Array.from(found.values());
  matches.sort((a, b) => {
    // 文件命中数多的优先（一次拖多个视频时能唯一确定目录）
    if (b.hits !== a.hits) return b.hits - a.hits;
    // 层级浅的优先（更像顶层目录，不像藏在某个子目录里的同名副本）
    if (a.depth !== b.depth) return a.depth - b.depth;
    // 视频多的优先
    if (b.videos !== a.videos) return b.videos - a.videos;
    return String(a.dir).length - String(b.dir).length;
  });

  return { matches: matches, scanned: visited, ms: Date.now() - t0 };
}

module.exports = { locate, driveRoots, userRoots };
