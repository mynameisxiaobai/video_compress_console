/* =============================================================
   02-boot · 启动与顶栏信息
   boot() 拉 /api/status，把后端下发的码率模型覆盖到本地常量，渲染能力标签
   -------------------------------------------------------------
   拆自原单文件 index.html。各文件按编号顺序用普通 <script> 加载，
   共享同一个全局词法作用域（不是 ES module，无需构建、可直接双击打开）。
   ============================================================= */
'use strict';

/* ---------- 启动 ---------- */
async function boot(){
  ST.status = await api('/api/status');
  renderChips(ST.status);
  // 码率常量以后端为准
  const bm = ST.status && ST.status.bitrate;
  if (bm){
    if (bm.bpp) BPP = bm.bpp;
    if (bm.fpsFallback) FPS_DEF = bm.fpsFallback;
    if (bm.floorKbps) FLOOR_K = bm.floorKbps;
    if (bm.ceilKbps) CEIL_K = bm.ceilKbps;
    if (bm.srcRatio) SRC_RATIO = bm.srcRatio;
    if (bm.hardMinKbps) HARD_MIN_K = bm.hardMinKbps;
  }
  const cfg = (ST.status && ST.status.config) || {};
  $('#srcDir').value = cfg.sourceDir || '';
  $('#advConc').value = cfg.concurrency || 2;
  $('#advVB').disabled = true;
  const CF = ['skip', 'rename', 'overwrite'];
  $('#advConflict').value = CF.indexOf(cfg.onConflict) >= 0 ? cfg.onConflict : 'skip';
  // 程序设置
  $('#setFF').value = cfg.ffmpegPath || '';
  $('#setFP').value = cfg.ffprobePath || '';
  $('#setRoot').value = cfg.outputRoot || '';
  $('#setPort').value = cfg.port || 8787;
  $('#setNotify').checked = cfg.notifyOnDone !== false;
  $('#setSound').checked = !!cfg.soundOnDone;
  ST.beside = !!cfg.besideSource;
  $('#outBeside').checked = ST.beside;
  // 手选/手输过的输出目录要原样恢复；只有自动推导的才跟着源目录重算。
  // （以前这里无条件 deriveOut()，刷新一次就把用户挑的目录冲掉了）
  if (cfg.outManual && cfg.outDir){
    ST.outDirty = true;
    syncOutMode();              // 手动分支不经过 deriveOut，这里要自己同步一次
    $('#outDir').value = cfg.outDir;
  } else {
    ST.outDirty = false;
    $('#outDir').value = deriveOut();
  }
  if (cfg.qualityTier && TIER_CAP[cfg.qualityTier]) setTier(cfg.qualityTier, true);
  if (cfg.maxShortSide !== undefined && cfg.maxShortSide !== null) {
    const v = String(cfg.maxShortSide);
    if ($$('#advCap option').some(o => o.value === v)) $('#advCap').value = v;
  }
  updateSpec(); updateNeed(); updateSel();   // updateSel 负责把空状态下的全选/反选置灰
  if (ST.status && ST.status.sourceDefaultExists) doScan(true);
  connectSSE();
}

function renderChips(st){
  const wrap = $('#chips'); wrap.innerHTML = '';
  const caps = (st && st.caps) || {};
  if (st && st.ffmpeg){
    const shortVer = String(st.versionShort || '—').split(/[-_ ]/)[0];
    const c1 = el('span','chip ok'); c1.innerHTML = 'ffmpeg <b>'+esc(shortVer)+'</b>'; wrap.appendChild(c1);
    const c2 = el('span','chip ' + (caps.hevc_nvenc?'ok':'bad'));
    c2.innerHTML = '显卡编码 <b>'+(caps.hevc_nvenc?'可用':'不可用')+'</b>'; wrap.appendChild(c2);
    const c3 = el('span','chip ' + (caps.libx265?'ok':'bad'));
    c3.innerHTML = 'x265 <b>'+(caps.libx265?'可用':'不可用')+'</b>'; wrap.appendChild(c3);
  } else {
    const c = el('span','chip bad'); c.innerHTML = 'ffmpeg <b>未找到</b>'; wrap.appendChild(c);
  }
  const root = String(((st&&st.config&&st.config.outputRoot)||'')).slice(0,3).toUpperCase();
  const d = ((st&&st.drives)||[]).find(x => x.root === root);
  if (d){
    const c = el('span','chip'); c.innerHTML = esc(d.root) + ' 剩余 <b>' + gb(d.avail).toFixed(1) + ' GB</b>';
    wrap.appendChild(c);
  }
}
