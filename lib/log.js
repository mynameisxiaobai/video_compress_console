'use strict';
/**
 * 运行日志（落盘）。
 *
 * 之前只有 console：控制台窗口一关就没了，用户报问题时只能靠回忆。
 * 这里把关键事件写成纯文本，界面里点一下就能看到最后 500 行。
 * 只记事件，不记 ffmpeg 的逐行输出（那些量太大，任务级的错误摘要已经够了）。
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DIR, 'server.log');
const MAX_BYTES = 2 * 1024 * 1024;
const KEEP_LINES = 2000;

let writes = 0;

function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) { /* ignore */ }
}

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function write(level, msg) {
  ensureDir();
  const s = stamp() + ' [' + level + '] ' + String(msg).replace(/\r?\n/g, ' ⏎ ') + '\n';
  try { fs.appendFileSync(FILE, s, 'utf8'); } catch (e) { return; }
  if (++writes % 50 === 0) trim();
}

function trim() {
  try {
    if (fs.statSync(FILE).size <= MAX_BYTES) return;
    const lines = fs.readFileSync(FILE, 'utf8').split('\n');
    fs.writeFileSync(FILE, lines.slice(-KEEP_LINES).join('\n'), 'utf8');
  } catch (e) { /* ignore */ }
}

/** 最后 n 行，给界面看 */
function tail(n) {
  const want = Math.max(1, Math.min(5000, Number(n) || 500));
  try {
    const lines = fs.readFileSync(FILE, 'utf8').split('\n');
    return lines.slice(-want).join('\n');
  } catch (e) {
    return '(还没有日志)';
  }
}

module.exports = {
  FILE,
  info:  m => write('INFO', m),
  warn:  m => write('WARN', m),
  error: m => write('ERR ', m),
  tail
};
