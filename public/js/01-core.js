/* =============================================================
   01-core · 全局状态、常量与通用工具
   $ / $$ / el 选择器，ST 全局状态，格式化函数，api/post，flash 提示
   -------------------------------------------------------------
   拆自原单文件 index.html。各文件按编号顺序用普通 <script> 加载，
   共享同一个全局词法作用域（不是 ES module，无需构建、可直接双击打开）。
   ============================================================= */
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => Array.prototype.slice.call(document.querySelectorAll(s));
const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };

/* 码率模型的默认值。真正生效的是 /api/status 下发的那份（lib/bitrate.js），
   这样前后端只有一处定义，不会改一边忘一边。这些只是后端没给时的兜底。 */
let BPP = { small: 0.0300, balanced: 0.0414, high: 0.0524 };
let FPS_DEF = 25, FLOOR_K = 600, CEIL_K = 12000, SRC_RATIO = 0.85, HARD_MIN_K = 150;
const TIER_CAP = { small: 1080, balanced: 1080, high: 1080 };
const TIER_AUDIO = { small:'128k', balanced:'192k', high:'192k' };
const FOLD_DELAY = 1500;

const ST = {
  status:null, files:[], sel:new Set(),
  enc:'nvenc', tier:'balanced',
  running:false, finished:false, t0:0, lastState:null,
  paused:false,                // 队列是否已暂停派发（与 lastState.paused 同步）
  need:0, avail:0, outDirty:false, needTimer:0,
  beside:false,                // 输出到源目录同级（原名_压缩）
  filter:'all'                 // 队列筛选：all / open / done / bad
};
const JOBS = new Map();      // id -> job
const FOLDED = new Set();    // 已折叠的 id
const OPENED = new Set();    // 用户手动展开的 id
const jobsEl = $('#jobs');

/* 只有「终态」的行才可折叠——转码中的行要一直能看到实时速度和码率 */
const CAN_FOLD = j => j.phase === 'done' || j.phase === 'failed' || j.phase === 'cancelled';
const FILTERS = {
  all:  () => true,
  open: j => j.phase === 'queued' || j.phase === 'running' || j.phase === 'finalizing',
  done: j => j.phase === 'done',
  bad:  j => j.phase === 'failed' || j.phase === 'cancelled'
};
const FILTER_EMPTY = {
  all:  '还没有任务',
  open: '没有未完成的任务 —— 这一批都跑完了',
  done: '还没有完成的任务',
  bad:  '没有失败或取消的任务'
};
const isFolded = id => FOLDED.has(id) && !OPENED.has(id);
const inFilter = j => (FILTERS[ST.filter] || FILTERS.all)(j);

/* ---------- 小工具 ---------- */
const gb = b => (Number(b)||0)/1073741824;
const human = b => { const n=Number(b)||0;
  if(n>=1073741824) return (n/1073741824).toFixed(2)+' GB';
  if(n>=1048576) return (n/1048576).toFixed(1)+' MB';
  if(n>=1024) return (n/1024).toFixed(0)+' KB';
  return n+' B'; };
const esc = s => String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// 汇总用：拆出数值与单位，方便数值大、单位小
const num = b => { const n=Number(b)||0;
  if(n>=1073741824) return (n/1073741824).toFixed(2)+'<span class="u">GB</span>';
  if(n>=1048576) return (n/1048576).toFixed(1)+'<span class="u">MB</span>';
  return Math.max(0,n/1024).toFixed(0)+'<span class="u">KB</span>'; };
const dur = s => { const v=Math.max(0,Math.floor(Number(s)||0)), h=Math.floor(v/3600), m=Math.floor(v%3600/60), q=v%60;
  return h>0 ? h+':'+String(m).padStart(2,'0')+':'+String(q).padStart(2,'0') : m+':'+String(q).padStart(2,'0'); };
const spanDur = s => { const v=Math.max(0,Math.round(Number(s)||0));
  if(v>=3600) return Math.floor(v/3600)+' 时 '+Math.round(v%3600/60)+' 分';
  if(v>=60) return Math.floor(v/60)+' 分';
  return v+' 秒'; };

async function api(path, opt){
  const r = await fetch(path, opt);
  const t = await r.text();
  try { return JSON.parse(t); } catch(e){ return { error: t || ('HTTP ' + r.status) }; }
}
const post = (p, body) => api(p, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
// 记住这次的目录与档位，下次打开不用重选
const persist = patch => post('/api/config', patch).catch(() => {});

function flash(node, kind, html){
  // .line 是 flex 容器：裸文本 + <b> 会被拆成多个 flex item，各自收缩换行，
  // 长句子就变成窄条。统一包一层 span，让整段作为一个整体排版。
  const s = String(html == null ? '' : html);
  const body = /^\s*<(span|div|button|p|i|em)\b/i.test(s) ? s : '<span>' + s + '</span>';
  node.innerHTML = '<div class="line ' + (kind || '') + '">' + body + '</div>';
}
