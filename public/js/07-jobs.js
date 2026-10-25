/* =============================================================
   07-jobs · 队列渲染
   任务行创建与绘制、折叠、暂停/停止控件、筛选、顶部总览、结果单
   -------------------------------------------------------------
   拆自原单文件 index.html。各文件按编号顺序用普通 <script> 加载，
   共享同一个全局词法作用域（不是 ES module，无需构建、可直接双击打开）。
   ============================================================= */
'use strict';

/* ---------- 任务行 ---------- */
const PHASE = { queued:'排队', running:'转码', finalizing:'整理', done:'完成', failed:'失败', cancelled:'取消' };
const PCLS = { queued:'', running:'run', finalizing:'run', done:'done', failed:'failed', cancelled:'' };

function createRow(id){
  const li = el('li','job');
  li.dataset.id = id;
  const row = el('div','jrow');
  row.appendChild(el('span','jstate','—'));
  row.appendChild(el('span','jname',''));
  row.appendChild(el('span','jsum',''));
  row.appendChild(el('span','jpct','0%'));
  row.appendChild(el('span','jcaret','▾'));
  const det = el('div','jdetail');
  det.appendChild(el('div','jdmeta'));
  det.appendChild(el('div','jdact'));
  li.appendChild(row); li.appendChild(det);
  return li;
}

// 清空/停止的瞬间，SSE 里可能还飞着几条 job.cancelled。
// 让它们只更新「已存在的行」，不要凭空把刚清空的任务又塞回来。
let dropJobEvents = 0;

function upsert(job){
  if (dropJobEvents && !JOBS.has(job.id)) return;
  JOBS.set(job.id, job);
  let li = jobsEl.querySelector('[data-id="' + job.id + '"]');
  if (!li){ li = createRow(job.id); jobsEl.appendChild(li); }
  paint(li, job);
  paintHead();
  // 刷新后恢复的那一批不自动折叠：用户此刻正想看结果，折叠起来反而像"没了"
  if (job.phase === 'done' && !ST.rehydrating && !OPENED.has(job.id) && !FOLDED.has(job.id)){
    setTimeout(() => {
      const j = JOBS.get(job.id);
      if (!j || j.phase !== 'done' || OPENED.has(job.id)) return;
      setFold(job.id, true);
      paintHead();
    }, FOLD_DELAY);
  }
}

function paint(li, j){
  const cls = PCLS[j.phase] || '';
  li.className = 'job ' + cls
    + (isFolded(j.id) ? ' folded' : '')
    + (CAN_FOLD(j) ? '' : ' nofold');
  li.hidden = !inFilter(j);
  li.style.setProperty('--p', (j.phase === 'done' ? 100 : (j.pct || 0)) + '%');

  const st = li.querySelector('.jstate');
  st.className = 'jstate ' + (j.skipped ? 'skip' : cls);
  st.textContent = j.skipped ? '已跳过' : (PHASE[j.phase] || j.phase);

  li.querySelector('.jname').textContent = j.name;

  const sum = li.querySelector('.jsum');
  if (j.skipped){
    sum.textContent = '—';
  } else if (j.phase === 'done' && j.outSize){
    const cut = j.srcSize > 0 ? ((1 - j.outSize / j.srcSize) * 100).toFixed(0) + '%' : '';
    sum.innerHTML = human(j.outSize) + (cut ? ' <em>−' + cut + '</em>' : '');
  } else if (j.phase === 'failed'){
    sum.textContent = '—';
  } else {
    sum.textContent = human(j.srcSize);
  }

  li.querySelector('.jpct').textContent = j.skipped
    ? '—'
    : (j.phase === 'done'
      ? dur(j.elapsedSec || 0)
      : (j.pct || 0).toFixed(j.phase === 'queued' ? 0 : 1) + '%');

  // 明细
  const meta = li.querySelector('.jdmeta'); meta.innerHTML = '';
  const act = li.querySelector('.jdact'); act.innerHTML = '';
  const add = (k, v, isErr) => {
    const s = el('span');
    s.innerHTML = k + ' <b class="' + (isErr ? 'err' : '') + '">' + esc(v) + '</b>';
    meta.appendChild(s);
  };
  if (j.skipped){
    // 跳过是「什么都没做」，规格/码率这些没有意义，只说明原因
    add('说明', j.note || '输出已存在，已跳过');
  } else {
    const dim = (j.targetW && j.targetH) ? j.targetW + '×' + j.targetH : '原尺寸';
    add('规格', dim);
    if (j.targetKbps) add('码率', j.targetKbps + 'k');
    if (j.scaled && j.srcW) add('源', j.srcW + '×' + j.srcH);
    if (j.renamedFrom) add('改名', j.note || '同名文件已自动改名');
  }

  if (j.phase === 'running' || j.phase === 'finalizing'){
    if (j.speed) add('速度', j.speed);
    if (j.bitrate) add('实时', j.bitrate);
    if (j.outSize) add('已写', human(j.outSize));
  } else if (j.phase === 'done'){
    if (j.outSize) add('输出', human(j.outSize));
    if (j.srcSize > 0 && j.outSize) add('压缩率', ((1 - j.outSize/j.srcSize)*100).toFixed(1) + '%');
    if (j.elapsedSec) add('耗时', spanDur(j.elapsedSec));
    if (j.keepSubtitle) add('字幕', '已保留');
    if (j.subSkipped) add('字幕', '位图字幕已跳过');
    if (j.preview) add('类型', '试压片段（前 ' + (j.limitSec || 15) + ' 秒）');
  } else if (j.phase === 'failed'){
    add('原因', j.error || '未知错误', true);
  }

  if (j.phase === 'queued' || j.phase === 'running' || j.phase === 'finalizing'){
    const b = el('button','btn warn','取消');
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      b.disabled = true;
      await post('/api/jobs/' + encodeURIComponent(j.id) + '/cancel', {});
    });
    act.appendChild(b);
  } else if (j.phase === 'done' && !j.skipped){
    const b = el('button','btn tiny','在文件夹中显示');
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      openTarget({ file: j.out, dir: normOutDir($('#outDir').value) }, $('#openMsg'));
    });
    act.appendChild(b);
  }
}

/* ---------- 折叠：手动 + 批量 ---------- */
function setFold(id, fold){
  if (fold){ FOLDED.add(id); OPENED.delete(id); }
  else { OPENED.add(id); FOLDED.delete(id); }
  const n = jobsEl.querySelector('[data-id="' + id + '"]');
  if (n) n.classList.toggle('folded', fold);
}

/* 行点击：展开 / 折叠 */
jobsEl.addEventListener('click', e => {
  const li = e.target.closest('.job'); if (!li) return;
  if (e.target.closest('.jdact')) return;
  const id = li.dataset.id;
  const j = JOBS.get(id); if (!j) return;
  if (!CAN_FOLD(j)) return;              // 转码中的行保持展开，别看一半进度
  setFold(id, !isFolded(id));
  paintHead();
});

/* ---------- 运行控制：暂停 / 停止 ---------- */
let stopArmTimer = 0;

function disarmStop(){
  $("#btnStop").textContent = '停止';
  $("#btnStop").classList.remove('armed');
}

/**
 * 暂停只停派发，不动正在跑的 ffmpeg——Windows 没有安全的子进程挂起手段，
 * 而「别再开新的、手上这几个跑完」也正好是点暂停时想要的。
 */
function paintRunControls(s){
  const st = s || ST.lastState || null;
  if (st && typeof st.paused === 'boolean') ST.paused = st.paused;
  const active = !!(ST.running && !ST.finished);
  const paused = !!ST.paused;

  $('#btnPause').hidden = !active;
  $('#btnStop').hidden = !active;
  $('#runSep').hidden = !active;
  $('#btnPause').textContent = paused ? '继续' : '暂停';
  $('#btnPause').title = paused
    ? '继续派发排队中的任务'
    : '暂停派发新任务，正在转码的会跑完';

  if (!active){
    if (stopArmTimer){ clearTimeout(stopArmTimer); stopArmTimer = 0; }
    disarmStop();
    return;
  }
  if (paused){
    $('#startHint').className = 'hint';
    $('#startHint').textContent = '已暂停派发，正在转码的会跑完';
  } else {
    $('#startHint').className = 'hint';
    $('#startHint').textContent = '转码中，可暂停或停止整批';
  }
}

$('#btnPause').addEventListener('click', async () => {
  const b = $('#btnPause');
  const willPause = !ST.paused;
  b.disabled = true;
  try {
    const r = await post(willPause ? '/api/jobs/pause' : '/api/jobs/resume', {});
    if (r && r.error){ flash($('#srcMsg'),'err','操作失败：' + esc(r.error)); return; }
    if (r && r.state){ ST.lastState = r.state; paintHead(); paintRunControls(r.state); }
  } catch(e){
    flash($('#srcMsg'),'err','操作失败：' + esc(e.message));
  } finally {
    b.disabled = false;
  }
});

// 停止会丢掉进行中的转码，所以做成两次点击确认，4 秒内不点就自动收回
$('#btnStop').addEventListener('click', async () => {
  const b = $('#btnStop');
  if (!stopArmTimer){
    b.textContent = '确认停止？';
    b.classList.add('armed');
    stopArmTimer = setTimeout(() => { stopArmTimer = 0; disarmStop(); }, 4000);
    return;
  }
  clearTimeout(stopArmTimer); stopArmTimer = 0;
  disarmStop();
  b.disabled = true;
  try {
    const r = await post('/api/jobs/stop', {});
    if (r && r.error){ flash($('#srcMsg'),'err','停止失败：' + esc(r.error)); return; }
    // 其余交给 SSE 推过来的 queue.state，避免这里和流里各刷一遍结果单
    if (r && r.state){ ST.lastState = r.state; paintHead(); paintRunControls(r.state); }
  } catch(e){
    flash($('#srcMsg'),'err','停止失败：' + esc(e.message));
  } finally {
    b.disabled = false;
  }
});

/* ---------- 筛选 ---------- */
function paintFilters(){
  const arr = Array.from(JOBS.values());
  const n = {
    all: arr.length,
    open: arr.filter(FILTERS.open).length,
    done: arr.filter(FILTERS.done).length,
    bad: arr.filter(FILTERS.bad).length
  };
  $('#jobbar').hidden = !arr.length;

  $$('#filters .chip').forEach(c => {
    const f = c.dataset.f;
    c.classList.toggle('on', ST.filter === f);
    c.querySelector('b').textContent = n[f];
    // 空的分类直接禁用，避免点进去看到空白；但当前选中的那个永远可点
    c.disabled = n[f] === 0 && ST.filter !== f;
  });

  const foldable = arr.filter(CAN_FOLD);
  const foldedNow = foldable.filter(j => isFolded(j.id)).length;
  $('#btnExpandAll').disabled = foldedNow === 0;
  $('#btnFoldAll').disabled = foldable.length === 0 || foldedNow === foldable.length;
}

function applyFilter(){
  let shown = 0;
  Array.from(JOBS.values()).forEach(j => {
    const li = jobsEl.querySelector('[data-id="' + j.id + '"]');
    if (!li) return;
    const ok = inFilter(j);
    li.hidden = !ok;
    if (ok) shown++;
  });
  const fe = $('#filterEmpty');
  const empty = JOBS.size > 0 && shown === 0;
  fe.hidden = !empty;
  if (empty) fe.textContent = FILTER_EMPTY[ST.filter] || '没有符合条件的任务';
}

$('#filters').addEventListener('click', e => {
  const b = e.target.closest('.chip');
  if (!b || b.disabled || b.dataset.f === ST.filter) return;
  ST.filter = b.dataset.f;
  paintFilters();
  applyFilter();
});

$('#btnExpandAll').addEventListener('click', () => {
  Array.from(JOBS.values()).forEach(j => { if (CAN_FOLD(j)) setFold(j.id, false); });
  paintHead();
});

$('#btnFoldAll').addEventListener('click', () => {
  Array.from(JOBS.values()).forEach(j => { if (CAN_FOLD(j)) setFold(j.id, true); });
  paintHead();
});

/* 换一批任务时把视图状态也重置，别让上一批的筛选/折叠串味 */
function resetJobsView(){
  JOBS.clear(); FOLDED.clear(); OPENED.clear();
  ST.filter = 'all';
  jobsEl.innerHTML = '';
  paintFilters();
  applyFilter();
}

/* ---------- 顶部总览 ---------- */
function paintHead(){
  const arr = Array.from(JOBS.values());
  paintFilters();
  applyFilter();
  const strip = $('#strip');
  const prevIds = Array.from(strip.children).map(n => n.dataset.id).join(',');
  const ids = arr.map(j => j.id).join(',');
  if (prevIds !== ids){
    strip.innerHTML = '';
    arr.forEach(j => {
      const s = document.createElement('i');
      s.className = 'seg';
      s.dataset.id = j.id;
      s.style.flex = String(Math.max(1, Math.round(j.duration || 1)));
      s.title = j.name + (j.duration ? ' · ' + dur(j.duration) : '');
      s.appendChild(document.createElement('i'));
      strip.appendChild(s);
    });
  }
  arr.forEach(j => {
    const s = strip.querySelector('[data-id="' + j.id + '"]');
    if (!s) return;
    s.className = 'seg ' + (PCLS[j.phase] || '');
    s.firstChild.style.setProperty('--p', (j.phase === 'done' ? 100 : (j.pct || 0)) + '%');
  });
  strip.classList.toggle('idle', !arr.length || (!ST.running && !ST.finished));

  const s = ST.lastState;
  const done = arr.filter(j => j.phase === 'done').length;
  const failed = arr.filter(j => j.phase === 'failed').length;
  const running = arr.filter(j => j.phase === 'running' || j.phase === 'finalizing').length;
  const queued = arr.filter(j => j.phase === 'queued').length;

  if (!arr.length){
    $('#dhSub').textContent = '尚未开始';
    $('#ovPct').innerHTML = '0<small>%</small>';
    $('#ovEta').textContent = '';
    $('#dhMeta').innerHTML = '<span>选择文件后，这里会显示每一集的转码进度</span>';
    return;
  }
  $('#dhSub').textContent = arr.length + ' 集 · ' + human(arr.reduce((a,j)=>a+(j.srcSize||0),0));

  const pct = s ? (s.overallPct || 0) : 0;
  $('#ovPct').innerHTML = pct.toFixed(1).replace(/\.0$/,'') + '<small>%</small>';

  // 剩余时间：用已用时间 × 剩余比例推算
  let eta = '';
  if (ST.running && pct > 1.5 && pct < 99.9){
    const elapsed = (Date.now() - ST.t0) / 1000;
    eta = '约剩 ' + spanDur(elapsed * (100 - pct) / pct);
  } else if (ST.running){
    eta = '估算中…';
  }
  $('#ovEta').textContent = eta;

  const meta = $('#dhMeta'); meta.innerHTML = '';
  const put = (k, v, cls) => {
    const n = el('span');
    n.innerHTML = k + ' <b>' + v + '</b>';
    if (cls) n.className = cls;
    meta.appendChild(n);
  };
  put('完成', done + '/' + arr.length);
  if (running) put('转码中', running);
  if (queued) put('排队', queued);
  if (failed) put('失败', failed);
  if (s && s.paused) put('', s.pausedBy === 'disk' ? '磁盘空间不足，已暂停' : '已暂停派发');
  if (s && s.notice) put('', esc(s.notice));
}

/* ---------- 汇总 ---------- */
function showDocket(mode){
  const arr = Array.from(JOBS.values());
  // 跳过的不算「压完了」：它们的 outSize 是 0，混进总量会算出「节省 100%」这种假数字。
  // 试压片段同理——它只压了 15 秒，混进整批的总量会把压缩率整个带偏。
  const ok = arr.filter(j => j.phase === 'done' && !j.skipped && !j.preview);
  const skipN = arr.filter(j => j.skipped).length;
  const previewN = arr.filter(j => j.preview).length;
  const stopped = mode === 'stopped';
  // 一开跑就点停止时没有任何 done，也要给个收尾单，否则界面像什么都没发生
  if (!ok.length && !stopped && !skipN){ $('#docket').hidden = true; return; }
  const failed = arr.filter(j => j.phase === 'failed').length;
  const pending = arr.filter(j => j.phase === 'cancelled').length;
  const src = ok.reduce((a,j)=>a+(j.srcSize||0),0);
  const out = ok.reduce((a,j)=>a+(j.outSize||0),0);
  const saved = src - out;
  const totalSec = ok.reduce((a,j)=>a+(j.elapsedSec||0),0);
  const wall = ST.wallSec || (ST.t0 ? Math.round((Date.now() - ST.t0) / 1000)
    : Math.round(totalSec / Math.max(1, ST.lastState ? ST.lastState.concurrency || 1 : 1)));

  const d = $('#docket');
  d.hidden = false;
  // 全部被跳过时没什么可汇总的，直接给一句人话
  const onlySkip = !ok.length && !failed && !pending;
  d.innerHTML =
    '<div class="dhead"><h3>结果</h3>' +
      '<span class="stamp' + ((failed || stopped) ? ' fail' : '') + '">' +
        (stopped ? '已停止' : (failed ? '部分完成' : (onlySkip ? '无新增' : '已完成'))) + '</span></div>' +
    (onlySkip
      ? '<div class="dsave">这批文件都已经存在，没有新的输出。换个画质档位或删掉旧文件后再压。</div>'
      : '<div class="totals">' +
          '<div class="tot"><div class="lab">压缩前</div><div class="val">' + num(src) + '</div></div>' +
          '<div class="totarrow">→</div>' +
          '<div class="tot"><div class="lab">压缩后</div><div class="val j">' + num(out) + '</div></div>' +
        '</div>' +
        '<div class="dsave">' + (saved > 0
          ? '节省 <b>' + human(saved) + '</b> · 平均压缩率 ' + (saved/src*100).toFixed(1) + '%　源文件已完整保留'
          : '源文件已完整保留') + '</div>') +
    '<div class="dstats">' +
      '<div class="dstat"><div class="v">' + ok.length + ' 集</div><div class="k">完成</div></div>' +
      '<div class="dstat"><div class="v">' + spanDur(wall) + '</div><div class="k">总耗时</div></div>' +
      '<div class="dstat"><div class="v">' + spanDur(Math.round(totalSec / Math.max(1, ok.length))) + '</div><div class="k">平均每集</div></div>' +
      (failed ? '<div class="dstat"><div class="v" style="color:var(--flare)">' + failed + ' 集</div><div class="k">失败</div></div>' : '') +
      (skipN ? '<div class="dstat"><div class="v" style="color:var(--ink3)">' + skipN + ' 集</div><div class="k">已跳过</div></div>' : '') +
      (previewN ? '<div class="dstat"><div class="v" style="color:var(--steel)">' + previewN + ' 个</div><div class="k">试压片段</div></div>' : '') +
      (stopped && pending ? '<div class="dstat"><div class="v" style="color:var(--sodium)">' + pending + ' 集</div><div class="k">未完成</div></div>' : '') +
    '</div>' +
    '<div class="dact"><button class="btn go" id="btnOpen2" style="width:auto;padding:9px 20px">打开输出文件夹</button>' +
      '<button class="btn" id="btnAgain">再压一批</button></div>';

  $('#btnOpen2').addEventListener('click', () => openTarget({ dir: normOutDir($('#outDir').value) }, $('#openMsg')));
  $('#btnAgain').addEventListener('click', () => {
    resetJobsView();
    d.hidden = true;
    $('#empty').hidden = false;
    ST.finished = false; ST.running = false; ST.t0 = 0; ST.wallSec = 0;
    paintHead(); updateSel();
    $('#startHint').textContent = '先在第 01 步选好文件';
  });
  d.scrollIntoView({ behavior:'smooth', block:'nearest' });
}
