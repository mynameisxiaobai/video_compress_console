'use strict';
const fs = require('fs');

/**
 * 磁盘空间查询（Node 原生 fs.statfsSync，零依赖，中文 Windows 下无 GBK 乱码问题）
 */
function driveInfo(root) {
  try {
    const s = fs.statfsSync(root);
    return {
      root: String(root).toUpperCase(),
      total: Number(s.blocks) * Number(s.bsize),
      free: Number(s.bfree) * Number(s.bsize),
      avail: Number(s.bavail) * Number(s.bsize),
      ok: true
    };
  } catch (e) {
    return { root: String(root).toUpperCase(), total: 0, free: 0, avail: 0, ok: false, error: e.message };
  }
}

/** Windows 固定盘列表：C:\ ~ Z:\ */
function listDrives() {
  const out = [];
  for (let c = 67; c <= 90; c++) { // C..Z
    const root = String.fromCharCode(c) + ':\\';
    if (!fs.existsSync(root)) continue;
    const info = driveInfo(root);
    if (info.ok) out.push(info);
  }
  return out;
}

/** 取某个路径所在盘的根（如 E:\压缩完成\x -> E:\） */
function driveRootOf(p) {
  const m = /^([A-Za-z]):[\\/]/.exec(String(p || ''));
  return m ? (m[1].toUpperCase() + ':\\') : null;
}

/**
 * 预检：输出目录所在盘空间是否够。
 * safety = 0.8 表示只允许用掉可用空间的 80%，给系统留余量。
 */
function checkSpace(outputRoot, needBytes, safety) {
  const info = driveInfo(outputRoot);
  const permit = Math.floor(info.avail * (safety == null ? 0.8 : safety));
  return {
    need: needBytes,
    avail: info.avail,
    permit,
    enough: info.ok && permit >= needBytes,
    root: info.root,
    ok: info.ok,
    error: info.error
  };
}

module.exports = { driveInfo, listDrives, driveRootOf, checkSpace };
