/* =============================================================
   04-spec · 档位、码率与程序设置
   档位切换、分辨率上限与码率估算（与后端同算法）、空间估算、系统选择框、设置面板
   -------------------------------------------------------------
   拆自原单文件 index.html。各文件按编号顺序用普通 <script> 加载，
   共享同一个全局词法作用域（不是 ES module，无需构建、可直接双击打开）。
   ============================================================= */
'use strict';

/* ---------- 档位 / 编码器 ---------- */
function setTier(t, silent){
  ST.tier = TIER_CAP[t] ? t : 'balanced';
  $$('#tiers .btn').forEach(b => b.classList.toggle('on', b.dataset.tier === ST.tier));
  $('#advCap').value = String(TIER_CAP[ST.tier]);
  $('#advAB').value = TIER_AUDIO[ST.tier];
  if (!silent) { renderFiles(); updateSpec(); updateNeed(); }
}
$$('#tiers .btn').forEach(b => b.addEventListener('click', () => setTier(b.dataset.tier)));
$$('#encs .btn').forEach(b => b.addEventListener('click', () => {
  ST.enc = b.dataset.enc;
  $$('#encs .btn').forEach(x => x.classList.toggle('on', x === b));
  $('#advConc').value = ST.enc === 'nvenc' ? 2 : 1;
  updateSpec();
}));

/* ---------- 分辨率 / 码率（与后端同算法） ---------- */
function capValue(){
  return Math.max(0, Math.floor(Number($('#advCap').value) || 0));
}
function outSizeOf(f, cap){
  const w = Number(f.video && f.video.width) || 0;
  const h = Number(f.video && f.video.height) || 0;
  if (w < 2 || h < 2 || cap < 2 || Math.min(w, h) <= cap) return { w, h, scaled:false };
  const capEven = Math.max(2, Math.floor(cap / 2) * 2);
  const r = capEven / Math.min(w, h);
  const even = v => Math.max(2, Math.floor(v / 2) * 2);
  return w >= h ? { w: even(w * r), h: capEven, scaled:true }
                : { w: capEven, h: even(h * r), scaled:true };
}
function sizeBoost(shortSide){
  const s = Number(shortSide) || 0;
  if (s <= 0 || s >= 1080) return 1;
  return Math.min(1.5, Math.max(1, Math.sqrt(1080 / s)));
}
function autoKbps(f, cap){
  const d = outSizeOf(f, cap);
  if (d.w < 2 || d.h < 2) return null;
  let fps = Number(f.video && f.video.fps) || 0;
  if (!(fps > 0)) fps = FPS_DEF;
  fps = Math.min(120, Math.max(1, fps));
  let k = Math.round(d.w * d.h * fps * (BPP[ST.tier] || BPP.balanced) * sizeBoost(Math.min(d.w, d.h)) / 1000);
  k = Math.max(FLOOR_K, Math.min(CEIL_K, k));
  const src = Math.round((Number(f.video && f.video.bitrate) || 0) / 1000);
  if (src > 0) k = Math.min(k, Math.max(HARD_MIN_K, Math.round(src * SRC_RATIO)));
  return k;
}
function kbpsOf(f, cap){
  if (!$('#advAuto').checked){
    const fx = parseInt($('#advVB').value, 10);
    if (fx > 0) return fx;
  }
  const a = autoKbps(f, cap);
  if (a) return a;
  return parseInt($('#advVB').value, 10) || 2213;
}
function updateSpec(){
  const cap = capValue();
  const chosen = ST.files.filter(f => ST.sel.has(f.file));
  const sample = chosen[0];
  const k = sample ? kbpsOf(sample, cap) : null;
  // 三档各自的首个文件码率，直接标在按钮上，用户不必展开高级参数
  const NOMINAL = { small:1560, balanced:2150, high:2720 };   // 1920×1080@25 下的参考值
  ['small','balanced','high'].forEach(t => {
    const node = $('#tiers').querySelector('[data-k="' + t + '"]');
    if (!node) return;
    if (!sample){ node.textContent = '≈' + NOMINAL[t] + 'k'; return; }
    const old = ST.tier; ST.tier = t;
    const kk = kbpsOf(sample, cap);
    ST.tier = old;
    node.textContent = '≈' + (Math.round(kk/10)*10) + 'k';
  });
  const d = sample ? outSizeOf(sample, cap) : null;
  const sp = $('#spec'); sp.innerHTML = '';
  if (d && d.w > 1){
    const a = el('span'); a.innerHTML = '输出 <b>' + d.w + '×' + d.h + '</b>' + (d.scaled ? '' : '（原尺寸）');
    sp.appendChild(a);
  }
  if (k){ const b = el('span'); b.innerHTML = '视频 <b>' + k + 'k</b>'; sp.appendChild(b); }
  const c = el('span'); c.innerHTML = 'HEVC <b>hvc1</b>'; sp.appendChild(c);
  if ($('#keepSub').checked){ const s = el('span'); s.innerHTML = '<b>mov_text</b> 字幕'; sp.appendChild(s); }
  $('#capMeta').textContent = cap ? '上限 ' + cap + 'p' : '原分辨率';
  // 分辨率上限变化会改变每集体积，文件行的预估要跟着走
  $$('#files .frow').forEach(li => {
    const f = ST.files.find(x => x.file === li.dataset.f);
    if (!f) return;
    const o = li.querySelector('.fout');
    const kk = kbpsOf(f, cap);
    if (o && kk && f.duration){
      o.textContent = '≈ ' + human(((kk + (parseInt($('#advAB').value,10)||192)) * 1000 / 8) * f.duration);
    }
  });
  updateNeed();
}

/* ---------- 空间估算 ---------- */
function updateNeed(){
  clearTimeout(ST.needTimer);
  ST.needTimer = setTimeout(calcNeed, 120);
}
function calcNeed(){
  const chosen = ST.files.filter(f => ST.sel.has(f.file));
  const cap = capValue();
  const ab = parseInt($('#advAB').value, 10) || 192;
  const need = chosen.reduce((s,f) => s + ((kbpsOf(f,cap) + ab) * 1000 / 8) * (f.duration||0), 0);
  const root = normOutDir($('#outDir').value || 'E:\\').slice(0,3).toUpperCase();
  const d = (ST.status && (ST.status.drives||[]).find(x => x.root === root));
  const avail = d ? d.avail : 0;
  ST.need = need; ST.avail = avail;
  $('#needV').textContent = human(need);
  $('#availV').textContent = d ? d.root + ' 可用 ' + gb(avail).toFixed(1) + ' GB' : '—';
  const pct = avail > 0 ? Math.min(100, need/avail*100) : 0;
  const tr = $('#spaceTrack');
  tr.querySelector('i').style.width = pct.toFixed(1) + '%';
  tr.classList.toggle('over', avail > 0 && need > avail * 0.85);
}

/* ---------- 系统选择框 ---------- */
const dirOf = p => String(p || '').replace(/[\\/][^\\/]*$/, '');

/**
 * @param {'file'|'folder'} mode
 * @param {boolean} forOut  true = 选输出目录（兼容老调用）
 * @param {'src'|'out'|'ffmpeg'|'ffprobe'|'root'} target 选完填到哪里
 */
async function pick(mode, forOut, target){
  const t = target || (forOut ? 'out' : 'src');
  const btnSel = t === 'out' ? '#btnPickOut'
    : t === 'ffmpeg' ? '#btnBrowseFF'
    : t === 'ffprobe' ? '#btnBrowseFP'
    : t === 'root' ? '#btnBrowseRoot'
    : (mode === 'folder' ? '#btnPickDir' : '#btnPick');
  const btn = $(btnSel);
  const box = t === 'src' ? $('#srcMsg') : (t === 'out' ? $('#openMsg') : $('#setMsg'));
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = '等待…';
  flash(box, '', t === 'src'
    ? (mode === 'folder' ? '已打开 Windows 窗口，请选择文件夹…' : '已打开 Windows 窗口，可多选视频文件…')
    : '已打开 Windows 窗口，请选择…');
  try {
    const cur = t === 'src' ? $('#srcDir').value
      : t === 'out' ? $('#outDir').value
      : t === 'ffmpeg' ? $('#setFF').value
      : t === 'ffprobe' ? $('#setFP').value
      : $('#setRoot').value;
    const initialDir = (mode === 'file' ? dirOf(cur) : cur).trim();
    const r = await post('/api/pick', {
      mode, initialDir,
      purpose: (t === 'out' || t === 'root') ? 'out' : 'src'
    });
    if (!r || r.error){ flash(box,'err','选择失败：' + esc((r&&r.error)||'未知错误')); return; }
    if (!r.paths || !r.paths.length){ box.innerHTML = ''; return; }
    const p = r.paths[0];

    if (t === 'out'){
      // 手选的位置优先，之后改画质/分辨率、换源目录都不会把路径冲掉
      ST.outDirty = true;
      ST.beside = false;
      $('#outBeside').checked = false;
      $('#outDir').value = p;
      updateNeed();
      persist({ besideSource: false, outDir: normOutDir(p), outManual: true });
      flash(box, 'ok', '输出目录已设为 ' + esc(p));
      return;
    }
    if (t === 'ffmpeg' || t === 'ffprobe'){
      $(t === 'ffmpeg' ? '#setFF' : '#setFP').value = p;
      await saveSetting(t === 'ffmpeg' ? { ffmpegPath: p } : { ffprobePath: p });
      flash(box, 'ok', (t === 'ffmpeg' ? 'ffmpeg' : 'ffprobe') + ' 路径已保存，顶部能力已刷新');
      return;
    }
    if (t === 'root'){
      $('#setRoot').value = p;
      await saveSetting({ outputRoot: p });
      if (!ST.outDirty) $('#outDir').value = deriveOut();
      updateNeed();
      flash(box, 'ok', '默认输出根目录已设为 ' + esc(p));
      return;
    }

    ST.outDirty = false;
    if (mode === 'folder'){ $('#srcDir').value = p; await doScan(); }
    else { await loadPaths(r.paths); }
  } catch(e){
    flash(box,'err','选择失败：' + esc(e.message));
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

/** 保存程序设置。改 ffmpeg/ffprobe 路径后要重新探测能力，否则顶部的小绿点还是旧的 */
async function saveSetting(patch){
  try {
    const r = await post('/api/config', patch);
    if (r && r.error){ flash($('#setMsg'), 'err', '保存失败：' + esc(r.error)); return false; }
    if (patch.ffmpegPath !== undefined || patch.ffprobePath !== undefined) await refreshStatus();
    return true;
  } catch(e){
    flash($('#setMsg'), 'err', '保存失败：' + esc(e.message));
    return false;
  }
}

async function refreshStatus(){
  try { ST.status = await api('/api/status'); renderChips(ST.status); } catch(e){}
}

$('#btnPick').addEventListener('click', () => pick('file'));
$('#btnPickDir').addEventListener('click', () => pick('folder'));
$('#btnPickOut').addEventListener('click', () => pick('folder', true));
$('#btnBrowseFF').addEventListener('click', () => pick('file', false, 'ffmpeg'));
$('#btnBrowseFP').addEventListener('click', () => pick('file', false, 'ffprobe'));
$('#btnBrowseRoot').addEventListener('click', () => pick('folder', true, 'root'));

/* ---------- 程序设置 ---------- */
$('#setFF').addEventListener('change', async () => {
  const v = $('#setFF').value.trim();
  if (await saveSetting({ ffmpegPath: v })) flash($('#setMsg'), 'ok', 'ffmpeg 路径已保存，顶部能力已刷新');
});
$('#setFP').addEventListener('change', async () => {
  if (await saveSetting({ ffprobePath: $('#setFP').value.trim() })) flash($('#setMsg'), 'ok', 'ffprobe 路径已保存');
});
$('#setRoot').addEventListener('change', async () => {
  const v = $('#setRoot').value.trim();
  if (!v) return;
  if (await saveSetting({ outputRoot: normOutDir(v) })){
    if (!ST.outDirty) $('#outDir').value = deriveOut();
    updateNeed();
    flash($('#setMsg'), 'ok', '默认输出根目录已保存');
  }
});
$('#setPort').addEventListener('change', async () => {
  const n = Math.max(1024, Math.min(65535, Number($('#setPort').value) || 8787));
  $('#setPort').value = n;
  if (await saveSetting({ port: n })) flash($('#setMsg'), 'ok', '端口已保存，重启服务后生效');
});
$('#setNotify').addEventListener('change', e => persist({ notifyOnDone: e.target.checked }));
$('#setSound').addEventListener('change', e => persist({ soundOnDone: e.target.checked }));
$('#appendMode').addEventListener('change', () => {
  if ($('#appendMode').checked) flash($('#srcMsg'), '', '追加模式：下次选文件夹 / 拖入会合并进当前列表');
  else $('#srcMsg').innerHTML = '';
});
$('#btnLog').addEventListener('click', () => window.open('/api/logfile?lines=500', '_blank'));
