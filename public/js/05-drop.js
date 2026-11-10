/* =============================================================
   05-drop · 拖拽载入
   浏览器拿不到磁盘路径，把文件名发给本地服务反查真实路径
   -------------------------------------------------------------
   拆自原单文件 index.html。各文件按编号顺序用普通 <script> 加载，
   共享同一个全局词法作用域（不是 ES module，无需构建、可直接双击打开）。
   ============================================================= */
'use strict';

/* ---------------------------------------------------------------
   拖拽载入
   浏览器出于安全限制不把磁盘路径交给网页，drop 只能拿到名字。
   所以这里把名字发给本地服务，由它在本机常用目录里搜回真实路径。
   搜到文件夹 → 直接扫描；搜到文件 → 只载入被拖的那几个。
---------------------------------------------------------------- */
const dzEl = $('#dropzone');
let dzBeatT = 0;      // 心跳超时定时器
let dzVisible = false; // 遮罩当前是否显示（用于幂等与提前退出）
const leafOf = p => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';

function hasFiles(e){
  const dt = e.dataTransfer;
  if (!dt) return false;
  if (dt.types && Array.prototype.indexOf.call(dt.types, 'Files') >= 0) return true;
  // dragleave / 部分场景下 types 会被清空，退回看 files 兜底
  return !!(dt.files && dt.files.length);
}

function dzShow(){
  if (dzVisible) return;          // 幂等：不在已显示时反复切 hidden，避免入场动画重播造成闪
  dzVisible = true;
  dzEl.hidden = false;
}
function dzHide(){
  clearTimeout(dzBeatT);
  dzBeatT = 0;
  dzVisible = false;
  dzEl.hidden = true;
}
// dragover 在整个拖拽过程中持续触发，拿它当心跳：
// 静默超过 220ms 就认为这次拖拽已经结束（松手到窗口外、被系统取消等）。
function dzBeat(){
  dzShow();
  clearTimeout(dzBeatT);
  dzBeatT = setTimeout(dzHide, 220);
}

window.addEventListener('dragenter', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dzBeat();
}, true);
window.addEventListener('dragover', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  try { e.dataTransfer.dropEffect = 'copy'; } catch(err){}
  dzBeat();
}, true);
window.addEventListener('dragleave', e => {
  if (!dzVisible) return;
  // relatedTarget 非空说明只是跨了窗口内部的元素，交给心跳判断；真正离开窗口才立刻收起
  if (e.relatedTarget) return;
  dzHide();
}, true);
window.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dzHide();
  readDrop(e.dataTransfer);
}, true);
// 拖拽被取消（按 Esc、拖出到别的程序松手）时兜底清理
window.addEventListener('dragend', dzHide, true);

/**
 * 读目录第一层子项名，作为「指纹」。
 *
 * 目录名会撞车（十个「Season 1」），但「名字 + 里面有哪些文件」几乎唯一。
 * readEntries 每次最多回 100 条且不能并发调，所以这里串行读、到量就停；
 * 外层再套一个总超时——大目录读不完就先拿已有的，别让拖拽卡在门口。
 */
function entryChildren(entry, limit, ms){
  return new Promise(resolve => {
    if (!entry || !entry.isDirectory || !entry.createReader) return resolve(null);
    let reader;
    try { reader = entry.createReader(); } catch(e){ return resolve(null); }
    const acc = [];
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(acc); };
    const timer = setTimeout(finish, ms || 400);
    const readBatch = () => {
      if (done) return;
      try {
        reader.readEntries(batch => {
          if (done) return;
          if (!batch || !batch.length){ clearTimeout(timer); return finish(); }
          for (const e of batch){ if (acc.length < limit) acc.push(e.name); }
          if (acc.length >= limit){ clearTimeout(timer); return finish(); }
          readBatch();
        }, () => { clearTimeout(timer); finish(); });
      } catch(e){ clearTimeout(timer); finish(); }
    };
    readBatch();
  });
}

async function readDrop(dt){
  const items = [];
  const entries = [];             // 与 items 一一对应，用来异步读指纹
  const dtItems = dt.items ? Array.prototype.slice.call(dt.items) : [];
  const plain = dt.files ? Array.prototype.slice.call(dt.files) : [];

  // webkitGetAsEntry 必须在 drop 事件里同步调用，异步之后就拿不到了
  for (const it of dtItems){
    if (it.kind !== 'file') continue;
    let entry = null;
    try { entry = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null; } catch(err){}
    if (entry){
      items.push({ name: entry.name, kind: entry.isDirectory ? 'dir' : 'file' });
      entries.push(entry);
    } else {
      const f = it.getAsFile ? it.getAsFile() : null;
      if (f){ items.push({ name: f.name, kind: 'file', size: f.size }); entries.push(null); }
    }
  }
  if (!items.length) {
    for (const f of plain){ items.push({ name: f.name, kind: 'file', size: f.size }); entries.push(null); }
  }

  // entry 拿不到体积，普通文件能从 dt.files 里对上
  const sizeOf = new Map();
  for (const f of plain) if (!sizeOf.has(f.name)) sizeOf.set(f.name, f.size);
  for (const it of items){
    if (it.kind === 'file' && !it.size && sizeOf.has(it.name)) it.size = sizeOf.get(it.name);
  }

  if (!items.length) return;
  if (ST.running){ flash($('#srcMsg'),'warn','正在压缩中，等这一批完成后再拖入新的文件'); return; }

  // 指纹只给文件夹取，最多 3 个、总共 500ms —— 定位准的关键就在这一步
  const dirIdx = [];
  items.forEach((it, i) => { if (it.kind === 'dir') dirIdx.push(i); });
  if (dirIdx.length){
    const picked = dirIdx.slice(0, 3);
    const prints = await Promise.all(picked.map(i => entryChildren(entries[i], 150, 500)));
    picked.forEach((i, k) => {
      const names = prints[k];
      if (names && names.length) items[i].children = names;
    });
  }

  locateDrop(items);
}

async function locateDrop(items, retryBudget){
  const dirs = items.filter(i => i.kind === 'dir');
  const files = items.filter(i => i.kind === 'file');
  const label = dirs.length ? dirs[0].name
    : (files.length === 1 ? files[0].name : files.length + ' 个视频');
  // 拖进来的内容算作「用户主动换了源」，输出目录跟着重算
  ST.outDirty = false;
  flash($('#srcMsg'),'', '正在本机定位「' + esc(label) + '」…' +
    (retryBudget ? '（这次多给点时间）' : ''));

  let r;
  try { r = await post('/api/locate', { items: items, hint: $('#srcDir').value.trim(), budget: retryBudget || 0 }); }
  catch(e){ flash($('#srcMsg'),'err','定位失败：' + esc(e.message)); return; }

  const ms = (r && r.matches) || [];
  if (!ms.length){ dropMiss(label, r, items, retryBudget); return; }

  // 只有一个候选、而且分数够高（名字对上 + 子项基本能对上）才直接接管；
  // 分数低的唯一候选多半是「同名但内容不一样」，宁可让用户点一下。
  if (ms.length === 1 && (ms[0].score || 0) >= 45){ await applyDropMatch(ms[0], items); return; }
  renderDropChoices(ms, items, label);
}

/**
 * 定位失败的兜底。
 * 关键是不让用户卡在这儿：一口气给三条出路——再搜久一点、换系统选择框、粘路径。
 */
function dropMiss(label, r, items, retryBudget){
  const box = $('#srcMsg'); box.innerHTML = '';
  const timeout = !!(r && r.timeout);
  const secs = Math.max(1, Math.round(((r && r.ms) || 0) / 1000));

  const line = el('div','line err');
  line.innerHTML = timeout
    ? '<span>搜了 <b>' + secs + '</b> 秒还没找到「<b>' + esc(label) + '</b>」——它可能在网络盘、移动硬盘，或者藏得太深。</span>'
    : '<span>没找到「<b>' + esc(label) + '</b>」——常见位置（用户目录、各盘根往下 7 层）都没有同名文件夹。</span>';
  box.appendChild(line);

  if (r && r.error){
    const l2 = el('div','line warn');
    l2.innerHTML = '<span>' + esc(r.error) + '</span>';
    box.appendChild(l2);
  }

  const row = el('div','picklist');

  if (timeout && !retryBudget){
    const b2 = el('button','btn tiny','再搜 10 秒');
    b2.addEventListener('click', () => locateDrop(items, 10000));
    row.appendChild(b2);
  }
  const b = el('button','btn tiny','改用系统选择框…');
  b.addEventListener('click', () => pick('folder'));
  row.appendChild(b);
  box.appendChild(row);

  const tip = el('div','line dim');
  tip.innerHTML = '<span>更准的办法：在资源管理器里选中文件夹 → <b>Shift + 右键</b> → 「复制为路径」，' +
    '粘贴到上面的输入框再点扫描（粘多个也行）。</span>';
  box.appendChild(tip);
}

async function applyDropMatch(m, items){
  ST.outDirty = false;
  if (m.kind === 'dir'){
    $('#srcDir').value = m.dir;
    $('#outDir').value = deriveOut();
    // 拖进来的文件夹常带子目录（Season 1/01.mp4），这里递归把它们也捞进来，
    // 输出时会照着同样的结构建子文件夹
    await doScan(false, true);
    if (ST.files.length){
      const d = el('div','line ok');
      d.innerHTML = '<span>已从拖拽载入 <b>' + esc(leafOf(m.dir)) + '</b>' +
        (m.from === 'index' ? '（记住的位置，没再全盘搜）' : '') + '</span>';
      $('#srcMsg').appendChild(d);
    }
    return;
  }
  const want = (m.names && m.names.length) ? m.names
    : items.filter(i => i.kind === 'file').map(i => i.name);
  const paths = want.map(n => m.dir.replace(/[\\/]+$/, '') + '\\' + n);
  await loadPaths(paths);
}

function renderDropChoices(ms, items, label){
  const box = $('#srcMsg'); box.innerHTML = '';
  const line = el('div','line warn');
  line.innerHTML = '<span>找到 <b>' + ms.length + '</b> 个「' + esc(label) + '」，选一个：</span>';
  box.appendChild(line);

  const list = el('div','picklist');
  ms.forEach(m => {
    const b = el('button','btn tiny');
    b.appendChild(el('span','p1', m.dir));
    // 分数来自「目录名 + 拖入时读到的子项名」，比单纯报视频数更能说明像不像
    const sc = m.score || 0;
    const tag = sc >= 80 ? '很像' : (sc >= 45 ? '可能' : '不太像');
    const tip = tag + (m.videos ? ' · ' + m.videos + ' 个视频' : '')
      + (m.from === 'index' ? ' · 记住的' : '');
    b.appendChild(el('span','p2', tip));
    b.title = m.dir;
    b.addEventListener('click', () => applyDropMatch(m, items));
    list.appendChild(b);
  });
  box.appendChild(list);
}

/* ---------- 打开文件夹 ---------- */
async function openTarget(payload, msgNode){
  const node = msgNode || $('#openMsg');
  flash(node,'', '正在打开…');
  let r;
  try { r = await post('/api/open', payload); }
  catch(e){ r = { ok:false, error:e.message }; }
  if (r && r.ok){
    flash(node,'ok','已在资源管理器打开');
    setTimeout(() => { node.innerHTML = ''; }, 2800);
  } else {
    flash(node,'err','打开失败：' + esc((r&&r.error)||'未知原因'));
    if (payload.dir){
      const copy = el('button','btn tiny','复制路径');
      copy.style.marginLeft = '8px';
      copy.addEventListener('click', () => {
        navigator.clipboard.writeText(payload.dir).then(() => { copy.textContent = '已复制'; });
      });
      node.querySelector('.line').appendChild(copy);
    }
  }
}
$('#btnOpen').addEventListener('click', () => openTarget({ dir: normOutDir($('#outDir').value) }));
let outSaveT = 0;
$('#outDir').addEventListener('input', () => {
  ST.outDirty = true;
  // 手改路径说明用户要自己定位置，把「同级」勾选撤掉，免得勾着却没生效
  if (ST.beside){
    ST.beside = false;
    $('#outBeside').checked = false;
    persist({ besideSource: false });
  }
  updateNeed();
  // 防抖保存：不然每敲一个字符都发一次请求
  clearTimeout(outSaveT);
  outSaveT = setTimeout(() => {
    persist({ outDir: normOutDir($('#outDir').value), outManual: true });
  }, 500);
});
$('#outBeside').addEventListener('change', e => {
  ST.beside = e.target.checked;
  ST.outDirty = false;                    // 勾选/取消都是明确意图，直接接管路径
  $('#outDir').value = deriveOut();
  updateNeed();
  // 走自动推导就不再算「手选」，刷新时允许跟着源目录重算
  persist({ besideSource: ST.beside, outManual: false });
});
