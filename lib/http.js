'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

/** 读完整请求体（限制 8MB，防止意外） */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const max = limit || 8 * 1024 * 1024;
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, obj, code) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': body.length
  });
  res.end(body);
}

function text(res, str, type, code) {
  const body = Buffer.from(str, 'utf8');
  res.writeHead(code || 200, {
    'Content-Type': (type || 'text/plain') + '; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': body.length
  });
  res.end(body);
}

/** 极简路由：返回 { handler, params } */
function createRouter(routes) {
  return function route(method, pathname) {
    for (const r of routes) {
      if (r.method && r.method !== method) continue;
      if (r.exact) {
        if (pathname === r.path) return { handler: r.handler, params: {} };
        continue;
      }
      const m = r.regex.exec(pathname);
      if (m) return { handler: r.handler, params: m.groups || {}};
    }
    return null;
  };
}

/** SSE 初始化，返回推送函数 */
function sseInit(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(':ok\n\n');
  const send = (event, data) => {
    if (res.writableEnded) return false;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch (e) { return false; }
  };
  const hb = setInterval(() => {
    if (res.writableEnded) { clearInterval(hb); return; }
    try { res.write(':hb\n\n'); } catch (e) { clearInterval(hb); }
  }, 15000);
  send.close = () => { clearInterval(hb); };
  return send;
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.woff2': 'font/woff2'
};

function serveFile(res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type + (type.startsWith('text') || type.includes('json') ? '; charset=utf-8' : ''),
      'Content-Length': st.size,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

module.exports = { readBody, json, text, createRouter, sseInit, serveFile };
