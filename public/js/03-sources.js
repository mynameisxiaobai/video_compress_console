/* =============================================================
   03-sources · 输出目录、扫描与文件清单
   输出目录推导、doScan/loadPaths、批次累积、清空与撤销、文件列表渲染与选择
   -------------------------------------------------------------
   拆自原单文件 index.html。各文件按编号顺序用普通 <script> 加载，
   共享同一个全局词法作用域（不是 ES module，无需构建、可直接双击打开）。
   ============================================================= */
'use strict';

/* ---------- 输出目录推导 ---------- */
/**
 * 手输/粘贴的路径统一成 Windows 反斜杠（粘 E:/a/b 很常见）。
 * 盘符根要保留尾随反斜杠——单写 "E:" 在 Windows 上表示「E 盘的当前目录」，不是根目录。
 */
function normOutDir(p){
  let s = String(p || '').trim().replace(/\//g, '\\');
  if (/^[a-zA-Z]:$/.test(s)) return s + '\\';
  return s.replace(/\\+$/, '');
}
/**
 * 两种模式：
 *   默认     → <outputRoot>\<源文件夹名>        （例如 E:\压缩完成\ok）
 *   同级模式 → <源文件夹的父目录>\<源文件夹名>_压缩（例如 E:\PikPak\下载4P5\ok_压缩）
 * 没载入源目录时一律回落到 outputRoot。
 */
function deriveOut(){
  syncOutMode();                                        // 所有改 srcDir 的路径都会走到这里，顺带同步一次
  // 统一成反斜杠：粘贴进来的路径常是 /，混着用会让盘符判断（slice(0,3)）和资源管理器都别扭
  const raw = $('#srcDir').value.trim().replace(/[\\/]+$/,'').replace(/\//g,'\\');
  const root = ((ST.status && ST.status.config && ST.status.config.outputRoot) || 'E:\\压缩完成')
    .replace(/[\\/]+$/,'');
  const isDriveRoot = /^[A-Za-z]:$/.test(raw);          // E: 这种根目录没有「同级」可言
  const leaf = isDriveRoot ? ''
    : String(raw.split(/[\\/]/).pop() || '').trim().replace(/[\\/:*?"<>|]/g,'_');
  if (!leaf) return root;

  if (ST.beside){
    const parent = raw.replace(/[\\/][^\\/]*$/,'');
    if (parent && parent !== raw) return parent + '\\' + leaf + '_压缩';
    return root + '\\' + leaf + '_压缩';                 // 父目录解析不出来时的兜底
  }
  return root + '\\' + leaf;
}

/* 没有源目录时「同级」无从谈起，直接禁用，避免勾了却没反应 */
function syncOutMode(){
  $('#outBeside').disabled = !$('#srcDir').value.trim();
}

/* ---------- 扫描 / 载入 ---------- */
async function doScan(silent, recursive){
  const dir = $('#srcDir').value.trim();
  if (!dir){ flash($('#srcMsg'),'err','请先选择或填写文件夹路径'); return; }
  if (!silent) flash($('#srcMsg'),'', '正在读取 ' + esc(dir.length>46?dir.slice(0,46)+'…':dir) + ' …');
  const r = await post('/api/probe', { dir, recursive: !!recursive });
  if (r.error){ flash($('#srcMsg'),'err','扫描失败：' + esc(r.error)); return; }
  applyFiles(r.files || [], r);
  persist({ sourceDir: dir });
}

async function loadPaths(paths){
  const dir = paths[0].replace(/[\\/][^\\/]*$/, '');
  $('#srcDir').value = dir;
  if (!ST.outDirty) $('#outDir').value = deriveOut();
  flash($('#srcMsg'),'', '正在读取 ' + paths.length + ' 个文件…');
  const r = await post('/api/probe', { files: paths });
  if (r.error){ flash($('#srcMsg'),'err','读取失败：' + esc(r.error)); return; }
  applyFiles(r.files || []);
  persist({ sourceDir: dir });
}

/* ---------- 清空 / 撤销 ---------- */
// 「清空」现在是一次整体复位：源文件列表、源目录、输出目录、任务历史。
// 任务历史在服务端也一并丢弃，否则刷新页面又会被 resume() 铺回来。
// 撤销快照因此要连任务一起存，否则撤回来只剩半套状态。
let lastCleared = null;               // { dir, files, sel, out, outManual, beside, jobs, finished, wallSec, filter }
let clearing = false;

function applyFiles(files){
  const append = $('#appendMode').checked && ST.files.length > 0;
  if (append){
    // 追加模式：把新目录的文件并进来，按完整路径去重（同名不同目录要都保留）
    const seen = new Set(ST.files.map(f => String(f.file).toLowerCase()));
    const add = files.filter(f => !seen.has(String(f.file).toLowerCase()));
    ST.files = ST.files.concat(add);
    add.forEach(f => ST.sel.add(f.file));
    ST.appended = add.length;
  } else {
    ST.files = files;
    ST.sel = new Set(files.map(f => f.file));
    ST.appended = 0;
  }
  lastCleared = null;                 // 新载入后旧的撤销快照作废
  if (!ST.outDirty) $('#outDir').value = deriveOut();
  renderFiles();
  renderSrcMsg();
  updateSpec(); updateNeed();
}

async function clearAll(){
  if (clearing) return;
  clearing = true;
  $('#btnClear').disabled = true;
  $('#btnClearJobs').disabled = true;
  try {
    const busy = !!(ST.running && !ST.finished);
    const hadJobs = JOBS.size > 0;
    const nFiles = ST.files.length;

    // 按钮改成常显之后，空状态下的误点会变多。真的什么都没得清时只回一句提示，
    // 免得把撤销快照覆盖成一堆空值、把刚出现的提示冲掉。
    if (!nFiles && !hadJobs && !busy && !ST.outDirty && !ST.beside
        && !$('#srcDir').value.trim()){
      flash($('#srcMsg'), '', '当前没有可清空的内容');
      return;
    }

    // 快照写在改动之前。任务里还没落地的行按「已停止」记，
    // 免得撤销回来一排假的「转码中」（那些进程确实已经被杀了）。
    lastCleared = {
      dir: $('#srcDir').value,
      files: ST.files.slice(),
      sel: new Set(ST.sel),
      out: $('#outDir').value,
      outManual: !!ST.outDirty,
      beside: !!ST.beside,
      finished: !!ST.finished,
      wallSec: ST.wallSec || 0,
      filter: ST.filter,
      jobs: Array.from(JOBS.values()).map(j => {
        const c = Object.assign({}, j);
        if (c.phase === 'queued' || c.phase === 'running' || c.phase === 'finalizing'){
          c.phase = 'cancelled';
          c.error = c.error || '已停止';
        }
        return c;
      })
    };

    if (hadJobs || busy){
      dropJobEvents++;
      setTimeout(() => { dropJobEvents = Math.max(0, dropJobEvents - 1); }, 1500);
      try { await post('/api/jobs/clear', {}); } catch(e){ /* 服务没了也照样把界面清干净 */ }
    }

    // ---- 文件列表 + 两个目录 ----
    ST.files = [];
    ST.sel.clear();
    ST.outDirty = false;
    ST.beside = false;
    ST.running = false; ST.finished = false; ST.t0 = 0; ST.wallSec = 0; ST.paused = false;
    $('#srcDir').value = '';
    $('#outBeside').checked = false;
    $('#outDir').value = deriveOut();       // 源目录空了 → 回落到默认输出根
    $('#files').innerHTML = '';
    $('#srcMeta').textContent = '';
    $('#chkAll').checked = false;
    $('#chkAll').indeterminate = false;

    // ---- 任务区 ----
    resetJobsView();
    $('#docket').hidden = true;
    $('#empty').hidden = false;
    paintRunControls(null);

    updateSpec(); updateNeed(); updateSel(); paintHead();

    persist({ sourceDir: '', outDir: '', outManual: false, besideSource: false });

    // 清空不是不可逆的：留一个撤销入口，省掉一个确认弹窗
    const box = $('#srcMsg');
    box.innerHTML = '';
    const d = el('div','line ok');
    const parts = [];
    if (nFiles) parts.push(nFiles + ' 个文件');
    if (lastCleared.jobs.length) parts.push(lastCleared.jobs.length + ' 条任务记录');
    parts.push('源目录与输出目录');
    d.appendChild(el('span', null, '已清空 ' + parts.join(' · ') + '。'));
    const b = el('button','lnk','撤销');
    b.addEventListener('click', undoClear);
    d.appendChild(b);
    box.appendChild(d);
  } finally {
    clearing = false;
    $('#btnClear').disabled = false;
    $('#btnClearJobs').disabled = false;
  }
}

function undoClear(){
  if (!lastCleared) return;
  const snap = lastCleared;
  lastCleared = null;

  $('#srcDir').value = snap.dir;
  ST.files = snap.files;
  ST.sel = snap.sel;
  ST.outDirty = snap.outManual;
  ST.beside = snap.beside;
  $('#outBeside').checked = snap.beside;
  $('#outDir').value = snap.out || deriveOut();
  renderFiles();
  renderSrcMsg();
  updateSpec(); updateNeed();

  persist({
    sourceDir: snap.dir,
    outDir: snap.outManual ? snap.out : '',
    outManual: !!snap.outManual,
    besideSource: snap.beside
  });

  // 任务历史只能恢复到「本次会话可见」——服务端那份已经被清掉了。
  // 共享点全部保留在磁盘上，所以这一批的结果单、"在文件夹中显示" 都还能用。
  if (snap.jobs.length){
    dropJobEvents = 0;              // 撤销要能把这些行写回来
    ST.rehydrating = true;
    snap.jobs.forEach(j => upsert(j));
    ST.rehydrating = false;
    ST.finished = !!snap.finished;
    ST.running = false;
    ST.wallSec = snap.wallSec || 0;
    ST.filter = snap.filter || 'all';
    paintFilters(); applyFilter();
    $('#empty').hidden = true;
    if (snap.finished) showDocket(snap.jobs.some(j => j.phase === 'cancelled') ? 'stopped' : '');
  }
  paintHead(); updateSel();
}

function renderSrcMsg(){
  const n = ST.files.length, box = $('#srcMsg');
  const appended = ST.appended || 0; ST.appended = 0;
  if (!n){ flash(box,'err','这个文件夹里没有找到视频文件'); $('#srcMeta').textContent = ''; return; }
  const total = ST.files.reduce((s,f)=>s+(f.size||0),0);
  const sub = ST.files.filter(f=>f.subtitleOk).length;
  const bad = ST.files.filter(f=>f.error).length;
  const dup = ST.files.filter(f=>f.disguised).length;
  let h = '共 <b>' + n + '</b> 个视频 · <b>' + human(total) + '</b>';
  if (appended) h += ' · 本次追加 <b>' + appended + '</b>';
  if (sub) h += ' · 内挂字幕 <b>' + sub + '</b>';
  flash(box, bad?'warn':'ok', h);
  if (dup) {
    const d = el('div','line warn');
    d.innerHTML = '<span><b>' + dup + ' 个文件扩展名与真实容器不符</b>，已按真实容器处理，不影响结果。</span>';
    box.appendChild(d);
  }
  if (bad) {
    const d = el('div','line err');
    d.innerHTML = '<span><b>' + bad + ' 个文件读取失败</b>，可能已损坏或被占用。</span>';
    box.appendChild(d);
  }
  $('#srcMeta').textContent = n + ' 个 · ' + human(total);
}

function renderFiles(){
  const ul = $('#files'); ul.innerHTML = '';
  const cap = capValue();
  ST.files.forEach(f => {
    const li = el('li','frow' + (ST.sel.has(f.file)?' on':''));
    li.dataset.f = f.file;
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = ST.sel.has(f.file);
    li.appendChild(cb);
    li.appendChild(el('span','fname', (f.rel && f.rel.indexOf('\\') >= 0) ? f.rel : f.name));
    if (f.subtitleOk) li.appendChild(el('span','fsub','字幕'));
    li.appendChild(el('span','fdim', human(f.size)));
    const k = kbpsOf(f, cap);
    if (k && f.duration){
      const bytes = ((k + (parseInt($('#advAB').value,10)||192)) * 1000 / 8) * f.duration;
      li.appendChild(el('span','fout','≈ ' + human(bytes)));
    }
    const tb = el('button','ftry','试压');
    tb.title = '按当前画质参数只压前 15 秒，先看效果再决定要不要整批跑';
    tb.addEventListener('click', e => { e.stopPropagation(); previewFile(f); });
    li.appendChild(tb);
    ul.appendChild(li);
  });
  updateSel();
}

function toggleFile(file, on){
  if (on) ST.sel.add(file); else ST.sel.delete(file);
  const li = $('#files').querySelector('[data-f="' + CSS.escape(file) + '"]');
  if (li){ li.classList.toggle('on', on); const cb = li.querySelector('input'); if (cb) cb.checked = on; }
  updateSel(); updateNeed();
}

function updateSel(){
  const chosen = ST.files.filter(f => ST.sel.has(f.file));
  const bytes = chosen.reduce((s,f)=>s+(f.size||0),0);
  const secs = chosen.reduce((s,f)=>s+(f.duration||0),0);
  // 工具条常显：没有文件时全选/反选置灰，只留「清空」可用
  const hasFiles = ST.files.length > 0;
  $('#selInfo').textContent = chosen.length
    ? '已选 ' + chosen.length + ' / ' + ST.files.length + ' · ' + human(bytes) + ' · ' + spanDur(secs)
    : (hasFiles ? '未选择' : '还没有载入文件');
  const all = $('#chkAll');
  all.disabled = !hasFiles;
  $('#btnInvert').disabled = !hasFiles;
  all.checked = hasFiles && chosen.length === ST.files.length;
  all.indeterminate = chosen.length > 0 && chosen.length < ST.files.length;

  $('#btnStart').disabled = ST.running || !chosen.length;
  if (!ST.running && !ST.finished){
    $('#startHint').textContent = chosen.length
      ? '将按每集的实际分辨率与帧率单独计算码率'
      : '先在第 01 步选好文件';
  }
  $('#btnStart').textContent = ST.finished && chosen.length ? '压缩这一批' : '开始压缩';
}

$('#files').addEventListener('click', e => {
  const li = e.target.closest('.frow'); if (!li) return;
  const f = li.dataset.f;
  if (e.target.matches('input')) { toggleFile(f, e.target.checked); return; }
  toggleFile(f, !ST.sel.has(f));
});
$('#chkAll').addEventListener('change', e => {
  const on = e.target.checked;
  ST.files.forEach(f => { if (on) ST.sel.add(f.file); else ST.sel.delete(f.file); });
  renderFiles(); updateNeed();
});
$('#btnInvert').addEventListener('click', () => {
  ST.files.forEach(f => { if (ST.sel.has(f.file)) ST.sel.delete(f.file); else ST.sel.add(f.file); });
  renderFiles(); updateNeed();
});
$('#btnClear').addEventListener('click', clearAll);
// 队列工具条里也放一个，看任务区时不用回到左栏找按钮。
$('#btnClearJobs').addEventListener('click', clearAll);
$('#btnScan').addEventListener('click', () => doScan());
