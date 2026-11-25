'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const FFmpeg = require('./ffmpeg');
const Paths = require('./paths');
const Bitrate = require('./bitrate');
const Estimate = require('./estimate');

let SEQ = 1;

/** 源字幕语言。und/unk 和空值都不写进成品，避免编造「简体中文」。 */
function subLangOf(v) {
  const lang = String(v || '').trim().toLowerCase();
  if (!/^[a-z]{2,3}$/.test(lang) || lang === 'und' || lang === 'unk') return '';
  return lang;
}

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
    // 谁按下的暂停：'user' 手动 / 'disk' 磁盘看护 / null 未暂停。
    // 分开记是为了「点继续」时不要顺手把磁盘保护也解掉。
    this.pausedBy = null;
    this.notice = '';            // 一次性提示（并发自动降级等）
    this.stopped = false;        // 本批是否被「停止」中断，前端据此区分「完成 / 已停止」
    this.batchStartedAt = 0;
    this.batchEndedAt = 0;
    this.diskGuard = null;
    // 本批实际写入的目录。磁盘看卫要看它，而不是配置里的 outputRoot——
    // 同级输出/手选目录很可能在另一块盘上。
    this.currentOutDir = '';
    this.onEnd = null;           // 任务落终态时的回调（落盘历史用）
    this.batchId = '';           // 本批标识，用来「只恢复最后一批」
    this.stats = { completedBytes: 0, sourceBytes: 0 };
  }

  configure({ ffmpegExe, emit, caps }) {
    this.ffmpegExe = ffmpegExe;
    this.emit = emit || (() => {});
    if (caps) this.caps = caps;
  }

  setDiskGuard(fn) { this.diskGuard = fn; }
  setOnEnd(fn) { this.onEnd = fn; }

  /** 任务落到终态时通知外部（写历史）。失败不能影响主流程，且只记一次。 */
  fireEnd(job) {
    if (!this.onEnd || job._endFired) return;
    job._endFired = true;
    try { this.onEnd(job); } catch (e) { /* ignore */ }
  }

  /**
   * 用历史记录恢复工作台。只填 jobs，不进队列——
   * 重启后不该自动继续跑，但用户应该看得到上次压了什么。
   */
  restore(list) {
    if (!list || !list.length) return 0;
    let n = 0, minStart = 0, maxEnd = 0, srcBytes = 0, doneBytes = 0;
    for (const r of list) {
      if (!r || !r.id || this.jobs.has(r.id)) continue;
      const job = {
        id: r.id,
        name: r.name || '',
        src: r.src || '',
        out: r.out || '',
        part: (r.out || '') + '.part',
        srcSize: r.srcSize || 0,
        duration: r.duration || 0,
        srcDuration: r.srcDuration || r.duration || 0,
        preview: !!r.preview,
        limitSec: r.limitSec || 0,
        srcW: r.srcW || 0, srcH: r.srcH || 0,
        targetW: r.targetW || 0, targetH: r.targetH || 0,
        scaled: !!r.scaled,
        srcKbps: r.srcKbps || 0, targetKbps: r.targetKbps || 0,
        srcFps: r.srcFps || 0,
        container: r.container || '',
        keepSubtitle: !!r.keepSubtitle, subSkipped: !!r.subSkipped,
        phase: r.phase || 'done',
        skipped: !!r.skipped, renamedFrom: r.renamedFrom || null, note: r.note || '',
        pct: (r.phase === 'done' || r.skipped) ? 100 : 0,
        speed: '', fps: '', bitrate: '',
        // 预估秒数一起恢复：刷新页面接上进度时，剩余时间不用重新"估算中…"
        estSec: r.estSec || 0,
        outSize: r.outSize || 0, outSec: r.outSec || 0,
        startedAt: r.startedAt || 0, endedAt: r.endedAt || 0,
        error: r.error || null, retries: 0,
        restored: true,
        o: {}
      };
      if (job.preview) { /* 试压记录照样恢复，但会在界面上标记 */ }
      this.jobs.set(job.id, job);
      n++;
      srcBytes += job.srcSize;
      if (job.phase === 'done') doneBytes += job.outSize;
      if (job.startedAt && (!minStart || job.startedAt < minStart)) minStart = job.startedAt;
      if (job.endedAt > maxEnd) maxEnd = job.endedAt;
      const seq = Number(String(r.id).replace(/^j/, ''));
      if (seq >= SEQ) SEQ = seq + 1;
    }
    this.batchStartedAt = minStart || Date.now();
    this.batchEndedAt = maxEnd || Date.now();
    this.stats = { completedBytes: doneBytes, sourceBytes: srcBytes };
    return n;
  }

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
    this.currentOutDir = opts.outDir || '';
    this.batchId = 'b' + Date.now() + '-' + SEQ;
    this.stats = { completedBytes: 0, sourceBytes: 0 };
    return this._build(files, opts);
  }

  /**
   * 往当前队列后面追加任务（试压用），不清空已经有的一批。
   * 每个 job 都带一份 opts 快照，所以追加进来的任务可以用不同参数，
   * 不会影响正在跑的那批。
   */
  addJobs(files, opts) {
    if (!this.jobs.size) return this.createJobs(files, opts);
    this.opts = Object.assign({}, this.opts, opts);
    this.batchEndedAt = 0;
    this.stopped = false;
    if (!this.batchStartedAt) this.batchStartedAt = Date.now();
    if (opts.outDir) this.currentOutDir = opts.outDir;
    return this._build(files, opts);
  }

  _build(files, opts) {
    for (const f of files) {
      // 输出路径由 server 统一解析（同名策略、批次内去重都在那里做），
      // 这里只兜底，别再自己算一遍导致两边不一致。
      const out = f.out || Paths.outputFileFor(f.file, opts.outDir, opts.suffix || '', f.rel || '');
      const skipped = !!f.skipped;
      const limitSec = Number(opts.limitSec) || 0;

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

      // 试压只处理前 N 秒，进度分母也要按 N 秒算，否则永远到不了 100%
      const dur = limitSec
        ? Math.min(f.duration || limitSec, limitSec)
        : (f.duration || 0);

      const job = {
        id: 'j' + (SEQ++),
        name: f.name,
        // 递归扫描来的文件带相对路径，队列里据此显示「子目录 / 文件名」，
        // 否则两集都叫 01.mp4 时根本分不清谁是谁
        rel: f.rel || '',
        src: f.file,
        out,
        batch: this.batchId,
        part: out + '.part',
        srcSize: f.size || 0,
        duration: dur,
        srcDuration: f.duration || 0,
        preview: !!opts.preview,
        limitSec,
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
        subtitleIndex: (Number.isFinite(Number(f.subtitleIndex)) && Number(f.subtitleIndex) >= 0)
          ? Math.round(Number(f.subtitleIndex)) : 0,
        subtitleLang: subLangOf(f.subtitleLang),
        phase: skipped ? 'done' : 'queued',
        skipped,
        renamedFrom: f.renamedFrom || null,
        note: skipped
          ? (f.reason || '输出文件已存在，已跳过')
          : (f.renamedFrom ? '输出名已被占用，已改名为 ' + path.basename(out) : ''),
        pct: skipped ? 100 : 0,
        speed: '', fps: '', bitrate: '', outSize: 0, outSec: 0,
        startedAt: 0, endedAt: skipped ? Date.now() : 0, error: null, retries: 0,
        // 该任务独占跑完大约要多久：前端据此在开压那一刻就算出剩余时间和完成时刻。
        // 用像素吞吐换算，不按文件体积——体积随码率变化，工作量并不随体积走。
        estSec: skipped ? 0 : Estimate.jobSeconds({
          duration: dur,
          srcW: plan.srcW, srcH: plan.srcH,
          targetW: plan.outW, targetH: plan.outH,
          srcFps: Number(f.video && f.video.fps) || 0,
          o: { encoder: opts.encoder, multipass: opts.multipass }
        }),
        // 每个任务自己的参数快照：追加的试压任务不能覆盖正在跑那批的设置
        o: Object.assign({}, opts)
      };
      this.jobs.set(job.id, job);
      if (!skipped) this.queue.push(job.id);
      else this.fireEnd(job);
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
    this.pausedBy = null;
    this.notice = '';
    this.stopped = false;
    this.batchStartedAt = 0;
    this.batchEndedAt = 0;
    this.currentOutDir = '';
    this.batchId = '';
    this.stats = { completedBytes: 0, sourceBytes: 0 };
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
      const g = this.diskGuard(this.currentOutDir);
      if (g && !g.enough) {
        this.paused = true;
        this.pausedBy = 'disk';
        this.notice = '磁盘空间不足，已暂停派发';
        this.emitState();
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
    const o = job.o || this.opts;
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
      subtitleIndex: job.subtitleIndex,
      subtitleLang: job.subtitleLang,
      vbv: o.vbv,
      faststart: o.faststart,
      // 试压片段：只输出前 N 秒
      limitSec: job.limitSec || o.limitSec || 0,
      aqStrength: o.aqStrength,
      rcLookahead: o.rcLookahead,
      bref: o.bref,
      // 第一次让帧留在显卡上；CUDA / scale_cuda 失败后 _gpuFallback 改走软件解码
      gpuFrames: !job._gpuFallback,
      support_scale_cuda: !!caps.scale_cuda,
      support_multipass: caps.support_multipass && o.multipass !== false && o.multipass !== 'false',
      support_tune_hq: caps.support_tune_hq,
      support_spatial_aq: caps.support_spatial_aq,
      support_lookahead: caps.support_lookahead,
      support_bref: caps.support_bref,
      multipass: o.multipass
    });

    job.phase = 'running';
    job.startedAt = Date.now();
    job.args = args;
    job._usedGpu = args.indexOf('-hwaccel_output_format') >= 0;
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
      if (job._cancelRequested || job.phase === 'cancelled') return;
      this.failJob(job, '进程启动失败: ' + e.message);
    });

    child.on('close', (code) => {
      this.running.delete(job.id);
      const err = errBuf.toString('utf8');
      if (job._cancelRequested || job.phase === 'cancelled') {
        this.cleanupPart(job);
        this.fireEnd(job);
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
          // 用这一条的真实耗时校准吞吐，后面排队任务的预估会跟着变准
          Estimate.observe(job);
          this.refreshEstimates();
          this.emit('job.done', this.dump(job));
          this.fireEnd(job);
        } catch (e) {
          this.failJob(job, '输出提交失败: ' + e.message);
        }
      } else if (/OpenEncodeSessionEx failed/i.test(err)) {
        // 只有这句才是「编码会话已满」。Generic error / out of memory
        // 也是坏片、驱动、像素格式的常见收场，不能据此把并发永久减掉。
        const cur2 = this.concurrency;
        if (cur2 > 1 && job.retries < 2) {
          job.retries += 1;
          job.phase = 'queued';
          job.error = null;
          this.cleanupPart(job);
          this.opts.concurrency = cur2 - 1;
          this.queue.unshift(job.id);
          this.notice = `检测到显卡编码会话受限，并发已自动降到 ${this.concurrency}`;
          this.emitState();
          setTimeout(() => { this.notice = ''; }, 10000);
          setTimeout(() => this.pump(), 1500);
          return;
        }
        this.failJob(job, this.tail(err) || ('ffmpeg 退出码 ' + code));
      } else if (job._usedGpu && !job._gpuFallback && this.gpuPipelineFailed(err)) {
        job._gpuFallback = true;
        job.phase = 'queued';
        job.pct = 0;
        job.speed = '';
        job.fps = '';
        job.bitrate = '';
        job.outSec = 0;
        job.outSize = 0;
        job.error = null;
        this.cleanupPart(job);
        this.notice = '显卡解码或缩放不可用，这一条改用 CPU 缩放';
        this.emitState();
        setTimeout(() => { this.notice = ''; }, 10000);
        this.startJob(job);
        return;
      } else {
        this.failJob(job, this.tail(err) || ('ffmpeg 退出码 ' + code));
      }
      this.emitState();
      setTimeout(() => this.pump(), 200);
    });

    this.emit('job.progress', this.dump(job));
  }

  /** CUDA 解码或 scale_cuda 失败。编码器自己的报错不在这里，避免无谓地再跑一遍。 */
  gpuPipelineFailed(err) {
    return /scale_cuda|\bhwaccel\b|cuvid|nvcuvid|nvcuda|Impossible to convert|No CUDA capable|Cannot load cuda|auto_scale|hwdownload|Function not implemented|Unsupported hwaccel|\bcuda\b/i.test(String(err || ''));
  }

  applyProgress(job, cur, isEnd) {
    // 取消后 ffmpeg 管道里可能还有一段残留 stdout（progress=end/out_time_us）。
    // 若照常处理会把 phase 从 cancelled 改回 finalizing，close 回调那句
    // `phase === 'cancelled'` 就不成立，任务反而被判成 failed（"退出码 null"）。
    // 用一次性标志挡住：已请求取消的任务，进度事件一律丢弃。
    if (job._cancelRequested || job.phase === 'cancelled') return;
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
    this.fireEnd(job);
  }

  cleanupPart(job) {
    try { if (fs.existsSync(job.part)) fs.unlinkSync(job.part); } catch (e) { /* ignore */ }
  }

  /**
   * 吞吐刚被实测校正过，重算还在排队那些任务的预估。
   * 不重算的话，一集跑完只会让"整体速度"变准，后面每一集的 estSec 仍是最初那个偏乐观的值。
   * 变化的幅度小于 0.6 秒就不推了，免得给前端刷一堆无意义的帧。
   */
  refreshEstimates() {
    for (const j of this.jobs.values()) {
      if (j.phase !== 'queued' || j.skipped) continue;
      const next = Estimate.jobSeconds(j);
      if (Math.abs(next - (j.estSec || 0)) < 0.6) continue;
      j.estSec = next;
      this.emit('job.progress', this.dump(j));
    }
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.phase === 'done' || job.phase === 'failed' || job.phase === 'cancelled') return false;
    // 一次性标志：进程被 kill 后 stdout/close 还会陆续到达，phase 可能被
    // applyProgress 之类改写。用独立标志记住"用户确实取消了它"，收尾时认标志不认 phase。
    job._cancelRequested = true;
    job.phase = 'cancelled';
    job.endedAt = Date.now();
    // 排队中的任务要从队列里摘掉：一是防止 pump 再把它派发出去，
    // 二是 emitState 用 queue.length 判 finished，留着会一直显示"没结束"。
    const qi = this.queue.indexOf(id);
    if (qi >= 0) this.queue.splice(qi, 1);
    const child = this.running.get(id);
    if (child) {
      this.running.delete(id);
      try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
    }
    this.cleanupPart(job);
    this.emit('job.cancelled', this.dump(job));
    this.fireEnd(job);
    this.emitState();
    setTimeout(() => this.pump(), 200);
    return true;
  }

  /**
   * 暂停派发。已经在跑的 ffmpeg 不会被打断——队列不再派新任务，
   * 手上这几个跑完自然停住。Windows 下没有安全的子进程挂起手段，
   * 而「别再开新的」也正是点暂停时想要的效果。
   */
  pause(by) {
    this.paused = true;
    this.pausedBy = by === 'disk' ? 'disk' : 'user';
    this.notice = '';
    this.emitState();
    return true;
  }

  resume() {
    this.paused = false;
    this.pausedBy = null;
    this.notice = '';
    this.pump();               // 磁盘仍不足时 pump 会自己再暂停一次
    return true;
  }

  /** 整批停止：排队中的直接作废，跑着的杀掉并清掉 .part */
  stopAll() {
    let n = 0;
    for (const job of Array.from(this.jobs.values())) {
      if (job.phase === 'queued') {
        job.phase = 'cancelled';
        job.endedAt = Date.now();
        job.error = '已停止';
        this.emit('job.cancelled', this.dump(job));
        this.fireEnd(job);
        n++;
      } else if (job.phase === 'running' || job.phase === 'finalizing') {
        if (this.cancel(job.id)) n++;
      }
    }
    this.queue = [];
    this.paused = false;
    this.pausedBy = null;
    this.notice = '';
    this.stopped = true;
    this.emitState();
    return n;
  }

  /** 取单个任务的对外快照（取消接口要把终态立刻回给前端，不能等 SSE） */
  getJob(id) {
    const j = this.jobs.get(id);
    return j ? this.dump(j) : null;
  }

  /** 还有没有未落地的任务（排队 / 转码 / 收尾） */
  activeCount() {
    let n = 0;
    for (const j of this.jobs.values()) {
      const p = j.phase;
      if (p === 'queued' || p === 'running' || p === 'finalizing') n++;
    }
    return n;
  }

  tail(s) {
    const lines = String(s || '').trim().split(/\r?\n/).filter(Boolean);
    return lines.slice(-6).join(' | ').slice(0, 800);
  }

  dump(job) {
    const durSec = job.endedAt && job.startedAt ? (job.endedAt - job.startedAt) / 1000
      : job.startedAt ? (Date.now() - job.startedAt) / 1000 : 0;
    return {
      id: job.id, name: job.name, rel: job.rel || '',
      src: job.src, out: job.out, batch: job.batch || '',
      restored: !!job.restored,
      srcSize: job.srcSize, outSize: job.outSize, duration: job.duration,
      srcW: job.srcW, srcH: job.srcH,
      targetW: job.targetW, targetH: job.targetH, scaled: job.scaled,
      targetKbps: job.targetKbps, srcKbps: job.srcKbps, srcFps: job.srcFps,
      phase: job.phase, pct: Math.round(job.pct * 10) / 10,
      speed: job.speed, fps: job.fps, bitrate: job.bitrate,
      keepSubtitle: job.keepSubtitle, subSkipped: job.subSkipped,
      skipped: !!job.skipped, renamedFrom: job.renamedFrom || null, note: job.note || '',
      preview: !!job.preview, limitSec: job.limitSec || 0, srcDuration: job.srcDuration || 0,
      estSec: Math.round(job.estSec || 0),
      // 已处理到第几秒：行内「约剩」要用它算，不然永远按全片长估
      outSec: Math.round((job.outSec || 0) * 10) / 10,
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
      skipped: all.filter(j => j.skipped).length,
      paused: this.paused,
      pausedBy: this.pausedBy,
      notice: this.notice || '',
      stopped: this.stopped,
      concurrency: this.concurrency,
      sourceBytes: this.stats.sourceBytes,
      completedBytes: this.stats.completedBytes,
      overallPct: Math.round(overall * 10) / 10,
      finished: this.queue.length === 0 && this.running.size === 0 &&
                (running.length === 0) && queued.length === 0
    };
    if (state.finished && all.length > 0) {
      // batchEndedAt 只在这批第一次结束时落定，之后每帧都复用它——
      // 否则刷新页面拿到的快照里没有 elapsedSec，总耗时会显示成 0。
      if (!this.batchEndedAt) this.batchEndedAt = Date.now();
      state.elapsedSec = Math.round((this.batchEndedAt - this.batchStartedAt) / 1000);
      state.endedAt = this.batchEndedAt;
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
