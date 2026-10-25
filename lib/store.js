'use strict';
/**
 * 任务历史落盘（JSONL）。
 *
 * 之前任务状态只在内存里：服务一重启，"上次压了什么"就全没了，
 * 前端那套「刷新恢复」也只能撑到进程结束。这里只记终态（done/failed/cancelled/
 * skipped），不记进度——每 0.5 秒一条进度写盘既没必要也会把文件撑爆。
 *
 * 只追加，超过阈值再压缩一次；单个文件，不引数据库。
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DIR, 'history.jsonl');
const MAX_KEEP = 400;                      // 最多保留多少条任务记录
const MAX_BYTES = 3 * 1024 * 1024;         // 超过就压缩

function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) { /* ignore */ }
}

/** 读回历史。坏行直接跳过，不要让一条脏数据把整个记录废掉。 */
function load() {
  let raw = '';
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const r = JSON.parse(s);
      if (r && r.t === 'job' && r.id) out.push(r);
    } catch (e) { /* 跳过坏行 */ }
  }
  // 同一个 id 可能出现多次（重试/异常），以最后一条为准
  const byId = new Map();
  for (const r of out) byId.set(r.id, r);
  const all = Array.from(byId.values());
  // 只恢复最后一批：跨重启攒下的几个月历史全铺到工作台上没有意义，
  // 用户要的是「上次压的那批」。
  let lastBatch = '';
  for (const r of all) if (r.batch) lastBatch = r.batch;
  if (!lastBatch) return all.slice(-MAX_KEEP);
  return all.filter(r => r.batch === lastBatch).slice(-MAX_KEEP);
}

function record(job) {
  if (!job || !job.id) return;
  ensureDir();
  const rec = {
    t: 'job',
    at: Date.now(),
    batch: job.batch || '',
    id: job.id,
    name: job.name || '',
    src: job.src || '',
    out: job.out || '',
    srcSize: job.srcSize || 0,
    outSize: job.outSize || 0,
    duration: job.duration || 0,
    srcDuration: job.srcDuration || 0,
    srcW: job.srcW || 0,
    srcH: job.srcH || 0,
    targetW: job.targetW || 0,
    targetH: job.targetH || 0,
    scaled: !!job.scaled,
    srcKbps: job.srcKbps || 0,
    targetKbps: job.targetKbps || 0,
    srcFps: job.srcFps || 0,
    container: job.container || '',
    keepSubtitle: !!job.keepSubtitle,
    subSkipped: !!job.subSkipped,
    phase: job.phase || 'done',
    skipped: !!job.skipped,
    preview: !!job.preview,
    limitSec: job.limitSec || 0,
    renamedFrom: job.renamedFrom || null,
    note: job.note || '',
    error: job.error || null,
    outSec: job.outSec || 0,
    startedAt: job.startedAt || 0,
    endedAt: job.endedAt || Date.now()
  };
  try { fs.appendFileSync(FILE, JSON.stringify(rec) + '\n', 'utf8'); } catch (e) { return; }
  compactIfNeeded();
}

/** 文件太大就只留最后 MAX_KEEP 条，重写一遍。 */
function compactIfNeeded() {
  try {
    const st = fs.statSync(FILE);
    if (st.size <= MAX_BYTES) return;
    const keep = load().slice(-MAX_KEEP);
    const body = keep.map(r => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : '');
    fs.writeFileSync(FILE, body, 'utf8');
  } catch (e) { /* ignore */ }
}

/** 清空历史（界面的「清空」按钮会调） */
function clear() {
  try { fs.writeFileSync(FILE, '', 'utf8'); } catch (e) { /* ignore */ }
}

module.exports = { load, record, clear, FILE };
