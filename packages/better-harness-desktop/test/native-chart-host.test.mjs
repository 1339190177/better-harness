import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createNativeChartController } from '../src/native-chart-host.mjs';
import { createNativeChartWorkerRuntime } from '../src/native-chart-worker.mjs';
import { CHANNEL_PREFIX } from '../src/native-chart-protocol.mjs';

const tick = () => new Promise(setImmediate);
function observe(promise) {
  const state = { promise, settled: false, error: undefined };
  promise.then(() => { state.settled = true; }, error => { state.settled = true; state.error = error; });
  return state;
}
const origin = 'http://127.0.0.1:58575';
const openInput = (surfaceId = `chart-${randomUUID()}`) => ({ surfaceId, timestamps: [10, 20], values: [1, 5] });
const frameInput = (sessionId, requestId = 1) => ({ sessionId, requestId, width: 200, height: 100,
  from: 10, to: 20, background: [255, 255, 255], line: [10, 120, 240] });

function setup(t, overrides = {}, { autoReady = true } = {}) {
  const charts = [];
  class Native {
    leases = new Set();
    sequence = 0;
    disposed = false;
    constructor() { charts.push(this); }
    loadSeries(timestamps, values) {
      this.timestamps = timestamps; this.values = values;
      return { rawPoints: timestamps.length, from: timestamps[0], to: timestamps.at(-1), loadMs: 1 };
    }
    stats() { return { backend: 'fake-native' }; }
    resize(width, height) { this.width = width; this.height = height; }
    setViewport() {}
    setColors() {}
    render() {
      const frameId = ++this.sequence; this.leases.add(frameId);
      return { frameId, width: this.width, height: this.height, handle: Buffer.alloc(8), rawPoints: 2,
        visiblePoints: 2, renderedVertices: 2, lodMs: 1, encodeMs: 1, gpuWaitMs: 1, from: 10, to: 20, yMin: 1, yMax: 5 };
    }
    releaseFrame(id) { return this.leases.delete(id); }
    hitTest(timestamp) { return { index: 0, timestamp, value: 1 }; }
    dispose() { assert.equal(this.leases.size, 0); this.disposed = true; }
  }
  class FakeWorker extends EventEmitter {
    runtime = createNativeChartWorkerRuntime({ NativeChart: Native });
    queue = [];
    sent = [];
    held = [];
    paused = new Set();
    holdReplies = new Set();
    terminated = 0;
    unreferenced = false;
    postMessage(message) { this.sent.push(message); this.queue.push(message); queueMicrotask(() => this.flush()); }
    flush() {
      while (this.queue.length && !this.paused.has(this.queue[0].op)) {
        const request = this.queue.shift();
        const message = this.runtime.dispatch(request);
        if (this.holdReplies.has(request.op)) this.held.push({ op: request.op, message });
        else this.emit('message', message);
      }
    }
    resume(op) { this.paused.delete(op); this.flush(); }
    deliver(op) {
      this.holdReplies.delete(op);
      for (const entry of this.held.filter(entry => entry.op === op)) this.emit('message', entry.message);
      this.held = this.held.filter(entry => entry.op !== op);
    }
    terminate() { this.terminated++; this.emit('exit', 0); return Promise.resolve(0); }
    unref() { this.unreferenced = true; }
  }
  const worker = new FakeWorker();
  const handlers = new Map();
  const ipcMain = { handle: (key, callback) => handlers.set(key, callback), removeHandler: key => handlers.delete(key) };
  const imports = [];
  const sent = [];
  const texture = {
    importFailure: false, sendFailure: false, stallSend: false,
    importSharedTexture(options) {
      if (this.importFailure) throw new Error('private import details');
      const imported = { options, releases: 0, release() { this.releases++; } };
      imports.push(imported); return imported;
    },
    sendSharedTexture(options, metrics) {
      sent.push({ options, metrics });
      if (this.sendThrows) throw new Error('private send details');
      if (this.sendFailure) return Promise.reject(new Error('private send details'));
      if (this.stallSend) return new Promise(resolve => { this.resolveSend = resolve; });
      return Promise.resolve();
    },
  };
  let workerCount = 0;
  let workerOptions;
  const controller = createNativeChartController({ ipcMain, sharedTexture: texture,
    addonPath: resolve('trusted/harness-chart-runtime.node'), platform: 'darwin', drainTimeoutMs: 25,
    requestTimeoutMs: 300, createWorker(_url, options) {
      workerCount++; workerOptions = options;
      if (autoReady) queueMicrotask(() => worker.emit('message', { type: 'ready', available: true }));
      return worker;
    }, ...overrides });
  const wc = new EventEmitter();
  wc.id = 7;
  wc.mainFrame = { url: `${origin}/?shell=desktop`, parent: null };
  wc.getURL = () => wc.mainFrame.url;
  wc.isDestroyed = () => false;
  wc.messages = [];
  wc.send = (...args) => wc.messages.push(args);
  controller.attach({ webContents: wc }, origin);
  const event = () => ({ sender: wc, senderFrame: wc.mainFrame });
  const call = (name, ...args) => handlers.get(`${CHANNEL_PREFIX}${name}`)(event(), ...args);
  const allrefs = (index = imports.length - 1) => imports[index].options.allReferencesReleased();
  t.after(async () => {
    for (const imported of imports) imported.options.allReferencesReleased();
    worker.paused.clear(); worker.holdReplies.clear(); worker.flush();
    for (const entry of worker.held.splice(0)) worker.emit('message', entry.message);
    texture.resolveSend?.();
    await controller.stop();
  });
  return { controller, worker, charts, handlers, wc, event, call, texture, imports, sent, allrefs,
    workerCount: () => workerCount, workerOptions: () => workerOptions };
}

test('鉴权先于 worker 创建：sender、子 frame、origin、路径、凭据及参数数量', async t => {
  const h = setup(t);
  const cap = h.handlers.get(`${CHANNEL_PREFIX}capabilities`);
  for (const event of [{ sender: { id: 7 }, senderFrame: h.wc.mainFrame },
    { sender: h.wc, senderFrame: { ...h.wc.mainFrame } }, { sender: h.wc, senderFrame: null }]) {
    await assert.rejects(cap(event), /UNAUTHORIZED/);
  }
  for (const url of [`${origin}/api`, 'http://127.0.0.1:9999/', `${origin}/%2f`, 'file:///tmp/chart',
    'http://u:p@127.0.0.1:58575/']) {
    h.wc.mainFrame.url = url;
    await assert.rejects(h.call('capabilities'), /UNAUTHORIZED/);
  }
  h.wc.mainFrame.url = `${origin}/?shell=desktop#sessions`;
  h.wc.mainFrame.parent = {};
  await assert.rejects(h.call('capabilities'), /UNAUTHORIZED/);
  h.wc.mainFrame.parent = null;
  await assert.rejects(h.call('capabilities', {}), /INVALID_INPUT/);
  await assert.rejects(h.call('open', { ...openInput(), addonPath: '/evil.node' }), /INVALID_INPUT/);
  assert.equal(h.workerCount(), 0);
  assert.deepEqual(await h.call('capabilities'), { version: 1, available: true });
  assert.equal(h.workerCount(), 1);
  assert.equal(h.workerOptions().workerData.addonPath, resolve('trusted/harness-chart-runtime.node'));
});

test('不支持的平台和缺失 sharedTexture 明确返回 false，不创建线程', async t => {
  for (const override of [{ platform: 'win32' }, { platform: 'linux' }, { sharedTexture: undefined }, { addonPath: undefined }]) {
    const h = setup(t, override);
    assert.equal((await h.call('capabilities')).available, false);
    await assert.rejects(h.call('open', openInput()), /UNAVAILABLE/);
    assert.equal(h.workerCount(), 0);
  }
});

test('三槽满时只排队一个请求，main 和 allrefs 释放均不能代替 worker ACK', async t => {
  const h = setup(t);
  const { sessionId } = await h.call('open', openInput());
  for (let request = 1; request <= 3; request++) await h.call('render', frameInput(sessionId, request));
  assert.equal(h.imports[0].releases, 1);
  assert.equal(h.charts[0].leases.size, 3);
  assert.equal(h.sent[0].metrics.handle, undefined);
  assert.equal(h.sent[0].metrics.sessionId, sessionId);
  assert.ok(Buffer.isBuffer(h.imports[0].options.textureInfo.handle.ioSurface));
  const rendering = observe(h.call('render', frameInput(sessionId, 4)));
  assert.equal(h.controller.diagnostics().sessions[0].busy, true);
  assert.equal(h.controller.diagnostics().sessions[0].lastRequestId, 4);
  await assert.rejects(h.call('render', frameInput(sessionId, 5)), { code: 'REQUEST_BUSY' });
  await tick();
  assert.equal(rendering.settled, false);
  assert.equal(h.worker.sent.filter(message => message.op === 'render').length, 3);
  assert.equal(h.worker.sent.filter(message => message.op === 'release').length, 0);
  h.worker.holdReplies.add('release');
  h.allrefs(0); await tick();
  assert.equal(h.charts[0].leases.size, 2);
  assert.equal(h.controller.diagnostics().sessions[0].leases.length, 3);
  assert.equal(rendering.settled, false);
  assert.equal(h.imports.length, 3);
  assert.equal(h.worker.sent.filter(message => message.op === 'render').length, 3);
  h.worker.deliver('release');
  await rendering.promise;
  h.allrefs(0); await tick();
  assert.equal(h.worker.sent.filter(message => message.op === 'release').length, 1);
  assert.equal(h.worker.sent.filter(message => message.op === 'render').length, 4);
  assert.equal(h.charts[0].leases.size, 3);
  await assert.rejects(h.call('render', frameInput(sessionId, 4)), { code: 'STALE_REQUEST' });
  assert.equal(h.controller.diagnostics().released, 1);
  assert.equal(h.controller.diagnostics().sessions[0].busy, false);
  assert.equal(h.wc.messages.length, 0);
  assert.equal(JSON.stringify(h.controller.diagnostics()).includes('handle'), false);
});

test('有空槽但释放中也等待 ACK，先验证请求 ID，连续交互不报错', async t => {
  const h = setup(t);
  const { sessionId } = await h.call('open', openInput());
  await h.call('render', frameInput(sessionId));
  for (let requestId = 2; requestId <= 5; requestId++) {
    h.worker.holdReplies.add('release');
    h.allrefs(); await tick();
    assert.equal(h.charts[0].leases.size, 0);
    await assert.rejects(h.call('render', frameInput(sessionId, NaN)), { code: 'INVALID_INPUT' });
    await assert.rejects(h.call('render', frameInput(sessionId, requestId - 1)), { code: 'STALE_REQUEST' });
    assert.equal(h.controller.diagnostics().sessions[0].busy, false);
    assert.equal(h.controller.diagnostics().sessions[0].lastRequestId, requestId - 1);
    const rendering = observe(h.call('render', frameInput(sessionId, requestId)));
    assert.equal(h.controller.diagnostics().sessions[0].busy, true);
    assert.equal(h.controller.diagnostics().sessions[0].lastRequestId, requestId);
    await assert.rejects(h.call('render', frameInput(sessionId, requestId + 1)), { code: 'REQUEST_BUSY' });
    await tick();
    assert.equal(rendering.settled, false);
    assert.equal(h.worker.sent.filter(request => request.op === 'render').length, requestId - 1);
    h.worker.deliver('release');
    await rendering.promise;
    assert.equal(h.charts[0].leases.size, 1);
    assert.equal(h.controller.diagnostics().sessions[0].busy, false);
  }
  assert.equal(h.wc.messages.length, 0);
  assert.equal((await h.call('capabilities')).available, true);
});

test('三槽全被外部引用时等待有界，超时不归还租约或禁用功能', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = setup(t, { requestTimeoutMs: 20 });
  const { sessionId } = await h.call('open', openInput());
  for (let id = 1; id <= 3; id++) await h.call('render', frameInput(sessionId, id));
  const rendering = observe(h.call('render', frameInput(sessionId, 4)));
  t.mock.timers.tick(19); await tick();
  assert.equal(rendering.settled, false);
  t.mock.timers.tick(1); await tick();
  assert.equal(rendering.error?.code, 'SURFACE_TIMEOUT');
  assert.match(rendering.error.message, /释放确认超时/);
  assert.equal(h.controller.diagnostics().sessions[0].busy, false);
  assert.equal(h.controller.diagnostics().sessions[0].leases.length, 3);
  assert.equal(h.charts[0].leases.size, 3);
  assert.equal(h.worker.sent.filter(message => message.op === 'release').length, 0);
  assert.equal(h.worker.sent.filter(message => message.op === 'render').length, 3);
  assert.equal(h.wc.messages.length, 0);
  assert.equal((await h.call('capabilities')).available, true);
  await assert.rejects(h.call('render', frameInput(sessionId, 4)), { code: 'STALE_REQUEST' });
  h.allrefs(0); await tick();
  await h.call('render', frameInput(sessionId, 5));
  assert.equal(h.sent.at(-1).metrics.requestId, 5);
});

test('部分 ACK 不唤醒也不重置截止时间；超时后未 ACK 的槽仍不可复用', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = setup(t, { requestTimeoutMs: 20 });
  const { sessionId } = await h.call('open', openInput());
  for (let id = 1; id <= 3; id++) await h.call('render', frameInput(sessionId, id));
  const rendering = observe(h.call('render', frameInput(sessionId, 4)));
  t.mock.timers.tick(5);
  h.worker.holdReplies.add('release');
  h.allrefs(0); h.allrefs(1); await tick();
  assert.equal(h.charts[0].leases.size, 1);
  t.mock.timers.tick(5);
  h.worker.emit('message', h.worker.held.shift().message); await tick();
  assert.equal(h.controller.diagnostics().sessions[0].leases.length, 2);
  assert.equal(rendering.settled, false);
  t.mock.timers.tick(9); await tick();
  assert.equal(rendering.settled, false);
  t.mock.timers.tick(1); await tick();
  assert.equal(rendering.error?.code, 'SURFACE_TIMEOUT');
  assert.equal(h.controller.diagnostics().sessions[0].busy, false);
  assert.equal(h.controller.diagnostics().sessions[0].leases.length, 2);
  assert.equal(h.controller.diagnostics().awaitingReplies, 1);
  assert.equal(h.controller.diagnostics().released, 1);
  assert.equal((await h.call('capabilities')).available, true);
  await assert.rejects(h.call('render', frameInput(sessionId, 4)), { code: 'STALE_REQUEST' });
  const retry = observe(h.call('render', frameInput(sessionId, 5)));
  await tick();
  assert.equal(retry.settled, false);
  assert.equal(h.worker.sent.filter(message => message.op === 'render').length, 3);
  h.worker.deliver('release');
  await retry.promise;
  assert.equal(h.charts[0].leases.size, 2);
  assert.equal(h.controller.diagnostics().released, 2);
  assert.equal(h.sent.at(-1).metrics.requestId, 5);
  t.mock.timers.tick(100); await tick();
  assert.equal(h.wc.messages.length, 0);
  assert.equal((await h.call('capabilities')).available, true);
});

test('ACK 唤醒与另一 allrefs 同轮发生时重新等 ACK，但不延长原截止时间', async t => {
  for (const outcome of ['ack', 'timeout']) await t.test(outcome, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = setup(t, { requestTimeoutMs: 20 });
    const { sessionId } = await h.call('open', openInput());
    for (let id = 1; id <= 3; id++) await h.call('render', frameInput(sessionId, id));
    const rendering = observe(h.call('render', frameInput(sessionId, 4)));
    t.mock.timers.tick(5);
    h.worker.holdReplies.add('release');
    h.allrefs(0); await tick();
    t.mock.timers.tick(5);
    h.worker.emit('message', h.worker.held.shift().message);
    h.allrefs(1); await tick();
    assert.equal(rendering.settled, false);
    assert.equal(h.controller.diagnostics().sessions[0].busy, true);
    assert.equal(h.controller.diagnostics().sessions[0].leases.length, 2);
    assert.equal(h.worker.sent.filter(message => message.op === 'render').length, 3);
    t.mock.timers.tick(9); await tick();
    assert.equal(rendering.settled, false);
    if (outcome === 'ack') {
      h.worker.deliver('release');
      await rendering.promise;
      assert.equal(h.sent.at(-1).metrics.requestId, 4);
      assert.equal(h.charts[0].leases.size, 2);
    } else {
      t.mock.timers.tick(1); await tick();
      assert.equal(rendering.error?.code, 'SURFACE_TIMEOUT');
      assert.equal(h.controller.diagnostics().sessions[0].leases.length, 2);
      h.worker.deliver('release'); await tick();
      assert.equal(h.worker.sent.filter(message => message.op === 'render').length, 3);
    }
    t.mock.timers.tick(100); await tick();
    assert.equal(h.controller.diagnostics().sessions[0].busy, false);
    assert.equal((await h.call('capabilities')).available, true);
    assert.equal(h.wc.messages.length, 0);
  });
});

test('等待隔离到原会话，其他会话渲染和 ACK 不会错误唤醒', async t => {
  const h = setup(t);
  const a = await h.call('open', openInput());
  const b = await h.call('open', openInput());
  await h.call('render', frameInput(a.sessionId));
  h.worker.holdReplies.add('release');
  h.allrefs(0); await tick();
  const rendering = observe(h.call('render', frameInput(a.sessionId, 2)));
  await h.call('render', frameInput(b.sessionId));
  assert.equal((await h.call('hitTest', { sessionId: a.sessionId, timestamp: 10 })).value, 1);
  h.allrefs(1); await tick();
  h.worker.emit('message', h.worker.held.pop().message); await tick();
  assert.equal(rendering.settled, false);
  assert.equal(h.controller.diagnostics().sessions.find(s => s.sessionId === a.sessionId).busy, true);
  assert.equal(h.controller.diagnostics().sessions.find(s => s.sessionId === b.sessionId).leases.length, 0);
  h.worker.deliver('release');
  await rendering.promise;
  assert.equal(h.worker.sent.filter(message => message.op === 'render').length, 3);
});

test('close 立即拒绝池满或释放等待者，ACK 与 close 同轮到达也不发送 render', async t => {
  for (const mode of ['full', 'releasing', 'ack-before-close']) {
    const h = setup(t);
    const { sessionId } = await h.call('open', openInput());
    const count = mode === 'full' ? 3 : 1;
    for (let id = 1; id <= count; id++) await h.call('render', frameInput(sessionId, id));
    h.worker.holdReplies.add('release');
    if (mode !== 'full') { h.allrefs(0); await tick(); }
    const rendering = observe(h.call('render', frameInput(sessionId, count + 1)));
    if (mode === 'ack-before-close') h.worker.deliver('release');
    const closing = h.call('close', sessionId);
    await tick();
    assert.equal(rendering.error?.code, 'CLOSED');
    assert.equal(h.worker.sent.filter(message => message.op === 'render').length, count);
    assert.equal(h.imports.length, count);
    if (mode !== 'ack-before-close') {
      assert.equal(h.controller.diagnostics().sessions[0].busy, false);
      assert.equal(h.controller.diagnostics().sessions[0].leases.length, count);
    }
    if (mode === 'full') {
      for (let index = 0; index < count; index++) h.allrefs(index);
      await tick();
    }
    h.worker.deliver('release');
    await closing;
    assert.equal(h.controller.diagnostics().sessions.length, 0);
    assert.equal(h.wc.messages.length, 0);
  }
});

test('stop 和导航立即取消 ACK 等待，迟到回执只排空原会话', async t => {
  for (const action of ['stop', 'navigation']) {
    const h = setup(t);
    const { sessionId } = await h.call('open', openInput());
    await h.call('render', frameInput(sessionId));
    h.worker.holdReplies.add('release');
    h.allrefs(); await tick();
    const rendering = observe(h.call('render', frameInput(sessionId, 2)));
    let stopping;
    if (action === 'stop') stopping = h.controller.stop();
    else h.wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    await tick();
    assert.equal(rendering.error?.code, 'CLOSED');
    assert.equal(h.controller.diagnostics().sessions[0].busy, false);
    assert.equal(h.controller.diagnostics().sessions[0].leases.length, 1);
    assert.equal(h.worker.terminated, 0);
    h.worker.deliver('release'); await tick();
    if (stopping) await stopping;
    assert.equal(h.controller.diagnostics().sessions.length, 0);
    assert.equal(h.worker.sent.filter(message => message.op === 'render').length, 1);
    assert.equal(h.worker.terminated, action === 'stop' ? 1 : 0);
  }
});

test('release RPC 超时唤醒等待者但保留 pending reply，迟到 ACK 前 stop 不终止线程', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = setup(t, { requestTimeoutMs: 20 });
  const { sessionId } = await h.call('open', openInput());
  await h.call('render', frameInput(sessionId));
  h.worker.holdReplies.add('release');
  h.allrefs(); await tick();
  t.mock.timers.tick(1);
  const rendering = observe(h.call('render', frameInput(sessionId, 2)));
  t.mock.timers.tick(19); await tick();
  assert.equal(rendering.error?.code, 'CLOSED');
  assert.equal(h.controller.diagnostics().sessions[0].busy, false);
  assert.equal(h.controller.diagnostics().sessions[0].leases.length, 1);
  assert.equal(h.controller.diagnostics().awaitingReplies, 1);
  assert.equal(h.controller.diagnostics().pendingRequests, 0);
  assert.equal(h.controller.diagnostics().released, 0);
  assert.match((await h.call('capabilities')).reason, /REQUEST_TIMEOUT/);
  const stopping = h.controller.stop();
  t.mock.timers.tick(25); await stopping;
  assert.equal(h.worker.terminated, 0);
  h.worker.deliver('release'); await tick();
  assert.equal(h.controller.diagnostics().sessions.length, 0);
  assert.equal(h.controller.diagnostics().awaitingReplies, 0);
  assert.equal(h.controller.diagnostics().released, 1);
  assert.equal(h.worker.terminated, 1);
  assert.equal(h.workerCount(), 1);
  assert.equal(h.worker.sent.filter(message => message.op === 'render').length, 1);
});

test('两个会话共享唯一 worker，重复 surface 和含排空的会话池拒绝超额', async t => {
  const h = setup(t);
  const input = openInput();
  const a = await h.call('open', input);
  await assert.rejects(h.call('open', input), /DUPLICATE_SURFACE/);
  await h.call('render', frameInput(a.sessionId));
  const closing = h.call('close', a.sessionId);
  await h.call('open', input);
  await assert.rejects(h.call('open', openInput()), /SESSION_BUSY/);
  assert.equal(h.controller.diagnostics().sessions.length, 2);
  h.allrefs(0);
  await closing;
  await h.call('open', openInput());
  assert.equal(h.workerCount(), 1);
});

test('异步 render 单在途；close 拒旧请求，迟到 native 帧直接释放且不导入', async t => {
  const h = setup(t);
  const a = await h.call('open', openInput());
  h.worker.paused.add('render');
  const rendering = h.call('render', frameInput(a.sessionId));
  const rejected = assert.rejects(rendering, /CLOSED/);
  await assert.rejects(h.call('render', frameInput(a.sessionId, 2)), /REQUEST_BUSY/);
  const closing = h.call('close', a.sessionId);
  await rejected;
  assert.equal(h.charts[0].disposed, false);
  h.worker.resume('render');
  await closing;
  assert.equal(h.imports.length, 0);
  assert.equal(h.controller.diagnostics().lateFrames, 1);
  assert.equal(h.charts[0].disposed, true);
});

test('非 hash 导航排空，旧 frame 无权限，新文档能重新 open', async t => {
  const h = setup(t);
  const input = openInput();
  const a = await h.call('open', input);
  h.wc.emit('did-start-navigation', {}, `${origin}/#next`, true, true);
  await h.call('render', frameInput(a.sessionId));
  h.wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  assert.equal(h.controller.diagnostics().sessions[0].closing, false);
  const oldEvent = h.event();
  h.wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  await assert.rejects(h.call('capabilities'), /UNAUTHORIZED/);
  h.wc.mainFrame = { url: `${origin}/?shell=desktop`, parent: null };
  h.wc.emit('did-navigate');
  await assert.rejects(h.handlers.get(`${CHANNEL_PREFIX}close`)(oldEvent, a.sessionId), /UNAUTHORIZED/);
  const b = await h.call('open', input);
  await h.call('render', frameInput(b.sessionId));
  h.allrefs(0); await tick();
  assert.equal(h.charts[0].disposed, true);
  assert.equal(h.charts[1].leases.size, 1);
  assert.equal(h.controller.diagnostics().sessions[0].sessionId, b.sessionId);
});

test('导航取消仍在加载的数据会话，不把旧 open 结果带入新文档', async t => {
  const h = setup(t);
  await h.call('capabilities');
  h.worker.paused.add('open');
  const opening = h.call('open', openInput());
  const rejected = assert.rejects(opening, /CLOSED/);
  await tick();
  h.wc.emit('did-start-navigation', {}, `${origin}/`, false, true);
  await rejected;
  h.worker.resume('open'); await tick();
  assert.equal(h.charts[0].disposed, true);
  assert.equal(h.controller.diagnostics().sessions.length, 0);
});

test('import 失败可请求归还但仍等 ACK；send 同步或异步失败必须先等 allrefs', async t => {
  for (const failure of ['importFailure', 'sendFailure', 'sendThrows']) {
    const h = setup(t);
    const a = await h.call('open', openInput());
    h.worker.paused.add('release');
    h.worker.holdReplies.add('release');
    h.texture[failure] = true;
    await assert.rejects(h.call('render', frameInput(a.sessionId)), /TEXTURE_FAILURE/);
    await tick();
    assert.equal(h.charts[0].leases.size, 1);
    assert.equal(h.charts[0].disposed, false);
    assert.equal(h.controller.diagnostics().released, 0);
    if (failure === 'importFailure') assert.equal(h.imports.length, 0);
    else {
      assert.equal(h.imports[0].releases, 1);
      assert.equal(h.worker.sent.filter(message => message.op === 'release').length, 0);
      assert.equal(h.controller.diagnostics().sessions[0].leases[0].phase, 'external');
      h.allrefs(); await tick();
    }
    assert.equal(h.worker.sent.filter(message => message.op === 'release').length, 1);
    assert.equal(h.controller.diagnostics().sessions[0].leases[0].phase, 'releasing');
    h.worker.resume('release'); await tick();
    assert.equal(h.charts[0].disposed, true);
    assert.equal(h.controller.diagnostics().sessions[0].leases.length, 1);
    assert.equal(h.controller.diagnostics().released, 0);
    h.worker.deliver('release'); await tick();
    assert.equal(h.controller.diagnostics().released, 1);
    assert.equal(h.controller.diagnostics().sessions.length, 0);
    assert.equal((await h.call('capabilities')).available, false);
    assert.equal(h.wc.messages.some(([, payload]) => payload.message.includes('private')), false);
  }
});

test('render 超时拒所有 pending，保留迟到帧和释放 ack，线程不替换', async t => {
  const h = setup(t, { requestTimeoutMs: 20 });
  const a = await h.call('open', openInput());
  h.worker.paused.add('render');
  const rendering = assert.rejects(h.call('render', frameInput(a.sessionId)), /REQUEST_TIMEOUT/);
  const querying = assert.rejects(h.call('hitTest', { sessionId: a.sessionId, timestamp: 10 }), /REQUEST_TIMEOUT/);
  await Promise.all([rendering, querying]);
  assert.equal((await h.call('capabilities')).available, false);
  h.worker.resume('render'); await tick();
  assert.equal(h.charts[0].disposed, true);
  assert.equal(h.controller.diagnostics().awaitingReplies, 0);
  assert.equal(h.controller.diagnostics().lateFrames, 1);
  assert.equal(h.workerCount(), 1);
});

test('close 超时保留外部租约；stop 有界且不能 terminate，迟到 allrefs 后才退出线程', async t => {
  const h = setup(t);
  const a = await h.call('open', openInput());
  await h.call('render', frameInput(a.sessionId));
  await assert.rejects(h.call('close', a.sessionId), /DRAIN_TIMEOUT/);
  const stopping = h.controller.stop();
  assert.equal(stopping, h.controller.stop());
  await stopping;
  assert.equal(h.worker.terminated, 0);
  assert.equal(h.worker.unreferenced, true);
  assert.equal(h.charts[0].disposed, false);
  assert.equal(h.handlers.size, 0);
  h.allrefs(); await tick();
  assert.equal(h.charts[0].disposed, true);
  assert.equal(h.worker.terminated, 1);
});

test('发送超时仍释放 main 引用并保留外部租约，晚完成不再改写会话', async t => {
  const h = setup(t, { requestTimeoutMs: 20 });
  const a = await h.call('open', openInput());
  h.texture.stallSend = true;
  await assert.rejects(h.call('render', frameInput(a.sessionId)), /REQUEST_TIMEOUT/);
  assert.equal(h.imports[0].releases, 1);
  assert.equal(h.charts[0].disposed, false);
  h.texture.resolveSend();
  h.allrefs(); await tick();
  assert.equal(h.charts[0].disposed, true);
});

test('worker error 和 exit 拒 pending 并禁用功能，不使 Desktop 退出或复用资源', async t => {
  for (const event of ['error', 'exit']) {
    const h = setup(t);
    const a = await h.call('open', openInput());
    for (let id = 1; id <= 3; id++) await h.call('render', frameInput(a.sessionId, id));
    const rendering = observe(h.call('render', frameInput(a.sessionId, 4)));
    h.worker.paused.add('hitTest');
    const querying = assert.rejects(h.call('hitTest', { sessionId: a.sessionId, timestamp: 12 }), /WORKER_/);
    h.worker.emit(event, event === 'error' ? new Error('private worker failure') : 1);
    await querying; await tick();
    assert.equal(rendering.error?.code, 'CLOSED');
    assert.equal(h.controller.diagnostics().sessions[0].busy, false);
    assert.equal(h.controller.diagnostics().sessions[0].leases.length, 3);
    assert.equal(h.worker.sent.filter(message => message.op === 'render').length, 3);
    assert.equal((await h.call('capabilities')).available, false);
    await h.controller.stop();
    assert.equal(h.worker.terminated, 0);
    assert.equal(h.workerCount(), 1);
    assert.equal(h.charts[0].disposed, false);
  }
});

test('IPC 对各操作做完整白名单验证，不把多余路径或非法值送入 worker', async t => {
  const h = setup(t);
  const a = await h.call('open', openInput());
  const before = h.worker.sent.length;
  for (const patch of [{ path: '/tmp/series' }, { handle: Buffer.alloc(8) }, { width: 4000, height: 2001 },
    { requestId: -1 }, { line: [1, 2, 300] }, { from: NaN }]) {
    await assert.rejects(h.call('render', { ...frameInput(a.sessionId), ...patch }), /INVALID_INPUT/);
  }
  await assert.rejects(h.call('hitTest', { sessionId: a.sessionId, timestamp: 10, path: '/tmp/data' }), /INVALID_INPUT/);
  await assert.rejects(h.call('hitTest', { sessionId: a.sessionId, timestamp: Infinity }), /INVALID_INPUT/);
  await assert.rejects(h.call('close', { sessionId: a.sessionId }), /INVALID_INPUT/);
  assert.equal(h.worker.sent.length, before);
  h.wc.getURL = () => `${origin}/api`;
  await assert.rejects(h.call('capabilities'), /UNAUTHORIZED/);
});

test('open 在 host 拒绝递减及差值溢出的时间戳，不启动 worker 或使已有会话 fault', async t => {
  const h = setup(t);
  const invalid = [[20, 10], [10, 12, 11, 20], [-Number.MAX_VALUE, Number.MAX_VALUE],
    [-Number.MAX_VALUE, 0, Number.MAX_VALUE], [10, NaN], [10, Infinity], [-Infinity, 10]];
  for (const timestamps of invalid) {
    await assert.rejects(h.call('open', { ...openInput(), timestamps, values: timestamps.map(() => 1) }), { code: 'INVALID_INPUT' });
  }
  assert.equal(h.workerCount(), 0);
  const a = await h.call('open', openInput());
  const before = h.worker.sent.length;
  for (const timestamps of invalid) {
    await assert.rejects(h.call('open', { ...openInput(), timestamps, values: timestamps.map(() => 1) }), { code: 'INVALID_INPUT' });
  }
  assert.equal(h.worker.sent.length, before);
  assert.equal(h.charts.length, 1);
  assert.equal(h.worker.runtime.diagnostics().faulted, false);
  assert.equal((await h.call('capabilities')).available, true);
  await h.call('render', frameInput(a.sessionId));
  assert.equal(h.wc.messages.length, 0);
});

test('open 接受非递减重复时间戳、单点及有限差值边界并原样传给 worker', async t => {
  const h = setup(t);
  for (const timestamps of [[10, 12, 12, 20], [10, 10], [Number.MAX_VALUE],
    [-Number.MAX_VALUE, 0], [0, Number.MAX_VALUE], [-10, -5, -5]]) {
    const input = { ...openInput(), timestamps, values: timestamps.map((_, i) => i) };
    const opened = await h.call('open', input);
    assert.equal(opened.from, timestamps[0]);
    assert.equal(opened.to, timestamps.at(-1));
    assert.equal(opened.rawPoints, timestamps.length);
    assert.deepEqual(h.charts.at(-1).timestamps, timestamps);
    assert.deepEqual(h.charts.at(-1).values, input.values);
    await h.call('close', opened.sessionId);
  }
  assert.equal((await h.call('capabilities')).available, true);
  assert.equal(h.wc.messages.length, 0);
});

test('默认能力探测共用一次初始化，超过 GPU 的 5s 后仍可在 host 10s 内成功', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = setup(t, { requestTimeoutMs: undefined }, { autoReady: false });
  const opening = observe(h.call('open', openInput()));
  const probes = [observe(h.call('capabilities')), observe(h.call('capabilities'))];
  t.mock.timers.tick(5000); await tick();
  assert.equal(opening.settled, false);
  assert.ok(probes.every(probe => !probe.settled));
  assert.equal(h.worker.sent.length, 0);
  t.mock.timers.tick(4999); await tick();
  assert.ok(probes.every(probe => !probe.settled));
  h.worker.emit('message', { type: 'ready', available: true });
  assert.ok((await Promise.all(probes.map(probe => probe.promise))).every(result => result.available));
  await opening.promise;
  t.mock.timers.tick(1); await tick();
  assert.equal((await h.call('capabilities')).available, true);
  assert.equal(h.workerCount(), 1);
  assert.equal(h.wc.messages.length, 0);
});

test('默认能力探测到 10s 才超时，晚到 ready 不能恢复已停用功能', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = setup(t, { requestTimeoutMs: undefined }, { autoReady: false });
  const opening = observe(h.call('open', openInput()));
  const probe = observe(h.call('capabilities'));
  t.mock.timers.tick(9999); await tick();
  assert.equal(probe.settled, false);
  assert.equal(opening.settled, false);
  t.mock.timers.tick(1); await tick();
  assert.equal(opening.error?.code, 'UNAVAILABLE');
  const result = await probe.promise;
  assert.equal(result.available, false);
  assert.match(result.reason, /REQUEST_TIMEOUT/);
  h.worker.emit('message', { type: 'ready', available: true });
  assert.equal((await h.call('capabilities')).available, false);
  assert.equal(h.workerCount(), 1);
  assert.equal(h.worker.sent.length, 0);
});

test('默认 render RPC 容忍 5s GPU 等待与开销，但到 10s 仍超时并保留迟到帧回执', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = setup(t, { requestTimeoutMs: undefined });
  const { sessionId } = await h.call('open', openInput());
  h.worker.holdReplies.add('render');
  const first = observe(h.call('render', frameInput(sessionId)));
  await tick();
  t.mock.timers.tick(5000); await tick();
  assert.equal(first.settled, false);
  assert.equal((await h.call('capabilities')).available, true);
  t.mock.timers.tick(4999); await tick();
  assert.equal(first.settled, false);
  h.worker.deliver('render');
  await first.promise;
  t.mock.timers.tick(1); await tick();
  assert.equal((await h.call('capabilities')).available, true);
  assert.equal(h.wc.messages.length, 0);
  h.allrefs(); await tick();
  h.worker.holdReplies.add('render');
  const second = observe(h.call('render', frameInput(sessionId, 2)));
  await tick();
  t.mock.timers.tick(9999); await tick();
  assert.equal(second.settled, false);
  t.mock.timers.tick(1); await tick();
  assert.equal(second.error?.code, 'REQUEST_TIMEOUT');
  assert.equal(h.controller.diagnostics().awaitingReplies, 1);
  assert.equal(h.charts[0].disposed, false);
  h.worker.deliver('render'); await tick();
  assert.equal(h.controller.diagnostics().awaitingReplies, 0);
  assert.equal(h.controller.diagnostics().lateFrames, 1);
  assert.equal(h.charts[0].disposed, true);
  assert.equal(h.imports.length, 1);
  assert.equal((await h.call('capabilities')).available, false);
});

test('启动失败、超时和 worker error 结束所有能力探测，不泄露装载路径', async t => {
  for (const mode of ['unavailable', 'timeout', 'error']) {
    const worker = new EventEmitter();
    worker.unref = () => {};
    worker.terminate = async () => worker.emit('exit', 0);
    const h = setup(t, { requestTimeoutMs: 15, createWorker() {
      if (mode === 'unavailable') queueMicrotask(() => worker.emit('message', { type: 'ready', available: false, reason: '/private/addon.node' }));
      if (mode === 'error') queueMicrotask(() => worker.emit('error', new Error('/private/addon.node')));
      return worker;
    } });
    const opening = assert.rejects(h.call('open', openInput()), /UNAVAILABLE/);
    const results = await Promise.all([h.call('capabilities'), h.call('capabilities')]);
    await opening;
    assert.ok(results.every(result => result.available === false));
    assert.ok(results.every(result => !result.reason.includes('/private/')));
  }
});

test('stop 等待迟到 native 输出，不在 native render 尚未回复时终止线程', async t => {
  const h = setup(t);
  const a = await h.call('open', openInput());
  h.worker.paused.add('render');
  const rendered = assert.rejects(h.call('render', frameInput(a.sessionId)), /CLOSED/);
  await h.controller.stop();
  await rendered;
  assert.equal(h.worker.terminated, 0);
  h.worker.resume('render'); await tick();
  assert.equal(h.imports.length, 0);
  assert.equal(h.charts[0].disposed, true);
  assert.equal(h.worker.terminated, 1);
});

test('renderer 崩溃后可导航重建，destroyed 自动 detach 并移除监听', async t => {
  const h = setup(t);
  await h.call('open', openInput());
  h.wc.emit('render-process-gone'); await tick();
  assert.equal(h.charts[0].disposed, true);
  await assert.rejects(h.call('capabilities'), /UNAUTHORIZED/);
  h.wc.emit('did-navigate');
  await h.call('open', openInput());
  h.wc.emit('destroyed'); await tick();
  assert.equal(h.controller.diagnostics().attachedWindows, 0);
  assert.equal(h.wc.listenerCount('did-start-navigation'), 0);
  assert.equal(h.charts[1].disposed, true);
});
