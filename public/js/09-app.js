/* =============================================================
   09-app · 恢复与交互绑定
   刷新页面后接上当前批次（含重启恢复），最后绑定高级项与输入框事件
   -------------------------------------------------------------
   拆自原单文件 index.html。各文件按编号顺序用普通 <script> 加载，
   共享同一个全局词法作用域（不是 ES module，无需构建、可直接双击打开）。
   ============================================================= */
'use strict';

/* ---------- 恢复：刷新页面后接上当前这批 ---------- */
// 刚结束的批次在这个窗口内仍然恢复。更早的旧批次不再铺到工作台，
// 否则每次打开页面都会看到一堆早已处理完、源文件可能已经移走的任务。
const RESUME_DONE_MS = 24 * 3600 * 1000;

(async function resume(){
  try { await boot(); }
  catch (err){
    flash($('#srcMsg'),'err','无法连接本地服务，请确认启动窗口还在：' + esc(err.message));
    return;
  }
  try {
    const r = await api('/api/jobs');
    const st = (r && r.state) || {};
    const jobs = (r && r.jobs) || [];
    if (!jobs.length) return;

    const endedAgo = st.endedAt ? (Date.now() - st.endedAt) : 0;
    const freshDone = !!st.finished && endedAgo > 0 && endedAgo < RESUME_DONE_MS;
    // 从磁盘恢复的那批就是「上次压的」，不再按时间丢弃——否则重启一次历史就看不见了
    const fromDisk = jobs.some(j => j.restored);
    if (st.finished && !fromDisk && !freshDone) return;   // 上一批太旧，让工作台保持空

    ST.lastState = st;
    $('#empty').hidden = true;
    ST.rehydrating = true;
    jobs.forEach(j => upsert(j));
    ST.rehydrating = false;

    if (st.finished){
      // 已经全部结束：不要进入「running」，直接落到完成态，并把结果单铺出来
      ST.running = false;
      ST.finished = true;
      ST.paused = false;
      ST.wallSec = st.elapsedSec || 0;
      if (fromDisk){
        $('#startHint').className = 'hint';
        $('#startHint').textContent = '以下是上次（服务重启前）的批次，点「清空」可清除';
      } else if (st.stopped){
        $('#startHint').className = 'hint bad';
        $('#startHint').textContent = '已停止：已完成的集保留在输出目录，其余未继续';
      } else {
        $('#startHint').className = 'hint good';
        $('#startHint').textContent = '这一批已完成。改选文件后可以直接再压一批';
      }
      if (JOBS.size) showDocket(st.stopped ? 'stopped' : '');
    } else {
      ST.running = true;
      ST.finished = false;
      ST.paused = !!st.paused;
      ST.t0 = Date.now() - (st.elapsedSec || 0) * 1000;
      $('#startHint').className = 'hint';
      $('#startHint').textContent = st.paused ? '已暂停派发，正在转码的会跑完' : '转码中，可暂停或停止整批';
    }
    updateSel();
    paintHead();
    paintRunControls(st);
  } catch(e){}
})();

/* 交互细节：高级项变化同步 */
$('#advCap').addEventListener('change', () => { renderFiles(); updateSpec(); });
$('#advAB').addEventListener('change', () => { renderFiles(); updateSpec(); });
$('#advAuto').addEventListener('change', () => {
  $('#advVB').disabled = $('#advAuto').checked;
  if ($('#advAuto').checked) $('#advVB').value = '';
  renderFiles(); updateSpec();
});
$('#advVB').addEventListener('input', () => { renderFiles(); updateSpec(); });
$('#keepSub').addEventListener('change', updateSpec);
$('#srcDir').addEventListener('keydown', e => { if (e.key === 'Enter') doScan(); });
