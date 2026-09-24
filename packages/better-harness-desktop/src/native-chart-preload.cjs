const { contextBridge, ipcRenderer, sharedTexture } = require('electron');

/** @typedef {[number, number, number]} ChartRGB */
/** @typedef {{version: 1, available: boolean, reason?: string}} ChartCapabilities */
/** @typedef {{surfaceId: string, timestamps: number[], values: number[]}} ChartOpenInput */
/** @typedef {{sessionId: string, rawPoints: number, from: number, to: number, loadMs: number, backend: string}} ChartOpenResult */
/** @typedef {{sessionId: string, width: number, height: number, from: number, to: number, background: ChartRGB, line: ChartRGB, requestId: number}} ChartRenderInput */
/** @typedef {{index: number, timestamp: number, value: number}} ChartHitResult */
/**
 * 原生 RenderedFrame 去掉 handle，加上会话、请求及实际 Canvas 提交计时。
 * @typedef {{frameId: number, width: number, height: number, rawPoints: number, visiblePoints: number,
 * renderedVertices: number, lodMs: number, encodeMs: number, gpuWaitMs: number, from: number, to: number,
 * yMin: number, yMax: number, sessionId: string, surfaceId: string, requestId: number,
 * canvasMs: number, presentedAt: number}} NativeChartMetrics
 */
/**
 * 页面仅能使用此版本化契约，回调从不跨 IPC；原生指针与 VideoFrame 从不进入主世界。
 * @typedef {{capabilities: () => Promise<ChartCapabilities>, open: (input: ChartOpenInput) => Promise<ChartOpenResult>,
 * render: (input: ChartRenderInput) => Promise<void>, hitTest: (input: {sessionId: string, timestamp: number}) => Promise<ChartHitResult>,
 * close: (sessionId: string) => Promise<void>, subscribe: (surfaceId: string, onFrame: (metrics: NativeChartMetrics) => void,
 * onError: (message: string) => void) => (() => void)}} HarnessNativeChartAPI
 */

const prefix = 'harness-native-chart:v1:';
const frameFields = ['frameId', 'width', 'height', 'rawPoints', 'visiblePoints', 'renderedVertices',
  'lodMs', 'encodeMs', 'gpuWaitMs', 'from', 'to', 'yMin', 'yMax'];
const subscriptions = new Map();
const bindings = new Map();
const sessions = new Map();
const openings = new Map();
let unloading = false;
let receiverError;

function validId(id) { return typeof id === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id); }
function validSurface(id) { return typeof id === 'string' && id.startsWith('chart-') && validId(id.slice(6)); }
function invoke(name, ...args) { return ipcRenderer.invoke(`${prefix}${name}`, ...args); }

function report(subscription, message) {
  if (!subscription || !subscription.active || subscriptions.get(subscription.surfaceId) !== subscription) return;
  try { subscription.onError(message); } catch { /* 页面回调异常不影响纹理释放。 */ }
}

function clearCanvas(subscription) {
  if (!subscription) return;
  try {
    // 重设 backing store，释放 Canvas 保留的 GPU 绘制引用，而不仅是清空像素。
    if (subscription.canvas) { subscription.canvas.width = 1; subscription.canvas.height = 1; }
  } finally { subscription.canvas = null; subscription.context = null; }
}

function forget(binding) {
  if (!binding) return;
  sessions.delete(binding.sessionId);
  if (bindings.get(binding.surfaceId) === binding) {
    bindings.delete(binding.surfaceId);
    clearCanvas(subscriptions.get(binding.surfaceId));
  }
}

try {
  if (typeof sharedTexture?.setSharedTextureReceiver !== 'function') throw new Error('unsupported');
  sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, metrics) => {
    let video;
    let subscription;
    try {
      const binding = sessions.get(metrics?.sessionId);
      if (unloading || !binding || binding.surfaceId !== metrics.surfaceId || bindings.get(binding.surfaceId) !== binding) return;
      subscription = subscriptions.get(binding.surfaceId);
      if (!subscription?.active || !Number.isSafeInteger(metrics.requestId) || metrics.requestId < 1
        || metrics.requestId <= binding.lastRequestId) return;
      const result = {};
      for (const key of frameFields) {
        if (!Number.isFinite(metrics[key])) throw new Error('共享纹理元数据无效');
        result[key] = metrics[key];
      }
      if (!Number.isSafeInteger(metrics.width) || !Number.isSafeInteger(metrics.height)
        || metrics.width < 1 || metrics.height < 1 || metrics.width > 4096 || metrics.height > 4096
        || metrics.width * metrics.height > 8_000_000) throw new Error('共享纹理尺寸无效');
      const canvas = document.getElementById(binding.surfaceId);
      if (!(canvas instanceof HTMLCanvasElement) || !canvas.isConnected) throw new Error('未找到已注册的图表 Canvas');
      if (subscription.canvas !== canvas) clearCanvas(subscription);
      subscription.canvas = canvas;
      video = importedSharedTexture.getVideoFrame();
      if (video.displayWidth !== metrics.width || video.displayHeight !== metrics.height) throw new Error('共享纹理尺寸不匹配');
      if (canvas.width !== metrics.width) canvas.width = metrics.width;
      if (canvas.height !== metrics.height) canvas.height = metrics.height;
      subscription.context = canvas.getContext('2d', { alpha: false });
      if (!subscription.context) throw new Error('无法创建图表 Canvas context');
      const start = performance.now();
      subscription.context.drawImage(video, 0, 0);
      const presentedAt = performance.now();
      binding.lastRequestId = metrics.requestId;
      Object.assign(result, { sessionId: binding.sessionId, surfaceId: binding.surfaceId, requestId: metrics.requestId,
        canvasMs: presentedAt - start, presentedAt });
      try { subscription.onFrame(result); }
      catch { report(subscription, '图表帧订阅回调执行失败'); }
    } catch (error) { report(subscription, error.message || '共享纹理绘制失败'); }
    finally {
      try {
        try { video?.close(); } catch { report(subscription, '图表 VideoFrame 关闭失败'); }
      } finally {
        try { importedSharedTexture.release(); } catch { report(subscription, '图表纹理引用释放失败'); }
      }
    }
  });
} catch { receiverError = 'SHARED_TEXTURE_UNAVAILABLE: 当前 renderer 不支持共享纹理'; }

ipcRenderer.on(`${prefix}error`, (_event, payload) => {
  const binding = sessions.get(payload?.sessionId);
  if (!binding || binding.surfaceId !== payload.surfaceId || typeof payload.message !== 'string') return;
  report(subscriptions.get(binding.surfaceId), payload.message);
});

/** @type {HarnessNativeChartAPI} */
const api = {
  async capabilities() {
    if (receiverError || unloading) return { version: 1, available: false, reason: receiverError ?? 'CLOSED: 文档正在卸载' };
    const result = await invoke('capabilities');
    return { version: 1, available: result.available === true,
      ...(result.available === true ? {} : { reason: result.reason ?? 'UNAVAILABLE: 原生图表不可用' }) };
  },
  async open(input) {
    if (!validSurface(input?.surfaceId)) throw new Error('INVALID_INPUT: 图表 Canvas 编号无效');
    if (receiverError || unloading) throw new Error(receiverError ?? 'CLOSED: 文档正在卸载');
    const surfaceId = input.surfaceId;
    if (openings.has(surfaceId)) throw new Error('REQUEST_BUSY: Canvas 数据仍在加载');
    const token = { cancelled: false, subscription: subscriptions.get(surfaceId) };
    openings.set(surfaceId, token);
    try {
      const result = await invoke('open', input);
      if (!validId(result?.sessionId)) throw new Error('INVALID_RESPONSE: 图表会话编号无效');
      if (unloading || token.cancelled || (token.subscription && subscriptions.get(surfaceId) !== token.subscription)) {
        // open 完成前已卸载的组件不能留下孤儿会话；此清理不属于 subscribe 的 IPC。
        void Promise.resolve().then(() => invoke('close', result.sessionId)).catch(() => {});
        throw new Error('CLOSED: Canvas 订阅已经失效');
      }
      forget(bindings.get(surfaceId));
      const binding = { surfaceId, sessionId: result.sessionId, lastRequestId: 0 };
      bindings.set(surfaceId, binding);
      sessions.set(binding.sessionId, binding);
      return { sessionId: result.sessionId, rawPoints: result.rawPoints, from: result.from,
        to: result.to, loadMs: result.loadMs, backend: result.backend };
    } finally { if (openings.get(surfaceId) === token) openings.delete(surfaceId); }
  },
  async render(input) {
    const binding = sessions.get(input?.sessionId);
    if (!binding || !subscriptions.has(binding.surfaceId) || unloading) throw new Error('CLOSED: 图表 Canvas 未订阅或已关闭');
    await invoke('render', input);
  },
  async hitTest(input) {
    const hit = await invoke('hitTest', input);
    return { index: hit.index, timestamp: hit.timestamp, value: hit.value };
  },
  async close(id) {
    if (!validId(id)) throw new Error('INVALID_INPUT: 图表会话编号无效');
    forget(sessions.get(id));
    await invoke('close', id);
  },
  subscribe(surfaceId, onFrame, onError) {
    if (!validSurface(surfaceId) || typeof onFrame !== 'function' || typeof onError !== 'function') {
      throw new Error('INVALID_INPUT: 图表订阅参数无效');
    }
    if (unloading) throw new Error('CLOSED: 文档正在卸载');
    if (subscriptions.has(surfaceId)) throw new Error('DUPLICATE_SURFACE: Canvas 已经订阅');
    const subscription = { surfaceId, onFrame, onError, active: true, canvas: null, context: null };
    subscriptions.set(surfaceId, subscription);
    if (receiverError) report(subscription, receiverError);
    return () => {
      if (!subscription.active) return;
      subscription.active = false;
      if (openings.has(surfaceId)) openings.get(surfaceId).cancelled = true;
      forget(bindings.get(surfaceId));
      clearCanvas(subscription);
      if (subscriptions.get(surfaceId) === subscription) subscriptions.delete(surfaceId);
      subscription.onFrame = null;
      subscription.onError = null;
    };
  },
};

window.addEventListener('beforeunload', () => {
  unloading = true;
  for (const token of openings.values()) token.cancelled = true;
  for (const subscription of subscriptions.values()) {
    subscription.active = false;
    clearCanvas(subscription);
    subscription.onFrame = null;
    subscription.onError = null;
  }
  subscriptions.clear();
  bindings.clear();
  sessions.clear();
});

contextBridge.exposeInMainWorld('harnessNativeChart', api);
