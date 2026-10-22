'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const FFmpeg = require('./ffmpeg');
const Paths = require('./paths');
const Bitrate = require('./bitrate');

let SEQ = 1;

class TaskManager {
  constructor() {
    this.jobs = new Map();       // id -> job
    this.queue = [];             // 等待中的 job id
    this.running = new Map();    // id -> child
    this.opts = null;
    this.ffmpegExe = null;
    this.emit = () => {};
    this.caps = {};
    this.paused = false;
    this.batchStartedAt = 0;
    this.batchEndedAt = 0;
    this.diskGuard = null;
    this.stats = { completedBytes: 0, sourceBytes: 0 };
  }

  configure({ ffmpegExe, emit, caps }) {
    this.ffmpegExe = ffmpegExe;
    this.emit = emit || (() => {});
    if (caps) this.caps = caps;
  }

  setDiskGuard(fn) { this.diskGuard = fn; }

  /**
   * 建立一批任务。files 为 probe 过的元数据数组。
   * opts: { outDir, targetH, videoBitrate, audioBitrate, encoder, preset,
   *         nvencPreset, x265Preset, keepSubtitle, vbv, faststart, concurrency, ... }
   */
  createJobs(files, opts) {
    this.clear();
    this.opts = Object.assign({}, opts);
    this.batchStartedAt = Date.now();
    this.batchEndedAt = 0;
    this.stats = { completedBytes: 0, sourceBytes: 0 };

    const usedOut = new Set();

    for (const f of files) {
      const out = Paths.outputFileFor(f.file, opts.outDir, opts.suffix || '');
      if (usedOut.has(out.toLowerCase())) continue;
      usedOut.add(out.toLowerCase());

      // 每个文件按自己的分辨率/帧率/源码率算目标尺寸与码率
      const srcKbps = Bitrate.srcKbpsOf(f);
      const plan = Bitrate.planFile({
        width: f.video && f.video.width,
        height: f.video && f.video.height,
        fps: f.video && f.video.fps,
        srcKbps,
        capShort: opts.maxShortSide,
        rateMode: opts.rateMode,
        fixedKbps: opts.videoBitrate,
        tier: opts.qualityTier
      });

      const job = {
        id: 'j' + (SEQ++),
        name: f.name,
        src: f.file,
        out,
        part: out + '.part',
        srcSize: f.size || 0,
        duration: f.duration || 0,
        srcW: plan.srcW,
        srcH: plan.srcH,
        srcKbps,
        srcFps: Number(f.video && f.video.fps) || 0,
        targetW: plan.outW,
        targetH: plan.outH,
        scaled: plan.scaled,
        targetKbps: plan.kbps,
        container: f.container,
        // 字幕只有能转 mov_text 才保留
        keepSubtitle: !!(opts.keepSubtitle && f.subtitleOk),
        subSkipped: !!(opts.keepSubtitle && f.hasSubtitle && !f.subtitleOk),
        phase: 'queued',
        pct: 0, speed: '', fps: '', bitrate: '', outSize: 0, outSec: 0,
        startedAt: 0, endedAt: 0, error: null, retries: 0
      };
      this.jobs.set(job.id, job);
      this.queue.push(job.id);
      this.stats.sourceBytes += job.srcSize;
    }
    return Array.from(this.jobs.values());
  }

  clear() {
    for (const [, child] of this.running) {
      try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
    }
    this.running.clear();
    this.jobs.clear();
    this.queue = [];
    this.paused = false;
  }

  get concurrency() {
    const c = this.opts && this.opts.concurrency;
    return c > 0 ? c : 1;
  }

  /** 主循环：尽量把队列里的任务派发到并发上限 */
  pump() {
    if (this.paused) return;
    // 磁盘看护
    if (this.diskGuard) {
      const g = this.diskGuard();
      if (g && !g.enough) {
        this.paused = true;
        this.emit('queue.state', { paused: true, reason: '磁盘空间不足，已暂停派发', disk: g });
        return;
      }
    }
    while (this.running.size < this.concurrency && this.queue.length > 0) {
      const id = this.queue.shift();
      const job = this.jobs.get(id);
      if (!job || job.phase !== 'queued') continue;
      this.startJob(job);
    }
    this.emitState();
  }

  startJob(job) {
    const o = this.opts;
    const caps = this.caps || {};
    const args = FFmpeg.buildArgs({
      src: job.src,
      out: job.part,
      container: job.container,
      srcW: job.srcW,
      srcH: job.srcH,
      // 逐文件算好的输出尺寸与码率（不是全局 opts 里的固定值）
      targetW: job.targetW,
      targetH: job.targetH,
      targetKbps: job.targetKbps,
      videoBitrate: o.videoBitrate,   // targetKbps 为 0 时的回退
      audioBitrate: o.audioBitrate,
      encoder: o.encoder,
      nvencPreset: o.nvencPreset,
      x265Preset: o.x265Preset,
      keepSubtitle: job.keepSubtitle,
      vbv: o.vbv,
      faststart: o.faststart,
      aqStrength: o.aqStrength,
      rcLookahead: o.rcLookahead,
      bref: o.bref,
      support_multipass: caps.support_multipass && o.multipass !== false,
      support_tune_hq: caps.support_tune_hq,
      support_spatial_aq: caps.support_spatial_aq,
      support_lookahead: caps.support_lookahead,
      support_bref: caps.support_bref,
      multipass: o.multipass
    });

    job.phase = 'running';
    job.startedAt = Date.now();
    job.args = args;
    try { fs.mkdirSync(path.dirname(job.part), { recursive: true }); } catch (e) { /* ignore */ }

    const child = spawn(this.ffmpegExe, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    });
    this.running.set(job.id, child);

    let cur = Object.create(null);
    let outBuf = Buffer.alloc(0);
    let errBuf = Buffer.alloc(0);

    // 进度：必须按字节断行再 utf8 解码，避免跨 chunk 的中文被切成半个字符
    child.stdout.on('data', (chunk) => {
      outBuf = Buffer.concat([outBuf, chunk]);
      let idx;
      while ((idx = outBuf.indexOf(0x0A)) >= 0) {
        const line = outBuf.subarray(0, idx).toString('utf8').trim();
        outBuf = outBuf.subarray(idx + 1);
        if (!line) continue;
        const p = line.indexOf('=');
        if (p < 0) continue;
        const k = line.slice(0, p);
        const v = line.slice(p + 1);
        if (k === 'progress') {
          this.applyProgress(job, cur, v === 'end');
        } else {
          cur[k] = v;
        }
      }
    });

    // stderr 必须持续 drain，否则管道缓冲写满会导致 ffmpeg 阻塞挂死
    child.stderr.on('data', (c) => {
      if (errBuf.length < 512 * 1024) errBuf = Buffer.concat([errBuf, c]);
    });

    child.on('error', (e) => {
      this.failJob(job, '进程启动失败: ' + e.message);
    });

    child.on('close', (code) => {
      this.running.delete(job.id);
      const err = errBuf.toString('utf8');
      if (job.phase === 'cancelled') {
        this.cleanupPart(job);
        this.emitState();
        return;
      }
      if (code === 0) {
        // 原子提交
        try {
          if (fs.existsSync(job.out)) fs.unlinkSync(job.out);
          fs.renameSync(job.part, job.out);
          job.outSize = fs.statSync(job.out).size;
          job.phase = 'done';
          job.pct = 100;
          job.endedAt = Date.now();
          this.stats.completedBytes += job.outSize;
          this.emit('job.done', this.dump(job));
        } catch (e) {
          this.failJob(job, '输出提交失败: ' + e.message);
        }
      } else {
        // NVENC 并发会话上限：自动降并发并重排
        if (/OpenEncodeSessionEx failed|out of memory|Generic error in an external library/i.test(err)) {
          const cur2 = this.concurrency;
          if (cur2 > 1 && job.retries < 2) {
            job.retries += 1;
            job.phase = 'queued';
            job.error = null;
            this.cleanupPart(job);
            this.opts.concurrency = cur2 - 1;
            this.queue.unshift(job.id);
            this.emit('queue.state', {
              paused: false,
              reason: `检测到显卡编码会话受限，并发已自动降到 ${this.concurrency}`,
              concurrency: this.concurrency
            });
            setTimeout(() => this.pump(), 1500);
            return;
          }
        }
        this.failJob(job, this.tail(err) || ('ffmpeg 退出码 ' + code));
      }
      this.emitState();
      setTimeout(() => this.pump(), 200);
    });

    this.emit('job.progress', this.dump(job));
  }

  applyProgress(job, cur, isEnd) {
    const us = Number(cur.out_time_us || 0);
    const total = (job.duration || 0) * 1e6;
    if (total > 0) job.pct = Math.min(99.5, (us / total) * 100);
    job.outSec = us / 1e6;
    job.speed = cur.speed || '';
    job.fps = cur.fps || '';
    job.bitrate = cur.bitrate || '';
    const sz = Number(cur.total_size || 0);
    if (sz > 0) job.outSize = sz;
    if (isEnd) job.phase = 'finalizing';
    this.emit('job.progress', this.dump(job));
  }

  failJob(job, msg) {
    job.phase = 'failed';
    job.error = msg;
    job.endedAt = Date.now();
    this.cleanupPart(job);
    this.emit('job.failed', this.dump(job));
  }

  cleanupPart(job) {
    try { if (fs.existsSync(job.part)) fs.unlinkSync(job.part); } catch (e) { /* ignore */ }
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.phase === 'done' || job.phase === 'failed') return false;
    job.phase = 'cancelled';
    job.endedAt = Date.now();
    const child = this.running.get(id);
    if (child) {
      this.running.delete(id);
      try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
    }
    this.cleanupPart(job);
    this.emit('job.cancelled', this.dump(job));
    this.emitState();
    setTimeout(() => this.pump(), 200);
    return true;
  }

  resume() { this.paused = false; this.pump(); }

  tail(s) {
    const lines = String(s || '').trim().split(/\r?\n/).filter(Boolean);
    return lines.slice(-6).join(' | ').slice(0, 800);
  }

  dump(job) {
    const durSec = job.endedAt && job.startedAt ? (job.endedAt - job.startedAt) / 1000
      : job.startedAt ? (Date.now() - job.startedAt) / 1000 : 0;
    return {
      id: job.id, name: job.name, src: job.src, out: job.out,
      srcSize: job.srcSize, outSize: job.outSize, duration: job.duration,
      srcW: job.srcW, srcH: job.srcH,
      targetW: job.targetW, targetH: job.targetH, scaled: job.scaled,
      targetKbps: job.targetKbps, srcKbps: job.srcKbps, srcFps: job.srcFps,
      phase: job.phase, pct: Math.round(job.pct * 10) / 10,
      speed: job.speed, fps: job.fps, bitrate: job.bitrate,
      keepSubtitle: job.keepSubtitle, subSkipped: job.subSkipped,
      error: job.error, elapsedSec: Math.round(durSec),
      args: job.args
    };
  }

  emitState() {
    const all = Array.from(this.jobs.values());
    const done = all.filter(j => j.phase === 'done');
    const fail = all.filter(j => j.phase === 'failed');
    const running = all.filter(j => j.phase === 'running' || j.phase === 'finalizing');
    const queued = all.filter(j => j.phase === 'queued');
    const totalDur = all.reduce((s, j) => s + (j.duration || 0), 0);
    const doneDur = done.reduce((s, j) => s + (j.duration || 0), 0);
    const runningPct = running.reduce((s, j) => s + (j.duration * j.pct / 100), 0);
    const overall = totalDur > 0 ? ((doneDur + runningPct) / totalDur) * 100 : 0;

    const state = {
      total: all.length, done: done.length, failed: fail.length,
      running: running.length, queued: queued.length,
      cancelled: all.filter(j => j.phase === 'cancelled').length,
      paused: this.paused,
      concurrency: this.concurrency,
      sourceBytes: this.stats.sourceBytes,
      completedBytes: this.stats.completedBytes,
      overallPct: Math.round(overall * 10) / 10,
      finished: this.queue.length === 0 && this.running.size === 0 &&
                (running.length === 0) && queued.length === 0
    };
    if (state.finished && all.length > 0 && !this.batchEndedAt) {
      this.batchEndedAt = Date.now();
      state.elapsedSec = Math.round((this.batchEndedAt - this.batchStartedAt) / 1000);
    }
    this.emit('queue.state', state);
    return state;
  }

  snapshot() {
    return {
      jobs: Array.from(this.jobs.values()).map(j => this.dump(j)),
      state: this.emitState()
    };
  }
}

module.exports = TaskManager;
