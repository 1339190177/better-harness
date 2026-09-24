import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createNativeChartWorkerRuntime } from '../src/native-chart-worker.mjs';
import { validateOpen, validateRender, validateHitTest, LIMITS } from '../src/native-chart-protocol.mjs';

const ids = [1, 2, 3].map(n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const openInput = (n = 0) => ({ surfaceId: `chart-${ids[n]}`, timestamps: [10, 12, 12], values: [2, 8, 4] });
const renderInput = (requestId = 1, n = 0) => ({ sessionId: ids[n], width: 200, height: 100,
  from: 10, to: 12, background: [255, 255, 255], line: [0, 120, 255], requestId });

function setup({ failRender = false, failLoad = false } = {}) {
  const instances = [];
  class Native {
    leases = new Set();
    sequence = 0;
    disposed = false;
    constructor() { instances.push(this); }
    loadSeries(timestamps, values) {
      if (failLoad) throw new Error('/private/addon/path');
      this.timestamps = timestamps; this.values = values;
      return { rawPoints: values.length, from: 10, to: 12, loadMs: 0.5 };
    }
    stats() { return { backend: 'fake-native', inFlight: this.leases.size }; }
    resize(width, height) { this.width = width; this.height = height; }
    setViewport(from, to) { this.from = from; this.to = to; }
    setColors(background, line) { this.background = background; this.line = line; }
    render() {
      if (failRender) throw new Error('GPU wait timeout');
      const frameId = ++this.sequence; this.leases.add(frameId);
      return { frameId, handle: Buffer.alloc(8), width: this.width, height: this.height, rawPoints: 3,
        visiblePoints: 3, renderedVertices: 3, lodMs: 0.1, encodeMs: 0.2, gpuWaitMs: 0.3,
        from: this.from, to: this.to, yMin: 2, yMax: 8 };
    }
    releaseFrame(id) { return this.leases.delete(id); }
    hitTest(timestamp) { return { index: 0, timestamp, value: 2, privatePointer: Buffer.alloc(8) }; }
    dispose() { assert.equal(this.leases.size, 0); this.disposed = true; }
  }
  const runtime = createNativeChartWorkerRuntime({ NativeChart: Native });
  let sequence = 0;
  const call = (op, input, n = 0) => runtime.dispatch({ id: ++sequence, op, sessionId: ids[n], input });
  return { runtime, call, instances };
}

test('协议白名单拒绝路径、稀疏数组、超限、非有限时间和非法颜色尺寸', () => {
  assert.equal(validateOpen(openInput()).values.length, 3);
  assert.equal(validateRender(renderInput()).requestId, 1);
  assert.equal(validateHitTest({ sessionId: ids[0], timestamp: -1 }).timestamp, -1);
  for (const input of [{ ...openInput(), path: '/tmp/data' }, { ...openInput(), handle: Buffer.alloc(8) },
    { ...openInput(), surfaceId: '__proto__' }, { ...openInput(), timestamps: [1, NaN, 3] },
    { ...openInput(), values: new Array(3) }, { ...openInput(), values: [] },
    { ...openInput(), timestamps: Array(LIMITS.samples + 1).fill(1), values: Array(LIMITS.samples + 1).fill(1) }]) {
    assert.throws(() => validateOpen(input), /INVALID_INPUT/);
  }
  for (const patch of [{ requestId: 0 }, { requestId: 1.5 }, { width: 1.5 }, { width: 4097 },
    { width: 4000, height: 2001 }, { background: [0, 1, 256] }, { line: [0, -1, 0] },
    { line: [0, 0, 0, 0] }, { from: Infinity }, { to: 10 }, { from: -Number.MAX_VALUE, to: Number.MAX_VALUE },
    { addonPath: '/tmp/addon.node' }]) assert.throws(() => validateRender({ ...renderInput(), ...patch }), /INVALID_INPUT/);
  assert.throws(() => validateHitTest({ sessionId: ids[0], timestamp: Infinity }), /INVALID_INPUT/);
});

test('worker 的两个会话上限包括 draining；原生释放后才能腾出容量', () => {
  const { call, runtime, instances } = setup();
  assert.equal(call('open', openInput()).ok, true);
  assert.equal(call('open', openInput()).error, 'DUPLICATE_SESSION');
  assert.equal(call('open', openInput(1), 1).ok, true);
  const frame = call('render', renderInput()).result;
  assert.equal(call('close').result.closed, false);
  assert.equal(call('open', openInput(2), 2).error, 'SESSION_BUSY');
  assert.equal(instances[0].disposed, false);
  assert.equal(call('release', { frameId: frame.frameId }).result.closed, true);
  assert.equal(instances[0].disposed, true);
  assert.equal(call('open', openInput(2), 2).ok, true);
  assert.equal(runtime.diagnostics().sessions.length, 2);
  assert.equal(call('stop').result.drained, true);
});

test('worker 三槽背压、递增编号和原会话租约隔离', () => {
  const { call, instances } = setup();
  call('open', openInput()); call('open', openInput(1), 1);
  for (let id = 1; id <= 3; id++) assert.equal(call('render', renderInput(id)).ok, true);
  assert.equal(call('render', renderInput(3)).error, 'STALE_REQUEST');
  assert.equal(call('render', renderInput(4)).error, 'SURFACE_BUSY');
  assert.equal(call('release', { frameId: 1 }, 1).error, 'UNKNOWN_LEASE');
  assert.equal(instances[0].leases.size, 3);
  assert.equal(call('release', { frameId: 1 }).result.released, true);
  assert.equal(call('release', { frameId: 1 }).error, 'UNKNOWN_LEASE');
  assert.equal(call('render', renderInput(4)).ok, true);
  assert.deepEqual(instances[0].background, [255, 255, 255]);
  assert.equal(call('hitTest', { sessionId: ids[0], timestamp: 11 }).result.privatePointer, undefined);
  assert.equal(call('stop').result.drained, false);
  assert.equal(call('render', renderInput(5)).error, 'UNAVAILABLE');
  for (const frameId of [2, 3, 4]) call('release', { frameId });
  assert.equal(call('stop').result.drained, true);
});

test('原生失败禁用运行时但保留可排空 chart，错误不泄露路径', () => {
  for (const options of [{ failRender: true }, { failLoad: true }]) {
    const { call, runtime, instances } = setup(options);
    const opened = call('open', openInput());
    const failed = options.failLoad ? opened : call('render', renderInput());
    assert.equal(failed.fatal, true);
    assert.equal(failed.error, 'NATIVE_FAILURE');
    assert.equal(runtime.diagnostics().faulted, true);
    assert.equal(instances[0].disposed, false);
    assert.equal(call('close').result.closed, true);
    assert.equal(instances[0].disposed, true);
  }
});

test('真实 worker 的装载失败显式 unavailable，不需要 GPU', async t => {
  const worker = new Worker(new URL('../src/native-chart-worker.mjs', import.meta.url), {
    workerData: { kind: 'harness-native-chart-v1', addonPath: fileURLToPath(new URL('./missing.node', import.meta.url)), platform: process.platform },
  });
  t.after(() => worker.terminate());
  const [ready] = await once(worker, 'message');
  assert.equal(ready.available, false);
  assert.match(ready.reason, /NATIVE_UNAVAILABLE/);
  const response = once(worker, 'message');
  worker.postMessage({ id: 1, op: 'open', sessionId: ids[0], input: openInput() });
  assert.equal((await response)[0].error, 'UNAVAILABLE');
});

const addonPath = fileURLToPath(new URL('../dist/native/harness-chart-runtime.node', import.meta.url));
test('显式启用时通过真实线程验证已构建 addon 的加载、渲染和释放', {
  skip: process.env.HARNESS_NATIVE_CHART_GPU_TEST !== '1' || process.platform !== 'darwin' || !existsSync(addonPath),
  timeout: 30_000,
}, async t => {
  const worker = new Worker(new URL('../src/native-chart-worker.mjs', import.meta.url), {
    workerData: { kind: 'harness-native-chart-v1', addonPath, platform: 'darwin' },
  });
  t.after(() => worker.terminate());
  assert.equal((await once(worker, 'message'))[0].available, true);
  let sequence = 0;
  async function call(op, input) {
    const response = once(worker, 'message');
    worker.postMessage({ id: ++sequence, op, sessionId: ids[0], input });
    const [message] = await response;
    assert.equal(message.ok, true, JSON.stringify(message));
    return message.result;
  }
  const loaded = await call('open', openInput());
  assert.equal(loaded.rawPoints, 3);
  assert.equal(loaded.from, 10);
  const frame = await call('render', renderInput());
  assert.equal(frame.handle.byteLength, 8);
  assert.equal((await call('close')).closed, false);
  assert.equal((await call('release', { frameId: frame.frameId })).closed, true);
  assert.equal((await call('diagnostics')).sessions.length, 0);
});
