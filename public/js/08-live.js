/* =============================================================
   08-live · SSE 与完成通知
   progress/done/failed/cancelled 事件驱动，提示音与桌面通知
   -------------------------------------------------------------
   拆自原单文件 index.html。各文件按编号顺序用普通 <script> 加载，
   共享同一个全局词法作用域（不是 ES module，无需构建、可直接双击打开）。
   ============================================================= */
'use strict';

/* ---------- SSE ---------- */
function connectSSE(){
  let es;
  try { es = new EventSource('/api/events'); } catch(e){ return; }
  const on = ev => { try { upsert(JSON.parse(ev.data)); } catch(e){} };
  es.addEventListener('job.progress', on);
  es.addEventListener('job.done', on);
  es.addEventListener('job.failed', on);
  es.addEventListener('job.cancelled', on);
  es.addEventListener('queue.state', ev => { try { onState(JSON.parse(ev.data)); } catch(e){} });
  es.onmessage = ev => { try { const d = JSON.parse(ev.data); if (d && d.total !== undefined) onState(d); } catch(e){} };
  es.onerror = () => { /* 浏览器会自动重连 */ };
}

/* ---------- 完成通知 / 提示音 ---------- */
function beep(){
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ac = beep.ac || (beep.ac = new AC());
    if (ac.state === 'suspended') ac.resume();
    const t0 = ac.currentTime;
    [880, 1180].forEach((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine'; o.frequency.value = f;
      const at = t0 + i * 0.16;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.14, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.15);
      o.connect(g); g.connect(ac.destination);
      o.start(at); o.stop(at + 0.17);
    });
  } catch (e) {}
}

function notifyDone(s){
  if (!('Notification' in window)) return;
  if (!$('#setNotify').checked) return;
  const arr = Array.from(JOBS.values());
  const ok = arr.filter(j => j.phase === 'done' && !j.skipped).length;
  const skip = arr.filter(j => j.skipped).length;
  const bad = arr.filter(j => j.phase === 'failed').length;
  const title = bad ? '转码结束，' + bad + ' 个失败'
    : (ok ? '转码完成' : '这批没有新增输出');
  const body = [
    ok ? ok + ' 个完成' : '',
    skip ? skip + ' 个跳过' : '',
    bad ? bad + ' 个失败' : '',
    (s && s.elapsedSec) ? '耗时 ' + spanDur(s.elapsedSec) : ''
  ].filter(Boolean).join(' · ');
  const fire = () => { try { new Notification(title, { body, tag: 'vcc-done' }); } catch (e) {} };
  try {
    if (Notification.permission === 'granted') fire();
    else if (Notification.permission !== 'denied'){
      Notification.requestPermission().then(p => { if (p === 'granted') fire(); });
    }
  } catch (e) {}
}

function onState(s){
  if (!s || s.overallPct === undefined) return;
  // total=0 是「服务端已经空了」，本地通常刚清完。忽略它，
  // 免得清空/撤销过程中被一条空状态打断（会把结果单重画一遍）。
  if (!s.total) return;
  ST.lastState = s;
  paintHead();
  paintRunControls(s);

  if (s.finished){
    if (ST.running){
      // 先把这一批的真实墙钟用时定住，再清计时器——否则汇总会拿到 0 当起点
      ST.wallSec = (s && s.elapsedSec) ? s.elapsedSec
        : (ST.t0 ? Math.round((Date.now() - ST.t0) / 1000) : 0);
      ST.running = false;
      ST.finished = true;
      ST.t0 = 0;
      if (s.stopped){
        $('#startHint').className = 'hint bad';
        $('#startHint').textContent = '已停止：已完成的集保留在输出目录，其余未继续';
      } else {
        $('#startHint').className = 'hint good';
        $('#startHint').textContent = '这一批已完成。改选文件后可以直接再压一批';
      }
      updateSel();
      // 只有「这一批刚刚结束」时通知一次，别让刷新恢复的历史也弹一遍
      if ($('#setSound').checked) beep();
      notifyDone(s);
    }
    paintRunControls(s);          // running 变了，暂停/停止按钮要跟着收起来
    if (JOBS.size) showDocket(s.stopped ? 'stopped' : '');
  }
}
