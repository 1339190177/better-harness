import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { CHANNEL_PREFIX } from '../src/native-chart-protocol.mjs';

const source = await readFile(new URL('../src/native-chart-preload.cjs', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(setImmediate);
const input = surfaceId => ({ surfaceId, timestamps: [10, 20], values: [1, 5] });

function setup({ missingTexture = false, invoke: customInvoke } = {}) {
  const calls = [];
  const canvasById = new Map();
  const listeners = new Map();
  const ipcListeners = new Map();
  let api, receiver;
  let now = 100;
  class Canvas {
    width = 1;
    height = 1;
    isConnected = true;
    draws = 0;
    drawFailure = false;
    contextMissing = false;
    getContext() {
      if (this.contextMissing) return null;
      return { drawImage: () => { if (this.drawFailure) throw new Error('绘制失败'); this.draws++; } };
    }
  }
  const electron = {
    contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'harnessNativeChart'); api = value; } },
    ipcRenderer: {
      on: (channel, callback) => ipcListeners.set(channel, callback),
      invoke: async (channel, ...args) => {
        calls.push({ channel, args });
        if (customInvoke) return customInvoke(channel.slice(CHANNEL_PREFIX.length), ...args);
        if (channel.endsWith(':capabilities')) return { version: 1, available: true };
        if (channel.endsWith(':open')) return { sessionId: randomUUID(), rawPoints: 2, from: 10, to: 20, loadMs: 1, backend: 'fake-native' };
        if (channel.endsWith(':hitTest')) return { index: 0, timestamp: args[0].timestamp, value: 1 };
      },
    },
    sharedTexture: missingTexture ? undefined : { setSharedTextureReceiver: callback => { receiver = callback; } },
  };
  runInNewContext(source, {
    require(name) { assert.equal(name, 'electron'); return electron; },
    document: { getElementById: id => canvasById.get(id) }, HTMLCanvasElement: Canvas,
    window: { addEventListener: (name, callback) => listeners.set(name, callback) },
    performance: { now: () => ++now },
  }, { filename: 'native-chart-preload.cjs' });
  function surface(id = `chart-${randomUUID()}`) {
    const canvas = new Canvas(); canvasById.set(id, canvas);
    const frames = [], errors = [];
    const unsubscribe = api.subscribe(id, frame => frames.push(frame), error => errors.push(error));
    return { id, canvas, frames, errors, unsubscribe };
  }
  async function receive(surfaceId, sessionId, requestId = 1, options = {}) {
    const video = { displayWidth: options.videoWidth ?? 200, displayHeight: 100, closes: 0,
      close() { this.closes++; if (options.closeFailure) throw new Error('关闭失败'); } };
    const texture = { releases: 0, gets: 0,
      getVideoFrame() { this.gets++; if (options.videoFailure) throw new Error('视频帧创建失败'); return video; },
      release() { this.releases++; if (options.releaseFailure) throw new Error('释放失败'); } };
    await receiver({ importedSharedTexture: texture }, { sessionId, surfaceId, requestId, frameId: requestId,
      width: 200, height: 100, rawPoints: 2, visiblePoints: 2, renderedVertices: 2, lodMs: 1, encodeMs: 1,
      gpuWaitMs: 1, from: 10, to: 20, yMin: 1, yMax: 5, handle: '不得暴露', ...options.metrics });
    return { video, texture };
  }
  return { api, calls, surface, receive, canvasById, listeners, ipcListeners };
}

test('公开契约固定且 subscribe 只保存隔离世界回调，不发送 IPC', async () => {
  const h = setup();
  assert.deepEqual(Object.keys(h.api).sort(), ['capabilities', 'close', 'hitTest', 'open', 'render', 'subscribe']);
  const s = h.surface();
  assert.equal(h.calls.length, 0);
  assert.throws(() => h.api.subscribe(s.id, () => {}, () => {}), /DUPLICATE_SURFACE/);
  assert.throws(() => h.api.subscribe('untrusted', () => {}, () => {}), /INVALID_INPUT/);
  assert.deepEqual(plain(await h.api.capabilities()), { version: 1, available: true });
  const opened = await h.api.open(input(s.id));
  assert.equal(opened.rawPoints, 2);
  await h.api.render({ sessionId: opened.sessionId });
  assert.deepEqual(plain(await h.api.hitTest({ sessionId: opened.sessionId, timestamp: 12 })), { index: 0, timestamp: 12, value: 1 });
  const before = h.calls.length;
  s.unsubscribe(); s.unsubscribe();
  assert.equal(h.calls.length, before);
  assert.ok(h.calls.every(call => call.args.every(arg => typeof arg !== 'function')));
});

test('同一 session 丢弃重复/倒序帧，多 surface 独立；所有纹理必释放', async () => {
  const h = setup();
  const a = h.surface(), b = h.surface();
  const x = await h.api.open(input(a.id)), y = await h.api.open(input(b.id));
  const first = await h.receive(a.id, x.sessionId, 2);
  assert.equal(first.video.closes, 1);
  assert.equal(first.texture.releases, 1);
  for (const request of [2, 1, 0]) {
    const late = await h.receive(a.id, x.sessionId, request);
    assert.equal(late.texture.gets, 0);
    assert.equal(late.texture.releases, 1);
  }
  await h.receive(b.id, y.sessionId, 1);
  const mismatched = await h.receive(a.id, y.sessionId, 3);
  assert.equal(mismatched.texture.gets, 0);
  assert.equal(a.canvas.draws, 1);
  assert.equal(b.canvas.draws, 1);
  assert.equal(a.frames[0].handle, undefined);
  assert.equal(a.frames[0].canvasMs, 1);
  assert.ok(a.frames[0].presentedAt > 100);
});

test('关闭和重建 reset 请求去重，旧 session 的帧和错误不能进入新 session', async () => {
  const h = setup();
  const s = h.surface();
  const old = await h.api.open(input(s.id));
  await h.receive(s.id, old.sessionId, 100);
  await h.api.close(old.sessionId);
  assert.equal(s.canvas.width, 1);
  const next = await h.api.open(input(s.id));
  await h.receive(s.id, next.sessionId, 1);
  const late = await h.receive(s.id, old.sessionId, 101);
  assert.equal(late.texture.gets, 0);
  assert.equal(s.frames.length, 2);
  const error = h.ipcListeners.get(`${CHANNEL_PREFIX}error`);
  error({}, { sessionId: old.sessionId, surfaceId: s.id, message: '旧错误' });
  error({}, { sessionId: next.sessionId, surfaceId: s.id, message: '当前错误' });
  assert.deepEqual(s.errors, ['当前错误']);
  await h.api.close(old.sessionId);
  assert.equal(s.canvas.width, 200);
});

test('unsubscribe 清除 Canvas 和绑定；即便重新订阅也不接受旧帧回填', async () => {
  const h = setup();
  const s = h.surface();
  const a = await h.api.open(input(s.id));
  await h.receive(s.id, a.sessionId);
  s.unsubscribe();
  assert.equal(s.canvas.width, 1);
  assert.equal(s.canvas.height, 1);
  const next = h.surface(s.id);
  const late = await h.receive(s.id, a.sessionId, 2);
  assert.equal(late.texture.releases, 1);
  assert.equal(late.texture.gets, 0);
  assert.equal(next.canvas.draws, 0);
  await assert.rejects(h.api.render({ sessionId: a.sessionId }), /CLOSED/);
  const b = await h.api.open(input(s.id));
  await h.receive(s.id, b.sessionId, 1);
  assert.equal(next.canvas.draws, 1);
});

test('open 未完成时 unsubscribe：迟到结果自动关闭，不留下孤儿会话', async () => {
  let resolveOpen;
  const id = randomUUID();
  const h = setup({ invoke: name => name === 'open' ? new Promise(resolve => { resolveOpen = resolve; }) : undefined });
  const s = h.surface();
  const opening = h.api.open(input(s.id));
  const rejected = assert.rejects(opening, /CLOSED/);
  await assert.rejects(h.api.open(input(s.id)), /REQUEST_BUSY/);
  s.unsubscribe();
  resolveOpen({ sessionId: id, rawPoints: 2, from: 10, to: 20, loadMs: 1, backend: 'fake-native' });
  await rejected; await tick();
  assert.equal(h.calls.at(-1).channel, `${CHANNEL_PREFIX}close`);
  assert.deepEqual(h.calls.at(-1).args, [id]);
  const late = await h.receive(s.id, id);
  assert.equal(late.texture.gets, 0);
});

test('绘制、VideoFrame 和回调失败均通过 finally 关闭及释放', async () => {
  for (const failure of ['drawFailure', 'contextMissing', 'videoFailure', 'closeFailure', 'releaseFailure', 'mismatch', 'callbacks']) {
    const h = setup();
    const s = h.surface();
    const a = await h.api.open(input(s.id));
    if (failure === 'callbacks') {
      s.unsubscribe();
      h.api.subscribe(s.id, () => { throw new Error('回调失败'); }, () => { throw new Error('错误回调失败'); });
      const b = await h.api.open(input(s.id)); a.sessionId = b.sessionId;
    }
    if (failure === 'drawFailure' || failure === 'contextMissing') s.canvas[failure] = true;
    const result = await h.receive(s.id, a.sessionId, 1, { [failure]: true, ...(failure === 'mismatch' ? { videoWidth: 201 } : {}) });
    assert.equal(result.texture.releases, 1, failure);
    assert.equal(result.video.closes, failure === 'videoFailure' ? 0 : 1, failure);
    if (failure !== 'callbacks') assert.ok(s.errors.length, failure);
  }
});

test('Canvas 被替换时释放旧保留引用；缺失或无效 Canvas 不取得视频帧', async () => {
  const h = setup();
  const s = h.surface();
  const a = await h.api.open(input(s.id));
  await h.receive(s.id, a.sessionId);
  h.canvasById.delete(s.id);
  const missing = await h.receive(s.id, a.sessionId, 2);
  assert.equal(missing.texture.gets, 0);
  const next = new s.canvas.constructor();
  h.canvasById.set(s.id, next);
  await h.receive(s.id, a.sessionId, 3);
  assert.equal(s.canvas.width, 1);
  assert.equal(next.draws, 1);
  s.unsubscribe();
  assert.equal(next.width, 1);
});

test('beforeunload 清空所有 Canvas，之后的帧和新订阅均失效', async () => {
  const h = setup();
  const a = h.surface(), b = h.surface();
  const x = await h.api.open(input(a.id)), y = await h.api.open(input(b.id));
  await h.receive(a.id, x.sessionId); await h.receive(b.id, y.sessionId);
  h.listeners.get('beforeunload')();
  assert.equal(a.canvas.width, 1);
  assert.equal(b.canvas.width, 1);
  assert.equal((await h.receive(a.id, x.sessionId, 2)).texture.gets, 0);
  assert.equal((await h.api.capabilities()).available, false);
  assert.throws(() => h.surface(), /CLOSED/);
  assert.equal(h.calls.some(call => call.channel.endsWith(':close')), false);
});

test('renderer 不支持 sharedTexture 时 capabilities false，不假冒 GPU 后端', async () => {
  const h = setup({ missingTexture: true });
  const s = h.surface();
  assert.equal((await h.api.capabilities()).available, false);
  assert.match(s.errors[0], /SHARED_TEXTURE_UNAVAILABLE/);
  await assert.rejects(h.api.open(input(s.id)), /SHARED_TEXTURE_UNAVAILABLE/);
  assert.equal(h.calls.length, 0);
});
