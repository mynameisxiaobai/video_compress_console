'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const H = require('./lib/http');
const FFmpeg = require('./lib/ffmpeg');
const Probe = require('./lib/probe');
const Disk = require('./lib/disk');
const Paths = require('./lib/paths');
const Bitrate = require('./lib/bitrate');
const TaskManager = require('./lib/tasks');
const Pick = require('./lib/pick');
const Locate = require('./lib/locate');
const Store = require('./lib/store');
const Log = require('./lib/log');

const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, 'config.json');
// 默认值必须是中性的：这个项目要开源，别把本机的真实目录名写进来
const HOME = process.env.USERPROFILE || 'C:\\Users\\Public';
const DEFAULT_SRC = path.join(HOME, 'Videos');
const DEFAULT_OUT = path.join(HOME, 'Videos', '压缩完成');
const CONFLICT_MODES = ['skip', 'rename', 'overwrite'];

// ---------- 配置 ----------
const defaultConfig = () => ({
  // 留空 = 自动查找：程序目录自带的 ffmpeg\ → C:\ffmpeg\bin → PATH。
  // 便携版就是靠这个，不写死任何本机路径。
  ffmpegPath: '',
  ffprobePath: null,
  port: 8787,
  sourceDir: DEFAULT_SRC,
  outputRoot: DEFAULT_OUT,
  // 上次的输出目录。outManual 为 true 表示这是用户手选/手输的，刷新时优先用它，
  // 不要被 deriveOut() 按源目录重新算出来的值冲掉。
  outDir: '',
  outManual: false,
  encoder: 'nvenc',
  // 分辨率「上限」：按短边判断，只降不升。0 = 不缩放。targetH 保留兼容旧配置。
  maxShortSide: 1080,
  targetH: 1080,
  // 码率：auto = 按 像素×帧率×bpp 逐文件计算；fixed = 用 videoBitrate 固定值
  rateMode: 'auto',
  qualityTier: 'balanced',
  aqStrength: 8,
  rcLookahead: 0,
  bref: false,
  videoBitrate: '2213k',
  audioBitrate: '192k',
  nvencPreset: 'p6',
  x265Preset: 'medium',
  keepSubtitle: true,
  vbv: true,
  faststart: false,
  multipass: true,
  concurrency: 2,
  suffix: '',
  // 输出已存在同名文件时怎么办：skip 跳过 / rename 自动加 (1) / overwrite 覆盖。
  // 默认 skip：重跑同一批不会重复占空间，也不会把已有结果悄悄删掉。
  onConflict: 'skip',
  // 一批跑完发系统通知 / 响提示音
  notifyOnDone: true,
  soundOnDone: false
});

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const cfg = Object.assign(defaultConfig(), JSON.parse(raw));
    // 手改配置时容易把路径清空，空的 outputRoot 会让输出目录变成「当前目录」，这里兜一下
    if (typeof cfg.outputRoot !== 'string' || !cfg.outputRoot.trim()) cfg.outputRoot = DEFAULT_OUT;
    if (typeof cfg.ffmpegPath !== 'string') cfg.ffmpegPath = '';
    return cfg;
  } catch (e) {
    const cfg = defaultConfig();
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8'); } catch (e2) {}
    return cfg;
  }
}
function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8'); return true; }
  catch (e) { return false; }
}
let CFG = loadConfig();

// ---------- SSE 客户端 ----------
const sseClients = new Set();
function broadcast(event, data) {
  for (const send of Array.from(sseClients)) {
    if (!send(event, data)) sseClients.delete(send);
  }
}

// ---------- 任务管理器 ----------
const TM = new TaskManager();
const resolved = FFmpeg.resolve(CFG);
TM.configure({ ffmpegExe: resolved.ffmpeg, emit: broadcast });
// 任务落终态就落盘；启动时把历史读回来，服务重启也不会丢上次压了什么
TM.setOnEnd(job => {
  Store.record(job);
  const tag = job.phase === 'done' ? (job.skipped ? '跳过' : '完成') : job.phase;
  Log.info('任务' + tag + ' ' + job.name + ' → ' + job.out +
    (job.error ? ' | ' + String(job.error).slice(0, 300) : ''));
});
const RESTORED = TM.restore(Store.load());
// 磁盘看卫必须盯「本批实际要写入的目录」，不是配置里的 outputRoot。
// 同级输出 / 手选输出目录都可能落在别的盘，盯错盘等于没盯。
TM.setDiskGuard((outDir) => {
  const base = outDir || CFG.outputRoot;
  if (!base) return null;
  const info = Disk.driveInfo(Paths.safePath(base));
  if (!info.ok) return null;
  // 必须返回 { enough } 结构；低于 2GB 时 pump() 会暂停派发新任务
  const LOW = 2 * 1024 * 1024 * 1024;
  return { enough: info.avail > LOW, avail: info.avail, total: info.total, root: info.root };
});

// ---------- 路由 ----------
const routes = [
  { method: 'GET', exact: true, path: '/', handler: handleIndex },
  { method: 'GET', exact: true, path: '/index.html', handler: handleIndex },
  { method: 'GET', exact: true, path: '/api/status', handler: handleStatus },
  { method: 'POST', exact: true, path: '/api/config', handler: handleConfig },
  { method: 'GET', exact: true, path: '/api/drives', handler: handleDrives },
  { method: 'GET', exact: true, path: '/api/browse', handler: handleBrowse },
  { method: 'POST', exact: true, path: '/api/pick', handler: handlePick },
  { method: 'POST', exact: true, path: '/api/locate', handler: handleLocate },
  { method: 'POST', exact: true, path: '/api/probe', handler: handleProbePost },
  { method: 'POST', exact: true, path: '/api/jobs', handler: handleJobsCreate },
  { method: 'GET', exact: true, path: '/api/jobs', handler: handleJobsGet },
  { method: 'POST', exact: true, path: '/api/jobs/pause', handler: handleJobsPause },
  { method: 'POST', exact: true, path: '/api/jobs/stop', handler: handleJobsStop },
  { method: 'POST', exact: true, path: '/api/jobs/clear', handler: handleJobsClear },
  { method: 'POST', exact: true, path: '/api/resume', handler: handleResume },
  { method: 'POST', exact: true, path: '/api/jobs/resume', handler: handleResume },
  { method: 'POST', regex: /^\/api\/jobs\/([^/]+)\/cancel$/, handler: handleCancel },
  { method: 'GET', exact: true, path: '/api/events', handler: handleEvents },
  { method: 'POST', exact: true, path: '/api/open', handler: handleOpen },
  { method: 'GET', exact: true, path: '/api/log', handler: handleLog },
  { method: 'GET', exact: true, path: '/api/logfile', handler: handleLogFile },
  // 前端已拆成多个文件：public/style.css + public/js/*.js
  // 只放行这两类白名单路径，其它一律 404，不给任意文件读取的口子
  { method: 'GET', regex: /^\/(?:style\.css|js\/[A-Za-z0-9_-]+\.js)$/, handler: handleStatic }
];
const route = H.createRouter(routes);

function handleIndex(req, res) {
  H.serveFile(res, path.join(ROOT, 'public', 'index.html'));
}

async function handleStatus(req, res) {
  const r = FFmpeg.resolve(CFG);
  const caps = r.ffmpeg ? await FFmpeg.capabilities(r.ffmpeg) : {};
  const ver = r.ffmpeg ? await FFmpeg.version(r.ffmpeg) : { ok: false };
  return H.json(res, {
    config: CFG,
    ffmpeg: r.ffmpeg,
    ffprobe: r.ffprobe,
    version: ver.raw || null,
    versionShort: ver.ver || null,
    caps,
    drives: Disk.listDrives(),
    // 码率模型只在后端定义一份，前端拿这份用，免得两边硬编码漂移
    bitrate: {
      bpp: Bitrate.BPP_TIERS,
      fpsFallback: Bitrate.FPS_FALLBACK,
      fpsMax: Bitrate.FPS_MAX,
      floorKbps: Bitrate.FLOOR_KBPS,
      ceilKbps: Bitrate.CEIL_KBPS,
      hardMinKbps: Bitrate.HARD_MIN_KBPS,
      srcRatio: Bitrate.SRC_RATIO,
      defaultKbps: Bitrate.DEFAULT_KBPS
    },
    restored: RESTORED,
    sourceDefaultExists: fs.existsSync(CFG.sourceDir || '')
  });
}

async function handleConfig(req, res) {
  try {
    const body = JSON.parse((await H.readBody(req)).toString('utf8') || '{}');
    CFG = Object.assign(CFG, body || {});
    saveConfig(CFG);
    Log.info('配置变更: ' + Object.keys(body || {}).join(','));
    const rr = FFmpeg.resolve(CFG);
    TM.configure({ ffmpegExe: rr.ffmpeg, emit: broadcast, caps: rr.ffmpeg ? await FFmpeg.capabilities(rr.ffmpeg) : {} });
    return H.json(res, { ok: true, config: CFG, ffmpeg: rr.ffmpeg, ffprobe: rr.ffprobe, caps: rr.ffmpeg ? await FFmpeg.capabilities(rr.ffmpeg) : {} });
  } catch (e) {
    return H.json(res, { ok: false, error: e.message }, 400);
  }
}

function handleDrives(req, res) {
  return H.json(res, { drives: Disk.listDrives(), outputRoot: CFG.outputRoot });
}

function handleBrowse(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  let p = u.searchParams.get('path') || '';
  if (!p) {
    return H.json(res, { roots: Disk.listDrives().map(d => d.root), path: '', dirs: [], files: [] });
  }
  const abs = Paths.safePath(p);
  const r = Probe.listDirs(abs);
  if (r.error) return H.json(res, { error: r.error, path: abs, dirs: [], files: [] }, 200);
  return H.json(res, { path: abs, parent: path.dirname(abs), dirs: r.dirs, files: r.files });
}

/**
 * 打开 Windows 原生选择框（文件多选 / 文件夹）。
 * 这是一个长请求：用户关掉窗口前不会返回，所以响应要等 pick() 结束。
 */
async function handlePick(req, res) {
  let body = {};
  try { body = JSON.parse((await H.readBody(req)).toString('utf8') || '{}'); } catch (e) { /* ignore */ }
  const mode = body.mode === 'folder' ? 'folder' : 'file';
  const initialDir = String(body.initialDir || '');
  const purpose = body.purpose === 'out' ? 'out' : 'src';

  const pending = Pick.pick({ mode, initialDir, purpose });
  let settled = false;
  // 页面刷新/关闭时立刻收掉对话框，别让锁卡住。
  // 注意：body 读完后 req 自己就会 emit 'close'（流 autoDestroy），那时监听还没挂上，
  // 所以这里必须监听 socket / res，而不是 req。
  const abort = () => { if (!settled) pending.cancel(); };
  res.on('close', abort);
  if (req.socket) req.socket.on('close', abort);

  const r = await pending;
  settled = true;
  if (res.writableEnded || res.destroyed) return;
  return H.json(res, r);
}

/**
 * 拖拽载入：浏览器只给名字，这里在本机把它搜回真实路径。
 * 响应故意做得很轻：只回候选目录，路径与文件清单交给 /api/probe 去读。
 */
async function handleLocate(req, res) {
  try {
    const body = JSON.parse((await H.readBody(req)).toString('utf8') || '{}');
    const items = Array.isArray(body.items) ? body.items.slice(0, 300) : [];
    if (!items.length) return H.json(res, { ok: false, error: '没有收到拖入的内容', matches: [] }, 400);

    const hint = String(body.hint || CFG.sourceDir || '');
    const r = Locate.locate(items, { hint: hint, budget: 6000 });

    const matches = r.matches.slice(0, 6).map(m => ({
      dir: m.dir,
      kind: m.kind,
      hits: m.hits,
      names: m.names,
      videos: m.videos
    }));
    return H.json(res, {
      ok: matches.length > 0,
      matches: matches,
      scanned: r.scanned,
      ms: r.ms
    });
  } catch (e) {
    return H.json(res, { ok: false, error: e.message, matches: [] }, 400);
  }
}

async function handleProbePost(req, res) {
  try {
    const body = JSON.parse((await H.readBody(req)).toString('utf8') || '{}');
    const dir = body.dir || CFG.sourceDir;
    const want = body.files;
    let list;
    if (Array.isArray(want) && want.length) {
      list = want.map(f => ({ file: f, name: path.basename(f), size: (() => { try { return fs.statSync(f).size; } catch (e) { return 0; } })() }));
    } else {
      const r = Probe.listVideos(Paths.safePath(dir), { recursive: !!body.recursive });
      if (r.error) return H.json(res, { error: r.error, files: [] }, 200);
      list = r.files;
    }
    const rr = FFmpeg.resolve(CFG);
    // probeFile 只认 file 字段，别把递归扫描带出来的相对路径弄丢
    const relOf = new Map();
    for (const f of list) if (f.rel) relOf.set(f.file, f.rel);
    // ffprobe 并发限制在 4 路，避免一次扫 30 个文件时进程风暴
    const out = [];
    const workers = [];
    const CONC = 4;
    for (let i = 0; i < CONC; i++) {
      workers.push((async () => {
        while (list.length) {
          const f = list.shift();
          if (!f) break;
          out.push(await Probe.probeFile(rr.ffprobe, f.file));
        }
      })());
    }
    await Promise.all(workers);
    for (const f of out) { const r = relOf.get(f.file); if (r) f.rel = r; }
    // 保持按文件名排序（子目录里的按相对路径排，才能和剧集顺序对上）
    out.sort((a, b) => String(a.rel || a.name).localeCompare(String(b.rel || b.name), 'zh-Hans-CN', { numeric: true }));
    const disguised = out.filter(f => f.disguised).length;
    return H.json(res, { dir: Paths.safePath(dir), files: out, disguised, total: out.length });
  } catch (e) {
    return H.json(res, { error: e.message, files: [] }, 400);
  }
}

async function handleJobsCreate(req, res) {
  try {
    const body = JSON.parse((await H.readBody(req)).toString('utf8') || '{}');
    const files = body.files || [];
    if (!files.length) return H.json(res, { error: '没有选中文件' }, 400);
    const rr = FFmpeg.resolve(CFG);
    if (!rr.ffmpeg) return H.json(res, { error: '找不到 ffmpeg.exe，请在设置里指定路径' }, 400);
    const caps = await FFmpeg.capabilities(rr.ffmpeg);
    TM.configure({ ffmpegExe: rr.ffmpeg, emit: broadcast, caps });

    // 输出目录（源目录名清洗：前导空格、非法字符）
    const srcDir = path.dirname(files[0].file);
    let outDir = body.outDir;
    if (!outDir) {
      const cleanRoot = Paths.safePath(CFG.outputRoot || DEFAULT_OUT);
      outDir = Paths.ensureOutputDir(cleanRoot, srcDir);
    } else {
      outDir = Paths.safePath(outDir);
      try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { return H.json(res, { error: '无法创建输出目录: ' + e.message }, 400); }
    }

    // 0 是合法值（不缩放），不能用 || 兜底，否则会被默认 1080 覆盖
    const capRaw = body.maxShortSide !== undefined
      ? body.maxShortSide
      : (body.targetH !== undefined ? body.targetH : CFG.maxShortSide);
    const maxShortSide = Math.max(0, Math.floor(Number(capRaw) || 0));

    const TIERS = ['small', 'balanced', 'high'];
    const opts = {
      outDir,
      encoder: body.encoder || CFG.encoder || 'nvenc',
      maxShortSide,
      targetH: maxShortSide,                 // 兼容旧字段
      rateMode: body.rateMode === 'fixed' ? 'fixed' : 'auto',
      qualityTier: TIERS.indexOf(body.qualityTier) >= 0
        ? body.qualityTier
        : (TIERS.indexOf(CFG.qualityTier) >= 0 ? CFG.qualityTier : 'balanced'),
      videoBitrate: body.videoBitrate || CFG.videoBitrate || '2213k',
      audioBitrate: body.audioBitrate || CFG.audioBitrate || '192k',
      nvencPreset: body.nvencPreset || CFG.nvencPreset || 'p6',
      x265Preset: body.x265Preset || CFG.x265Preset || 'medium',
      keepSubtitle: body.keepSubtitle !== undefined ? !!body.keepSubtitle : !!CFG.keepSubtitle,
      vbv: body.vbv !== undefined ? !!body.vbv : !!CFG.vbv,
      faststart: body.faststart !== undefined ? !!body.faststart : !!CFG.faststart,
      multipass: body.multipass !== undefined ? body.multipass : CFG.multipass,
      aqStrength: Number(body.aqStrength) || Number(CFG.aqStrength) || 8,
      rcLookahead: Number(body.rcLookahead !== undefined ? body.rcLookahead : CFG.rcLookahead) || 0,
      bref: body.bref !== undefined ? !!body.bref : !!CFG.bref,
      concurrency: Number(body.concurrency || CFG.concurrency || 2),
      suffix: body.suffix || '',
      onConflict: CONFLICT_MODES.indexOf(body.onConflict) >= 0 ? body.onConflict
        : (CONFLICT_MODES.indexOf(CFG.onConflict) >= 0 ? CFG.onConflict : 'skip')
    };
    // x265 默认串行，NVENC 默认 2（该卡双 NVENC）
    if (opts.encoder === 'x265' && (body.concurrency == null)) opts.concurrency = Math.min(opts.concurrency, 2);

    // 试压：同一套参数，只截前 N 秒，输出名加 _试压
    const preview = !!body.preview;
    const limitSec = preview ? Math.max(3, Math.min(120, Number(body.previewSec) || 15)) : 0;
    if (preview){
      opts.preview = true;
      opts.limitSec = limitSec;
      opts.suffix = (opts.suffix || '') + '_试压';
    }

    // 先把输出路径全部定下来：同名策略、批次内重名都在这里一次算清楚。
    // 以前重名靠 createJobs 里的 continue 静默丢弃，用户不知道少压了一集。
    const taken = new Set();
    const prepared = [];
    let skipped = 0, renamed = 0;
    for (const f of files) {
      const base = Paths.outputFileFor(f.file, outDir, opts.suffix || '');
      const r = Paths.resolveOutput(base, opts.onConflict, taken);
      if (r.skipped) skipped++;
      else {
        taken.add(r.out.toLowerCase());
        if (r.renamedFrom) renamed++;
      }
      prepared.push(Object.assign({}, f, {
        out: r.out, skipped: !!r.skipped,
        renamedFrom: r.renamedFrom || null, reason: r.reason || null
      }));
    }

    // 磁盘预检：每个文件的分辨率/帧率不同，目标码率也不同，必须逐文件累加。
    // 会被跳过的文件不占空间，这里直接排除。
    const ab = parseInt(String(opts.audioBitrate), 10) || 192;
    let need = 0;
    for (const f of prepared) {
      if (f.skipped) continue;
      const p = Bitrate.planFile({
        width: f.video && f.video.width,
        height: f.video && f.video.height,
        fps: f.video && f.video.fps,
        srcKbps: Bitrate.srcKbpsOf(f),
        capShort: opts.maxShortSide,
        rateMode: opts.rateMode,
        fixedKbps: opts.videoBitrate,
        tier: opts.qualityTier
      });
      // 试压只压前 N 秒，预估体积也要按截断后的时长算
      const estSec = limitSec ? Math.min(f.duration || limitSec, limitSec) : f.duration;
      need += Bitrate.estimateBytes(p.kbps, ab, estSec);
    }
    const space = Disk.checkSpace(outDir, need, 0.85);
    if (!space.enough) {
      return H.json(res, {
        error: '磁盘空间不足',
        need: need, avail: space.avail, permit: space.permit, root: space.root
      }, 400);
    }

    const jobs = body.append ? TM.addJobs(prepared, opts) : TM.createJobs(prepared, opts);
    Log.info((body.append ? '追加任务' : '开批') + ' ' + prepared.length + ' 个文件 → ' + outDir +
      ' | 策略=' + opts.onConflict + ' 跳过=' + skipped + ' 改名=' + renamed +
      (preview ? ' | 试压 ' + limitSec + 's' : ''));
    // 记住策略，下次开批不用重新选
    if (body.onConflict && CFG.onConflict !== opts.onConflict) {
      CFG.onConflict = opts.onConflict;
      saveConfig(CFG);
    }
    setTimeout(() => TM.pump(), 60);
    return H.json(res, {
      ok: true, outDir, need, space, preview, limitSec,
      onConflict: opts.onConflict, skipped, renamed,
      jobs: jobs.map(j => TM.dump(j))
    });
  } catch (e) {
    return H.json(res, { error: e.message }, 400);
  }
}

function handleJobsGet(req, res) {
  return H.json(res, TM.snapshot());
}

async function handleCancel(req, res, params) {
  const id = decodeURIComponent(params[0]);
  return H.json(res, { ok: TM.cancel(id) });
}

function handleResume(req, res) {
  TM.resume();
  return H.json(res, { ok: true, state: TM.emitState() });
}

function handleJobsPause(req, res) {
  TM.pause('user');
  return H.json(res, { ok: true, state: TM.emitState() });
}

function handleJobsStop(req, res) {
  const n = TM.stopAll();
  return H.json(res, { ok: true, stopped: n, state: TM.emitState() });
}

/**
 * 清空历史：先停掉在跑的，再整体丢弃。
 * 顺序不能反——先 clear 会让 close 回调拿到已出表的 job，
 * .part 文件就没人清理了。
 */
async function handleJobsClear(req, res) {
  let stopped = 0;
  if (TM.activeCount() > 0) stopped = TM.stopAll();
  TM.clear();
  Store.clear();          // 历史也一起丢，否则重启后又冒出来
  TM.emitState();
  return H.json(res, { ok: true, stopped });
}

function handleEvents(req, res) {
  const send = H.sseInit(res);
  sseClients.add(send);
  req.on('close', () => sseClients.delete(send));
  // 立即推送当前快照，便于页面刷新后同步
  try { send('queue.state', TM.emitState()); } catch (e) {}
}

function explorerExe() {
  // explorer 必须用绝对路径：服务进程继承的 PATH 可能被裁剪过
  const root = process.env.SystemRoot || 'C:\\Windows';
  const p = path.join(root, 'explorer.exe');
  return fs.existsSync(p) ? p : 'explorer.exe';
}

/**
 * 弹出一个新的资源管理器窗口。
 *
 * ⚠️ 绝对不要传 windowsHide: true —— Node 会带上 STARTF_USESHOWWINDOW + SW_HIDE，
 * explorer.exe 会照做，把新窗口创建成「不可见」。表现就是接口返回 ok:true、
 * 进程也确实起来了，但桌面上什么都不出现（用户看到的「点了没反应」）。
 * 实测：同一路径不传该参数 → IsWindowVisible=True；传了 → False。
 */
function spawnAndWait(exe, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args, { detached: true, stdio: 'ignore' });
    } catch (e) { return resolve({ ok: false, error: e.message }); }
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    // explorer 会立刻把请求转交给已经常驻的 shell 进程，然后自己退出（退出码通常是 1），
    // 所以只把「启动失败」当错误，不管退出码。
    child.on('exit', () => finish({ ok: true }));
    setTimeout(() => finish({ ok: true }), 1200);
    try { child.unref(); } catch (e) { /* ignore */ }
  });
}

async function handleOpen(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  let dir = u.searchParams.get('dir') || '';
  let file = u.searchParams.get('file') || '';
  // 没有 body 时不要等 readBody，否则请求会一直挂着
  if (Number(req.headers['content-length'] || 0) > 0) {
    try {
      const b = JSON.parse((await H.readBody(req)).toString('utf8') || '{}');
      if (b && b.dir) dir = b.dir;
      if (b && b.file) file = b.file;
    } catch (e) { /* ignore */ }
  }
  // file 模式：在文件夹中定位并选中该文件
  if (file) {
    const abs = Paths.safePath(file);
    if (fs.existsSync(abs)) {
      const r = await spawnAndWait(explorerExe(), ['/select,' + abs]);
      return H.json(res, Object.assign({ dir: path.dirname(abs), target: abs }, r));
    }
    dir = dir || path.dirname(abs);
  }

  const target = Paths.safePath(dir || CFG.outputRoot || '');
  // 目录还不存在时（例如还没开始压缩）先建出来，否则 explorer 会静默失败
  if (!fs.existsSync(target)) {
    try { fs.mkdirSync(target, { recursive: true }); }
    catch (e) { return H.json(res, { ok: false, error: '目录不存在且无法创建：' + target }, 400); }
  }

  let r = await spawnAndWait(explorerExe(), [target]);
  if (!r.ok) {
    // 兜底：shell 的默认「打开」动词，绕开 explorer 命令行解析
    const root = process.env.SystemRoot || 'C:\\Windows';
    const rundll = path.join(root, 'System32', 'rundll32.exe');
    r = await spawnAndWait(fs.existsSync(rundll) ? rundll : 'rundll32.exe',
      ['url.dll,FileProtocolHandler', target]);
  }
  return H.json(res, Object.assign({ dir: target, target }, r));
}

function handleLog(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const id = u.searchParams.get('id');
  const job = TM.jobs.get(id);
  if (!job) return H.text(res, '(无此任务)');
  const rr = FFmpeg.resolve(CFG);
  const lines = [
    '任务: ' + job.name,
    '源  : ' + job.src,
    '输出: ' + job.out,
    '容器: ' + job.container + (job.container === 'matroska' ? '  (扩展名可能是伪装的)' : ''),
    '字幕: ' + (job.keepSubtitle ? '保留 -> mov_text' : (job.subSkipped ? '跳过(位图字幕不可转换)' : '不保留')),
    '规格: ' + (job.scaled
      ? job.srcW + 'x' + job.srcH + ' -> ' + job.targetW + 'x' + job.targetH
      : job.srcW + 'x' + job.srcH + ' (不缩放)') +
      '  / 目标 ' + (job.targetKbps || '?') + 'k' +
      '  / 源 ' + (job.srcKbps ? job.srcKbps + 'k' : '未知') +
      ' @ ' + (job.srcFps || '?') + 'fps',
    'ffmpeg: ' + rr.ffmpeg,
    '',
    '命令:',
    (rr.ffmpeg || 'ffmpeg') + ' ' + (job.args || []).map(a => (/[\s"]/.test(a) ? '"' + a + '"' : a)).join(' ')
  ];
  return H.text(res, lines.join('\n'));
}

function handleLogFile(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const n = Number(u.searchParams.get('lines')) || 500;
  return H.text(res, Log.tail(n));
}

// 静态资源（style.css / js/*.js）。路由正则已经限定形态，
// 这里再做一次 resolve 后的前缀校验，双保险防止目录穿越。
function handleStatic(req, res) {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  const base = path.resolve(ROOT, 'public');
  const abs = path.resolve(base, pathname.replace(/^\/+/, ''));
  if (abs !== base && abs.indexOf(base + path.sep) !== 0) {
    return H.json(res, { error: 'Forbidden' }, 403);
  }
  return H.serveFile(res, abs);
}

// ---------- 启动 ----------
const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; }
  catch (e) { pathname = req.url.split('?')[0]; }

  if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }

  const m = route(req.method, pathname);
  if (!m) {
    return H.json(res, { error: 'Not Found', path: pathname }, 404);
  }
  Promise.resolve(m.handler(req, res, m.params)).catch(err => {
    const msg = err && err.message ? err.message : String(err);
    Log.error('500 ' + pathname + ' | ' + msg);
    if (!res.writableEnded) H.json(res, { error: msg }, 500);
  });
});

function listen(startPort, tries) {
  const port = startPort;
  // 上一次 listen 失败时，注册的 'listening' 回调还挂在 server 上。
  // 不清掉的话，端口顺延成功后这个回调会连同新的一起执行——启动横幅和日志都会打两遍。
  server.removeAllListeners('listening');
  server.removeAllListeners('error');
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries > 0) {
      console.log(`端口 ${port} 被占用，改用 ${port + 1}`);
      setTimeout(() => listen(port + 1, tries - 1), 60);
    } else {
      console.error('启动失败:', e.message);
      process.exit(1);
    }
  });
  server.once('listening', async () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    const rr = FFmpeg.resolve(CFG);
    let caps = {}, ver = { raw: '', ver: null };
    if (rr.ffmpeg) { caps = await FFmpeg.capabilities(rr.ffmpeg); ver = await FFmpeg.version(rr.ffmpeg); }
    console.log('');
    console.log('  ============================================================');
    console.log('   视频压缩控制台已启动');
    console.log('  ============================================================');
    console.log('   访问地址 : ' + url);
    console.log('   ffmpeg   : ' + (rr.ffmpeg || '未找到！'));
    if (rr.ffmpeg) {
      console.log('   版本     : ' + (ver.raw || '?'));
      console.log('   能力     : NVENC=' + (caps.hevc_nvenc ? '可用' : '不可用') +
                  '   x265=' + (caps.libx265 ? '可用' : '不可用'));
    } else {
      // 首次运行最常见的卡点，直接把两条出路写清楚
      console.log('');
      console.log('   [需要 ffmpeg] 还没找到 ffmpeg.exe，页面能打开但压不了。两种办法：');
      console.log('     1) 把 ffmpeg 解压到本目录，让路径长这样：');
      console.log('        ' + path.join(ROOT, 'ffmpeg', 'bin', 'ffmpeg.exe'));
      console.log('        下载：https://www.gyan.dev/ffmpeg/builds/  （选 essentials）');
      console.log('     2) 或在页面左下「程序设置」里填 ffmpeg.exe 的完整路径');
      console.log('');
    }
    console.log('   输出根   : ' + CFG.outputRoot);
    console.log('  ============================================================');
    console.log('');
    Log.info('服务启动 ' + url + ' | ffmpeg=' + (rr.ffmpeg || '未找到') +
      ' | 恢复历史 ' + RESTORED + ' 条');
    // 自动打开浏览器（用 explorer 直接打开 URL，不经过 cmd；同样不能加 windowsHide）
    try { spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).unref(); }
    catch (e) { /* ignore */ }
  });
  server.listen(port, '127.0.0.1');
}

listen(Number(CFG.port) || 8787, 10);
