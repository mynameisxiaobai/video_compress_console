'use strict';

/**
 * 把「拖进浏览器的名字」还原成「磁盘上的真实路径」。
 *
 * 浏览器出于安全限制，drop 事件只给出 File / FileSystemEntry，拿不到绝对路径
 * （Electron 才有 file.path）。所以这里反过来做：拿名字在本机常见位置搜一遍。
 *
 * 旧实现是同步 readdirSync 全盘 BFS，只认目录名一个特征，有三个硬伤：
 *   1. 同步 IO 会把整个 HTTP 服务（含 SSE 进度推送）堵死；
 *   2. 网络盘 / 休眠磁盘上的一次 readdir 能挂几十秒，且没法中断；
 *   3. 只比目录名，几个「Season 1」摆在一起就只能让用户猜。
 *
 * 现在的做法：
 *   - 异步 readdir + 分批并发，事件循环不再阻塞，单个目录 2s 超时直接放弃；
 *   - 匹配用「目录名 + 拖入时读到的子项名」双特征，文件还比对 size；
 *   - 成功过的路径写进 data/dirindex.json，同一个文件夹第二次拖入是毫秒级。
 */

const fs = require('fs');
const fsp = fs.promises;
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

const MAX_DEPTH = 7;
const MAX_VISIT = 60000;
const CONC = 48;                 // 一批并行 readdir 的目录数
const DIR_TIMEOUT = 2000;        // 单个目录 readdir 超时（网络盘 / 休眠磁盘）
const INDEX_MAX = 3000;
const INDEX_FILE = path.join(__dirname, '..', 'data', 'dirindex.json');

/* ------------------------------------------------------------------ *
 * 路径索引：只记「目录名 → 路径」，不存内容。
 * 命中后现场读一次目录验证（几毫秒），换来索引文件只有几百 KB。
 * ------------------------------------------------------------------ */

let index = null;
let saveTimer = null;

function loadIndex() {
  if (index) return index;
  index = { v: 1, dirs: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    if (raw && raw.v === 1 && raw.dirs && typeof raw.dirs === 'object') index = raw;
  } catch (e) { /* 没有索引就是空的，不影响功能 */ }
  return index;
}

function indexPut(dir, dirName) {
  try {
    const idx = loadIndex();
    // path 存原始大小写：索引的 key 是小写（检索用），但返回给用户必须是真实路径
    idx.dirs[dir.toLowerCase()] = { name: normName(dirName), path: dir, at: Date.now() };
    if (!saveTimer) {
      saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
          const dirs = idx.dirs;
          const keys = Object.keys(dirs);
          if (keys.length > INDEX_MAX) {
            keys.sort((a, b) => (dirs[a].at || 0) - (dirs[b].at || 0));
            for (const k of keys.slice(0, keys.length - INDEX_MAX)) delete dirs[k];
          }
          fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
          fs.writeFileSync(INDEX_FILE, JSON.stringify(idx));
        } catch (e) { /* 写不了就算了，下次重扫 */ }
      }, 2500);
      if (saveTimer.unref) saveTimer.unref();
    }
  } catch (e) { /* ignore */ }
}

/** 索引里名字对得上的路径，最多取 40 个去现场验证 */
function indexLookup(targets) {
  const idx = loadIndex();
  const want = new Set(targets.filter(t => t.kind === 'dir').map(t => t.lower));
  if (!want.size) return [];
  const out = [];
  for (const key in idx.dirs) {
    const rec = idx.dirs[key];
    if (!want.has(rec.name)) continue;
    out.push({ key: key, path: rec.path || key });
    if (out.length >= 40) break;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

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

/**
 * 异步 readdir，带超时。
 * 网络盘上 readdir 可能挂很久，Promise.race 让超时的目录直接作废，
 * 底层请求还在内核里排队，但不再占用事件循环，也不影响其它目录继续扫。
 */
async function readDirSafe(dir) {
  let timer = null;
  try {
    const list = await Promise.race([
      fsp.readdir(dir, { withFileTypes: true }),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), DIR_TIMEOUT); })
    ]);
    return list;
  } catch (e) {
    return null;                       // 权限不足 / 已被删除
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * 打分
 * ------------------------------------------------------------------ */

/**
 * 目录匹配度：
 *   名字对上           40 分（没对上直接淘汰）
 *   拖入时读到的子项名   最多 60 分，按命中比例给
 *   一个都没对上        −20 分（同名但内容完全不同的目录，基本可以排除）
 *   目录里的视频数      最多 +8 分
 */
function scoreDir(target, dirName, names, videos) {
  if (!dirName || dirName !== target.lower) return -1;
  let s = 40;
  if (target.children && target.children.length) {
    const set = new Set(names);
    let hit = 0;
    for (const c of target.children) if (set.has(c)) hit++;
    s += Math.round(60 * hit / target.children.length);
    if (hit === 0) s -= 20;
  }
  s += Math.min(8, videos || 0);
  return s;
}

/** 文件匹配度：名字 30 分，size 完全一致再 +40 分 */
function scoreFile(target, hitNames, sizeMap, targetSizes) {
  if (!hitNames.length) return -1;
  let s = 30 * Math.min(2, hitNames.length);
  for (const n of hitNames) {
    const real = targetSizes.get(normName(n));
    const onDisk = sizeMap.get(normName(n));
    if (targetSizes.size && real !== undefined && onDisk !== undefined && real === onDisk) s += 40;
  }
  return s;
}

/** 把一个目录的读目录结果拆成「小写名集合 / 视频数 / 真实名映射」 */
function digest(list) {
  const names = [];
  const lower = new Set();
  const real = new Map();
  let videos = 0;
  for (const e of list) {
    const low = normName(e.name);
    names.push(low);
    lower.add(low);
    real.set(low, e.name);
    if (e.isFile() && VIDEO_EXT.test(e.name)) videos++;
  }
  return { names, lower, real, videos };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function normalize(items) {
  const out = [];
  for (const it of (items || [])) {
    if (!it || !it.name) continue;
    const lower = normName(it.name);
    if (!lower) continue;
    const kind = it.kind === 'dir' ? 'dir' : 'file';
    if (out.some(t => t.lower === lower && t.kind === kind)) continue;
    const children = Array.isArray(it.children)
      ? it.children.map(normName).filter(Boolean).slice(0, 150)
      : null;
    out.push({
      name: String(it.name), lower, kind, children,
      size: Number(it.size) > 0 ? Number(it.size) : 0
    });
  }
  return out;
}

function clamp(n, lo, hi, dflt) {
  const v = Number(n);
  if (!isFinite(v) || v <= 0) return dflt;
  return Math.max(lo, Math.min(hi, v));
}

/** 索引命中：并发验证若干路径，返回分数达标的候选 */
async function fromIndex(targets, t0, deadline) {
  const cands = indexLookup(targets);
  if (!cands.length) return [];
  const out = [];
  for (let i = 0; i < cands.length; i += 16) {
    if (Date.now() > deadline) break;
    const part = cands.slice(i, i + 16);
    const dirs = await Promise.all(part.map(c => readDirSafe(c.path)));
    for (let k = 0; k < part.length; k++) {
      const list = dirs[k];
      const rec = part[k];
      if (!list) {
        // 索引里的路径已经不存在了，顺手清掉，避免越攒越脏
        try { delete loadIndex().dirs[rec.key]; } catch (e) {}
        continue;
      }
      const d = digest(list);
      const dirPath = rec.path;
      const base = normName(path.basename(dirPath));
      for (const t of targets) {
        if (t.kind !== 'dir') continue;
        const sc = scoreDir(t, base, d.names, d.videos);
        if (sc > 0) out.push({ dir: dirPath, kind: 'dir', score: sc, videos: d.videos, depth: 0, hits: 0, from: 'index' });
      }
    }
  }
  return out;
}

function bestScore(found) {
  let best = 0;
  for (const m of found.values()) if (m.score > best) best = m.score;
  return best;
}

/**
 * 是不是已经有「够确定」的答案了。
 * 目录要名字 + 子项都对上（≥80）；文件只要名字命中且 size 一致（≥70）就够了，
 * 因为 size 一致基本排除了同名不同片的可能。
 */
function confident(found) {
  for (const m of found.values()) {
    if (m.kind === 'file' && m.score >= 70) return true;
    if (m.kind === 'dir' && m.score >= 80) return true;
  }
  return false;
}

/** 实时扫描：按 root 分组做个带并发上限的 BFS */
async function scanAll(targets, hint, t0, deadline) {
  const roots = [];
  const push = r => {
    if (!r) return;
    let abs;
    try { abs = path.resolve(String(r)); } catch (e) { return; }
    if (roots.some(x => x.toLowerCase() === abs.toLowerCase())) return;
    try { if (fs.statSync(abs).isDirectory()) roots.push(abs); } catch (e) { /* 不存在就跳过 */ }
  };

  const h = String(hint || '').replace(/[\\/]+$/, '');
  if (h) {
    push(h);                                     // 上次用过的目录本身
    try { push(path.dirname(h)); } catch (e) {}  // 兄弟目录
    try { push(path.dirname(path.dirname(h))); } catch (e) {}
  }
  userRoots().forEach(push);
  driveRoots().forEach(push);
  if (!roots.length) return { matches: [], visited: 0 };

  const dirTargets = targets.filter(t => t.kind === 'dir');
  const fileTargets = targets.filter(t => t.kind === 'file');
  const fileSizes = new Map();
  for (const t of fileTargets) if (t.size) fileSizes.set(t.lower, t.size);

  const found = new Map();      // 小写路径 -> 候选
  const seen = new Set();
  let visited = 0;

  // 每个 root 分配的访问额度：第一个（hint）给得多一些
  const perRoot = Math.max(3000, Math.floor(MAX_VISIT / Math.max(1, roots.length) * 2));

  for (let ri = 0; ri < roots.length; ri++) {
    if (Date.now() > deadline || visited >= MAX_VISIT) break;
    // 第一个 root（上次的目录附近）就给出了很确定的答案，别的盘不用再翻
    if (found.size) {
      if (confident(found)) break;
      if (Date.now() - t0 > 2500) break;
    }

    let level = [{ dir: roots[ri], depth: 0 }];
    let rootVisited = 0;

    while (level.length) {
      if (Date.now() > deadline || visited >= MAX_VISIT || rootVisited >= perRoot) break;
      // 有结果就尽快收手：高分的（名字 + 子项都对上）只再给 0.7s 找同名候选，
      // 低分的多给一点，但也不让「正在定位」无限转下去
      if (found.size) {
        if (confident(found) && Date.now() - t0 > 700) break;
        if (Date.now() - t0 > 1200) break;
      }

      const next = [];
      for (let i = 0; i < level.length; i += CONC) {
        if (Date.now() > deadline || visited >= MAX_VISIT) break;
        const part = level.slice(i, i + CONC);
        const lists = await Promise.all(part.map(n => readDirSafe(n.dir)));
        visited += part.length;
        rootVisited += part.length;

        for (let k = 0; k < part.length; k++) {
          const node = part[k];
          const list = lists[k];
          if (!list) continue;
          const d = digest(list);
          const base = normName(path.basename(node.dir));

          /* 1) 当前目录本身就是被拖入的文件夹 */
          for (const t of dirTargets) {
            const sc = scoreDir(t, base, d.names, d.videos);
            if (sc <= 0) continue;
            const key = node.dir.toLowerCase();
            const prev = found.get(key);
            if (prev && prev.score >= sc) continue;
            found.set(key, {
              dir: node.dir, kind: 'dir', score: sc, videos: d.videos,
              depth: node.depth, hits: 0, from: 'scan'
            });
            indexPut(node.dir, base);
          }

          /* 2) 当前目录里有被拖入的视频文件（名字 + size 双验证） */
          if (fileTargets.length) {
            const hitNames = [];
            for (const t of fileTargets) if (d.real.has(t.lower)) hitNames.push(d.real.get(t.lower));
            if (hitNames.length) {
              const sizeMap = new Map();
              if (fileSizes.size) {
                await Promise.all(hitNames.map(async n => {
                  try {
                    const st = await fsp.stat(path.join(node.dir, n));
                    sizeMap.set(normName(n), st.size);
                  } catch (e) { /* ignore */ }
                }));
              }
              const sc = scoreFile(null, hitNames, sizeMap, fileSizes);
              if (sc > 0) {
                const key = node.dir.toLowerCase();
                const prev = found.get(key);
                if (!prev || prev.score < sc) {
                  found.set(key, {
                    dir: node.dir, kind: 'file', score: sc, videos: d.videos,
                    depth: node.depth, hits: hitNames.length, names: hitNames, from: 'scan'
                  });
                }
              }
            }
          }

          if (node.depth >= MAX_DEPTH) continue;
          for (const e of list) {
            if (!e.isDirectory()) continue;
            const nm = e.name;
            if (!nm || nm.charCodeAt(0) === 46) continue;
            if (SKIP_DIRS.has(normName(nm))) continue;
            if (nm.endsWith('~')) continue;
            const child = path.join(node.dir, nm);
            const lk = child.toLowerCase();
            if (seen.has(lk)) continue;
            seen.add(lk);
            next.push({ dir: child, depth: node.depth + 1 });
          }
        }
      }
      level = next;
    }
  }

  return { matches: Array.from(found.values()), visited };
}

/**
 * @param {Array<{name:string, kind:'dir'|'file', children?:string[], size?:number}>} items
 *        拖入的条目。children 是浏览器在 drop 时同步读到的第一层子项名，用来消歧。
 * @param {{hint?:string, budget?:number}} opts hint = 上次的源目录，budget = 时间预算 ms
 * @returns {Promise<{matches:Array, scanned:number, ms:number, timeout:boolean, source:string}>}
 */
async function locate(items, opts) {
  opts = opts || {};
  const t0 = Date.now();
  const targets = normalize(items);
  if (!targets.length) return { matches: [], scanned: 0, ms: 0, timeout: false, source: 'none' };

  const budget = clamp(opts.budget, 1200, 30000, 4000);
  const deadline = t0 + budget;

  // 先查索引：同一批文件夹第二次拖入基本都能在这里命中
  const indexed = await fromIndex(targets, t0, deadline);
  const bestIndexed = indexed.slice().sort((a, b) => b.score - a.score)[0];
  if (bestIndexed && bestIndexed.score >= 80) {
    return {
      matches: indexed.sort((a, b) => b.score - a.score).slice(0, 8),
      scanned: 0, ms: Date.now() - t0, timeout: false, source: 'index'
    };
  }

  const scan = await scanAll(targets, opts.hint, t0, deadline);

  // 合并去重（同一目录索引和扫描都可能给一次）
  const byDir = new Map();
  for (const m of indexed.concat(scan.matches)) {
    const key = m.dir.toLowerCase();
    const prev = byDir.get(key);
    if (!prev || prev.score < m.score) byDir.set(key, m);
  }

  const all = Array.from(byDir.values()).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.depth !== b.depth) return a.depth - b.depth;
    if (b.hits !== a.hits) return b.hits - a.hits;
    if (b.videos !== a.videos) return b.videos - a.videos;
    return String(a.dir).length - String(b.dir).length;
  });

  const ms = Date.now() - t0;
  return {
    matches: all.slice(0, 8),
    scanned: scan.visited,
    ms,
    // 到点了还没找到 → 前端据此提示「换个办法」，而不是假装搜完了
    timeout: !all.length && Date.now() >= deadline,
    source: indexed.length ? 'index+scan' : 'scan'
  };
}

/** 测试用：清掉内存索引，强制重新读盘 */
function resetIndex() {
  index = null;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
}

module.exports = { locate, driveRoots, userRoots, resetIndex, INDEX_FILE };
