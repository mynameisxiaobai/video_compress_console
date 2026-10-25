/* =============================================================
   06-actions · 建任务与试压
   jobBody 组装请求体，previewFile 只压前 15 秒
   -------------------------------------------------------------
   拆自原单文件 index.html。各文件按编号顺序用普通 <script> 加载，
   共享同一个全局词法作用域（不是 ES module，无需构建、可直接双击打开）。
   ============================================================= */
'use strict';

/* ---------- 开始 ---------- */
/** 建任务请求体：整批和试压共用同一套参数，避免两处各写一份 */
function jobBody(files){
  const cap = capValue();
  return {
    files: files.map(f => ({
      file:f.file, name:f.name, size:f.size, duration:f.duration,
      container:f.container, video:f.video, audio:f.audio,
      subtitleOk:f.subtitleOk, hasSubtitle:f.hasSubtitle
    })),
    outDir: normOutDir($('#outDir').value),
    encoder: ST.enc,
    maxShortSide: cap,
    targetH: cap,
    rateMode: $('#advAuto').checked ? 'auto' : 'fixed',
    qualityTier: ST.tier,
    videoBitrate: $('#advVB').value.trim() || '2213k',
    audioBitrate: $('#advAB').value,
    nvencPreset: $('#advNP').value,
    x265Preset: $('#advXP').value,
    keepSubtitle: $('#keepSub').checked,
    vbv: $('#advVBV').checked,
    faststart: $('#advFS').checked,
    multipass: true,
    concurrency: Number($('#advConc').value) || 1,
    suffix: $('#advSuf').value.trim(),
    onConflict: $('#advConflict').value
  };
}

/** 试压：同一套参数只压前 15 秒，追加进队列，不影响正在跑的整批 */
async function previewFile(f){
  if (ST.running){ flash($('#srcMsg'), 'warn', '正在转码，等这批跑完再试压'); return; }
  const body = jobBody([f]);
  body.preview = true;
  body.previewSec = 15;
  body.append = true;             // 追加，不清空已有任务
  const r = await post('/api/jobs', body);
  if (r.error){ flash($('#srcMsg'), 'err', '试压失败：' + esc(r.error)); return; }
  $('#empty').hidden = true;
  $('#docket').hidden = true;
  if (!ST.running){
    ST.running = true; ST.finished = false; ST.t0 = Date.now(); ST.wallSec = 0;
  }
  (r.jobs || []).forEach(j => upsert(j));
  paintHead(); paintRunControls(null);
  flash($('#srcMsg'), '', '正在试压 <b>' + esc(f.name) + '</b> 的前 15 秒，完成后可在队列里打开');
}

$('#btnStart').addEventListener('click', async () => {
  const chosen = ST.files.filter(f => ST.sel.has(f.file));
  if (!chosen.length) return;
  if (ST.avail > 0 && ST.need > ST.avail * 0.85){
    $('#startHint').className = 'hint bad';
    $('#startHint').textContent = '目标盘空间不足，请换一个输出位置';
    return;
  }
  $('#btnStart').disabled = true;
  $('#startHint').className = 'hint';
  $('#startHint').textContent = '正在建立任务…';

  const cap = capValue();
  const body = jobBody(chosen);
  const r = await post('/api/jobs', body);
  if (r.error){
    $('#startHint').className = 'hint bad';
    $('#startHint').textContent = '无法开始：' + r.error +
      (r.avail ? '（需要 ' + human(r.need) + '，可用 ' + gb(r.avail).toFixed(1) + ' GB）' : '');
    $('#btnStart').disabled = false;
    return;
  }
  // 同名冲突的处理结果必须说出来：以前是静默覆盖/静默丢弃，用户完全不知情
  const nSkip = r.skipped || 0, nRen = r.renamed || 0;
  if (nSkip || nRen){
    const label = { skip: '跳过', rename: '自动改名', overwrite: '覆盖' }[r.onConflict] || '跳过';
    const parts = [];
    if (nSkip) parts.push(nSkip + ' 个文件输出已存在，按「' + label + '」处理');
    if (nRen) parts.push(nRen + ' 个同名文件已改名为带 (1) 的名字');
    flash($('#openMsg'), nSkip ? '' : 'ok', parts.join('；') + '。');
  } else if ($('#openMsg').textContent.indexOf('已存在') >= 0){
    $('#openMsg').innerHTML = '';
  }
  ST.running = true; ST.finished = false; ST.t0 = Date.now(); ST.wallSec = 0;
  ST.paused = false;
  ST.outDirty = false;
  persist({
    encoder: ST.enc, qualityTier: ST.tier, maxShortSide: cap,
    concurrency: Number($('#advConc').value) || 1, audioBitrate: $('#advAB').value
  });
  $('#outDir').value = r.outDir;
  $('#docket').hidden = true;
  $('#empty').hidden = true;
  resetJobsView();
  (r.jobs || []).forEach(j => upsert(j));
  paintHead();
  updateSel();
  paintRunControls(null);
});
