import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { CHANNEL_PREFIX, LIMITS, chartError, sessionId, validateOpen as validateOpenProtocol, validateRender,
  validateHitTest, frameMetrics } from './native-chart-protocol.mjs';

function validateOpen(input) {
  validateOpenProtocol(input);
  const { timestamps } = input;
  for (let i = 1; i < timestamps.length; i++) {
    if (timestamps[i] < timestamps[i - 1]) throw chartError('INVALID_INPUT', '时间戳必须非递减');
  }
  if (!Number.isFinite(timestamps[timestamps.length - 1] - timestamps[0])) {
    throw chartError('INVALID_INPUT', '时间戳范围差值必须有限');
  }
  return input;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function bounded(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(chartError('DRAIN_TIMEOUT', '图表仍在安全排空')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

/** Electron 对象全部注入；可选线程工厂与时限只供 host 测试，页面不能设置。 */
export function createNativeChartController({ ipcMain, sharedTexture, addonPath, platform = process.platform,
  createWorker = (url, options) => new Worker(url, options), requestTimeoutMs = 10_000, drainTimeoutMs = 2000 }) {
  const windows = new Map();
  const sessions = new Map();
  const pending = new Map();
  const transfers = new Set();
  const channels = [];
  let worker;
  let workerState = 'idle';
  let exited = false;
  let stopping = false;
  let stopPromise;
  let termination;
  let sequence = 0;
  let ready;
  let readyTimer;
  let reason = platform !== 'darwin' ? 'UNSUPPORTED_PLATFORM: 当前平台不支持原生共享图表'
    : typeof sharedTexture?.importSharedTexture !== 'function' || typeof sharedTexture?.sendSharedTexture !== 'function'
      ? 'SHARED_TEXTURE_UNAVAILABLE: 当前 Electron 不支持共享纹理'
      : typeof addonPath !== 'string' || !isAbsolute(addonPath) ? 'NATIVE_UNAVAILABLE: 未配置可信原生运行时' : undefined;
  const counters = { framesReceived: 0, imported: 0, mainReleased: 0, allReferencesReleased: 0, released: 0, lateFrames: 0 };

  function capabilitiesResult() {
    const available = !reason && !stopping && workerState === 'ready';
    return { version: 1, available, ...(!available ? { reason: reason ?? 'STOPPED: 图表控制器已关闭' } : {}) };
  }

  function finishRequest(request, error, value) {
    if (request.settled) return;
    request.settled = true;
    clearTimeout(request.timer);
    if (error) request.reject(error); else request.resolve(value);
  }

  function notify(session, message) {
    const owner = session.owner;
    if (windows.get(owner.wc.id) !== owner || owner.epoch !== session.epoch || owner.suspended || owner.wc.isDestroyed()) return;
    try { owner.wc.send(`${CHANNEL_PREFIX}error`, { sessionId: session.id, surfaceId: session.surfaceId, message }); }
    catch { /* renderer 已消失时仅保留 host 诊断。 */ }
  }

  function fail(error) {
    if (!reason) reason = error.message;
    if (!exited) workerState = 'failed';
    clearTimeout(readyTimer);
    ready?.resolve(false);
    for (const request of pending.values()) finishRequest(request, error);
    for (const transfer of [...transfers]) transfer.reject(error);
    for (const session of sessions.values()) {
      notify(session, reason);
      beginClose(session);
    }
  }

  function maybeTerminate() {
    // 有未知回复、原生租约或外部引用时绝不 terminate，也绝不另建 worker。
    if (!stopping || !worker || exited || termination || sessions.size || pending.size) return termination;
    workerState = 'stopping';
    try { termination = Promise.resolve(worker.terminate()).catch(() => undefined); }
    catch { termination = Promise.resolve(); }
    return termination;
  }

  function finalize(session) {
    if (!session.closing || !session.closedAck || session.busy || session.leases.size) return;
    if (sessions.get(session.id) !== session) return;
    sessions.delete(session.id);
    session.closed.resolve();
    maybeTerminate();
  }

  function rpc(op, session, input, onResult) {
    if (!worker || exited) return Promise.reject(chartError('WORKER_EXITED', '原生图表线程已经退出'));
    if (!['close', 'release'].includes(op) && pending.size >= 32) {
      return Promise.reject(chartError('REQUEST_BUSY', '图表请求队列已满'));
    }
    const result = deferred();
    const id = ++sequence;
    const request = { ...result, id, op, session, onResult, settled: false };
    pending.set(id, request);
    request.timer = setTimeout(() => fail(chartError('REQUEST_TIMEOUT', '原生图表请求超时，功能已停用')), requestTimeoutMs);
    try { worker.postMessage({ id, op, sessionId: session?.id, input }); }
    catch {
      pending.delete(id);
      const error = chartError('WORKER_FAILURE', '无法发送原生图表请求');
      finishRequest(request, error);
      fail(error);
    }
    return result.promise;
  }

  function onMessage(message) {
    if (message?.type === 'ready') {
      clearTimeout(readyTimer);
      if (!reason && !stopping) {
        if (message.available === true) workerState = 'ready';
        else {
          workerState = 'unavailable';
          reason = 'NATIVE_UNAVAILABLE: 原生运行时无法装载、GPU 初始化失败或接口不兼容';
        }
      }
      ready?.resolve(!reason && !stopping);
      return;
    }
    const request = pending.get(message?.id);
    if (!request) return;
    pending.delete(request.id);
    clearTimeout(request.timer);
    if (message.ok !== true) {
      const code = ['INVALID_INPUT', 'NOT_FOUND', 'CLOSED', 'UNAVAILABLE', 'SESSION_BUSY', 'SURFACE_BUSY',
        'STALE_REQUEST', 'DUPLICATE_SESSION', 'UNKNOWN_LEASE'].includes(message.error) ? message.error : 'NATIVE_FAILURE';
      const error = chartError(code, '原生图表操作失败');
      finishRequest(request, error);
      if (message.fatal || code === 'NATIVE_FAILURE') fail(error);
    } else {
      try {
        const value = request.onResult ? request.onResult(message.result, request.settled) : message.result;
        finishRequest(request, undefined, value);
      } catch {
        const error = chartError('NATIVE_FAILURE', '原生图表响应或租约无效');
        finishRequest(request, error);
        fail(error);
      }
    }
    maybeTerminate();
  }

  async function ensureReady() {
    if (reason || stopping) return false;
    if (ready) return ready.promise;
    ready = deferred();
    workerState = 'starting';
    try {
      worker = createWorker(new URL('./native-chart-worker.mjs', import.meta.url), {
        workerData: { kind: 'harness-native-chart-v1', addonPath, platform },
      });
      worker.on('message', onMessage);
      worker.on('error', () => fail(chartError('WORKER_FAILURE', '原生图表线程发生错误')));
      worker.on('exit', () => {
        exited = true;
        workerState = 'exited';
        if (!stopping || sessions.size || pending.size) fail(chartError('WORKER_EXITED', '原生图表线程意外退出'));
        clearTimeout(readyTimer);
        ready.resolve(false);
      });
      readyTimer = setTimeout(() => fail(chartError('REQUEST_TIMEOUT', '原生图表线程启动超时')), requestTimeoutMs);
    } catch { fail(chartError('WORKER_FAILURE', '无法创建原生图表线程')); }
    return ready.promise;
  }

  function surfaceAvailable(session) {
    // 即使尚有空槽，释放确认到达前也不让 native 自行挑选刚刚归还的槽。
    return session.leases.size < LIMITS.surfaces && ![...session.leases.values()].some(lease => lease.releasing);
  }

  function wakeAvailability(session, error) {
    const waiter = session.availability;
    if (!waiter || (!error && !surfaceAvailable(session))) return;
    if (error) {
      waiter.error = error;
      waiter.signal.reject(error);
    } else waiter.signal.resolve();
  }

  function waitAvailability(session) {
    if (surfaceAvailable(session)) return;
    // busy 已在入口锁定；每会话只登记一个等待者，不轮询、不重置截止时间。
    const waiter = { signal: deferred() };
    session.availability = waiter;
    waiter.timer = setTimeout(() => wakeAvailability(session, chartError('SURFACE_TIMEOUT',
      '等待输出纹理释放确认超时，未确认的租约仍保留，请稍后重试')), requestTimeoutMs);
    return waiter;
  }

  function releaseLease(lease, allReferencesReleased = false) {
    if (lease.releasing) return;
    lease.releasing = true;
    lease.phase = 'releasing';
    if (allReferencesReleased) counters.allReferencesReleased++;
    // 闭包捕获原 session，绝不通过 surfaceId 查找可能已经重建的图表。
    const session = lease.session;
    void rpc('release', session, { frameId: lease.frameId }, result => {
      if (result?.released !== true) throw new Error('missing release acknowledgement');
      session.leases.delete(lease.frameId);
      counters.released++;
      if (result.closed) session.closedAck = true;
      wakeAvailability(session);
      finalize(session);
    }).catch(() => { /* 超时后的回执仍由 onMessage 处理；没有回执就保留租约。 */ });
  }

  function beginClose(session) {
    if (session.closing) return session.closed.promise;
    session.closing = true;
    const error = chartError('CLOSED', '图表会话已关闭');
    wakeAvailability(session, error);
    for (const request of pending.values()) {
      if (request.session === session && !['close', 'release'].includes(request.op)) finishRequest(request, error);
    }
    for (const transfer of [...transfers]) if (transfer.session === session) transfer.reject(error);
    void rpc('close', session, undefined, result => {
      if (result?.closed === true) session.closedAck = true;
      finalize(session);
    }).catch(() => { /* 无关闭确认的会话继续计入池容量。 */ });
    return session.closed.promise;
  }

  function validDocument(url, origin) {
    try {
      const parsed = new URL(url);
      return parsed.origin === origin && parsed.pathname === '/' && !parsed.username && !parsed.password;
    } catch { return false; }
  }

  function authorize(event) {
    const owner = windows.get(event.sender?.id);
    if (stopping || !owner || owner.suspended || owner.wc !== event.sender || owner.wc.isDestroyed()
      || !event.senderFrame || event.senderFrame !== owner.wc.mainFrame || event.senderFrame.parent
      || !validDocument(event.senderFrame.url, owner.origin) || !validDocument(owner.wc.getURL(), owner.origin)) {
      throw chartError('UNAUTHORIZED', '仅允许已附着的 Studio 入口主文档访问图表');
    }
    return owner;
  }

  function requireSession(owner, id, closingAllowed = false) {
    const session = sessions.get(sessionId(id));
    if (!session || session.owner !== owner || session.epoch !== owner.epoch) throw chartError('NOT_FOUND', '图表会话不属于当前文档');
    if (!closingAllowed && (session.closing || reason)) throw chartError('CLOSED', '图表会话不可用');
    return session;
  }

  function waitTransfer(session, promise) {
    const result = deferred();
    const transfer = { session, reject: error => settle(error) };
    const timer = setTimeout(() => fail(chartError('REQUEST_TIMEOUT', '共享纹理传递超时')), requestTimeoutMs);
    function settle(error) {
      if (!transfers.delete(transfer)) return;
      clearTimeout(timer);
      if (error) result.reject(error); else result.resolve();
    }
    transfers.add(transfer);
    Promise.resolve(promise).then(() => settle(), error => settle(error));
    return result.promise;
  }

  async function render(owner, event, input) {
    validateRender(input);
    const session = requireSession(owner, input.sessionId);
    if (session.busy) throw chartError('REQUEST_BUSY', '每个会话仅允许一个渲染请求在途');
    if (input.requestId <= session.lastRequestId) throw chartError('STALE_REQUEST', '请求编号必须严格递增');
    session.busy = true;
    session.lastRequestId = input.requestId;
    let lease, imported;
    try {
      const availability = waitAvailability(session);
      if (availability) {
        try {
          do {
            await availability.signal.promise;
            if (availability.error) throw availability.error;
            // 唤醒后可能又有 allrefs 发起释放；仅等下次 ACK，保留原计时器。
            availability.signal = deferred();
          } while (!surfaceAvailable(session));
        } finally {
          clearTimeout(availability.timer);
          session.availability = undefined;
        }
      }
      // ACK 唤醒后、异步续体执行前仍可能关闭会话或发生线程故障。
      if (session.closing || reason || stopping) throw chartError('CLOSED', '图表会话已经失效');
      const output = await rpc('render', session, input, (frame, stale) => {
        if (!Number.isSafeInteger(frame?.frameId) || session.leases.has(frame.frameId)) throw new Error('invalid lease');
        const current = { session, frameId: frame.frameId, phase: 'native', releasing: false };
        session.leases.set(frame.frameId, current);
        counters.framesReceived++;
        if (stale || session.closing || reason || stopping) {
          counters.lateFrames++;
          releaseLease(current);
          return undefined;
        }
        try {
          const metrics = frameMetrics(frame);
          if (!(frame.handle instanceof Uint8Array) || frame.handle.byteLength !== 8) throw new Error('invalid handle');
          return { lease: current, metrics, handle: Buffer.from(frame.handle) };
        } catch (error) { releaseLease(current); throw error; }
      });
      if (!output) throw chartError('CLOSED', '图表会话已经失效');
      lease = output.lease;
      if (session.closing || reason || stopping) throw chartError('CLOSED', '图表会话已经失效');
      imported = sharedTexture.importSharedTexture({
        textureInfo: { pixelFormat: 'bgra', codedSize: { width: output.metrics.width, height: output.metrics.height },
          handle: { ioSurface: output.handle }, timestamp: Math.round(performance.now() * 1000) },
        allReferencesReleased: () => releaseLease(lease, true),
      });
      lease.phase = 'external';
      counters.imported++;
      await waitTransfer(session, sharedTexture.sendSharedTexture({ frame: event.senderFrame, importedSharedTexture: imported }, {
        ...output.metrics, sessionId: session.id, surfaceId: session.surfaceId, requestId: input.requestId,
      }));
      if (session.closing) throw chartError('CLOSED', '图表会话已经失效');
    } catch (error) {
      if (!['CLOSED', 'REQUEST_BUSY', 'SURFACE_BUSY', 'SURFACE_TIMEOUT', 'STALE_REQUEST'].includes(error.code)) {
        const safe = chartError(error.code === 'REQUEST_TIMEOUT' ? 'REQUEST_TIMEOUT' : 'TEXTURE_FAILURE', '原生图表帧未能完成传递');
        fail(safe);
        throw safe;
      }
      throw error;
    } finally {
      try {
        if (imported) {
          try { imported.release(); counters.mainReleased++; }
          catch { fail(chartError('TEXTURE_FAILURE', '共享纹理主引用释放失败')); }
        } else if (lease) releaseLease(lease);
      } finally { session.busy = false; finalize(session); }
    }
  }

  function handle(name, arity, action) {
    const channel = `${CHANNEL_PREFIX}${name}`;
    channels.push(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      const owner = authorize(event);
      if (args.length !== arity) throw chartError('INVALID_INPUT', '图表调用参数数量无效');
      return action(owner, event, ...args);
    });
  }

  handle('capabilities', 0, async () => { await ensureReady(); return capabilitiesResult(); });
  handle('open', 1, async (owner, event, input) => {
    validateOpen(input);
    const epoch = owner.epoch;
    if (!await ensureReady()) throw chartError('UNAVAILABLE', reason ?? '原生图表不可用');
    if (authorize(event) !== owner || owner.epoch !== epoch) throw chartError('CLOSED', '文档已经导航');
    if (sessions.size >= LIMITS.sessions) throw chartError('SESSION_BUSY', '两个会话仍在使用或排空');
    if ([...sessions.values()].some(session => session.owner === owner && session.epoch === epoch
      && session.surfaceId === input.surfaceId && !session.closing)) throw chartError('DUPLICATE_SURFACE', '画布已经有活动会话');
    const session = { id: randomUUID(), owner, epoch, surfaceId: input.surfaceId, busy: false, queryBusy: false,
      lastRequestId: 0, closing: false, closedAck: false, closed: deferred(), leases: new Map() };
    sessions.set(session.id, session);
    try {
      const result = await rpc('open', session, input);
      if (session.closing) throw chartError('CLOSED', '文档或会话已关闭');
      return { sessionId: session.id, rawPoints: result.rawPoints, from: result.from,
        to: result.to, loadMs: result.loadMs, backend: result.backend };
    } catch (error) { beginClose(session); throw error; }
  });
  handle('render', 1, render);
  handle('hitTest', 1, async (owner, _event, input) => {
    validateHitTest(input);
    const session = requireSession(owner, input.sessionId);
    if (session.queryBusy) throw chartError('REQUEST_BUSY', '已有原始样本查询在途');
    session.queryBusy = true;
    try {
      const hit = await rpc('hitTest', session, input);
      return { index: hit.index, timestamp: hit.timestamp, value: hit.value };
    } finally { session.queryBusy = false; }
  });
  handle('close', 1, async (owner, _event, id) => {
    sessionId(id);
    if (!sessions.has(id)) return;
    const session = requireSession(owner, id, true);
    try { await bounded(beginClose(session), drainTimeoutMs); }
    catch (error) { fail(error); throw error; }
  });

  function removeListeners(owner) {
    for (const [name, listener] of owner.listeners) owner.wc.removeListener(name, listener);
  }

  function drainOwner(owner) {
    owner.epoch++;
    owner.suspended = true;
    return Promise.all([...sessions.values()].filter(session => session.owner === owner).map(beginClose));
  }

  function attach(window, origin) {
    if (stopping) throw chartError('CLOSED', '图表控制器已关闭');
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || !validDocument(origin, parsed.origin)) {
      throw chartError('INVALID_ORIGIN', 'Studio 地址必须是无凭据的服务根');
    }
    const wc = window.webContents;
    if (windows.has(wc.id)) throw chartError('DUPLICATE_WINDOW', '窗口已经附着');
    const owner = { wc, origin: parsed.origin, epoch: 0, suspended: false, listeners: [] };
    function listen(name, listener) { owner.listeners.push([name, listener]); wc.on(name, listener); }
    listen('did-start-navigation', (details, _url, isInPlace, isMainFrame) => {
      const main = details.isMainFrame ?? isMainFrame;
      const sameDocument = details.isSameDocument ?? details.isInPlace ?? isInPlace;
      if (main && !sameDocument) void drainOwner(owner);
    });
    listen('did-navigate', () => { owner.suspended = false; });
    listen('render-process-gone', () => { void drainOwner(owner); });
    listen('destroyed', () => { void detach(wc.id); });
    windows.set(wc.id, owner);
  }

  async function detach(webContentsId) {
    const owner = windows.get(webContentsId);
    if (!owner) return;
    windows.delete(webContentsId);
    removeListeners(owner);
    await bounded(drainOwner(owner), drainTimeoutMs).catch(() => undefined);
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    clearTimeout(readyTimer);
    ready?.resolve(false);
    for (const channel of channels) ipcMain.removeHandler(channel);
    for (const owner of windows.values()) { removeListeners(owner); owner.suspended = true; }
    windows.clear();
    stopPromise = bounded(Promise.all([...sessions.values()].map(beginClose)).then(() => maybeTerminate()), drainTimeoutMs)
      .catch(() => undefined).finally(() => {
        // 保留回执监听；最终进程退出交给 OS 回收，不能为退出速度制造悬垂指针。
        worker?.unref();
      });
    return stopPromise;
  }

  function diagnostics() {
    return { version: 1, ...capabilitiesResult(), workerState, stopping, attachedWindows: windows.size,
      pendingRequests: [...pending.values()].filter(request => !request.settled).length,
      awaitingReplies: pending.size, transfers: transfers.size, ...counters,
      sessions: [...sessions.values()].map(session => ({ sessionId: session.id, surfaceId: session.surfaceId,
        webContentsId: session.owner.wc.id, closing: session.closing, closedAck: session.closedAck,
        busy: session.busy, lastRequestId: session.lastRequestId,
        leases: [...session.leases.values()].map(lease => ({ frameId: lease.frameId, phase: lease.phase })),
      })) };
  }

  return { attach, detach, stop, diagnostics };
}
