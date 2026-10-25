'use strict';
/**
 * 调用 Windows 原生文件/文件夹选择框。
 *
 * 关键点：
 * 1. 结果通过临时文件回传，不走 stdout —— 中文路径经控制台会被 GBK 破坏。
 * 2. 同时只允许一个选择窗口（busy 锁）。
 * 3. 必须异步 spawn：本机的 spawnSync 会稳定 EBUSY。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PS1 = path.join(__dirname, 'pick.ps1');

let busy = false;

function powershellExe() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const p = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(p) ? p : 'powershell.exe';
}

/**
 * @param {object} o { mode:'file'|'folder', initialDir:string, purpose:'src'|'out', timeout:number }
 * @returns {Promise<{ok:boolean, paths:string[], cancelled?:boolean, error?:string}>}
 */
function pick(o) {
  const opts = o || {};
  const mode = opts.mode === 'folder' ? 'folder' : 'file';
  const purpose = opts.purpose === 'out' ? 'out' : 'src';
  const timeout = Number(opts.timeout) || 300000;

  let cancelFn = () => {};

  const promise = new Promise((resolve) => {
    if (busy) return resolve({ ok: false, paths: [], error: '已有一个选择窗口打开中' });
    if (!fs.existsSync(PS1)) return resolve({ ok: false, paths: [], error: '缺少 lib/pick.ps1' });

    busy = true;
    const outFile = path.join(
      os.tmpdir(),
      'vcpick_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.txt'
    );

    const args = [
      '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass',
      '-File', PS1,
      '-Mode', mode,
      '-InitialDir', String(opts.initialDir || ''),
      '-Purpose', purpose,
      '-OutFile', outFile
    ];

    let child = null;
    let settled = false;

    function finish(result) {
      if (settled) return;
      settled = true;
      busy = false;
      clearTimeout(timer);
      // 对话框可能还开着，必须收掉，否则会留下孤儿 powershell
      try { if (child && child.exitCode === null) child.kill(); } catch (e) { /* ignore */ }
      try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch (e) { /* ignore */ }
      resolve(result);
    }

    // 用户可能把窗口挂在那儿不管，给个上限自动放弃
    const timer = setTimeout(() => {
      try { if (child) child.kill(); } catch (e) { /* ignore */ }
      finish({ ok: false, paths: [], error: '选择窗口超时（5 分钟）' });
    }, timeout);

    try {
      child = spawn(powershellExe(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return finish({ ok: false, paths: [], error: e.message });
    }

    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});   // 内容可能乱码，这里不做任何解析
    child.on('error', (e) => finish({ ok: false, paths: [], error: e.message }));

    child.on('close', () => {
      let paths = [];
      try {
        if (fs.existsSync(outFile)) {
          paths = fs.readFileSync(outFile, 'utf8')
            .split(/\r?\n/)
            .map(s => s.trim())
            .filter(Boolean);
        }
      } catch (e) { /* ignore */ }
      finish({ ok: true, paths, cancelled: paths.length === 0 });
    });

    // 客户端（页面）中途断开时由调用方触发，避免 busy 锁白占 5 分钟
    cancelFn = () => finish({ ok: false, paths: [], error: '已取消' });
  });

  promise.cancel = () => cancelFn();
  return promise;
}

module.exports = { pick };
