import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { LIMITS, chartError, sessionId, validateOpen, validateRender, validateHitTest, frameMetrics } from './native-chart-protocol.mjs';

/** 只有专属线程实例化本运行时；注入构造器用于不依赖 GPU 的行为测试。 */
export function createNativeChartWorkerRuntime({ NativeChart }) {
  const charts = new Map();
  let faulted = false;
  let stopping = false;
  let rendered = 0;
  let released = 0;

  function dispose(session) {
    if (!session.closing || session.leases.size) return false;
    session.chart.dispose();
    charts.delete(session.id);
    return true;
  }

  function requireSession(id) {
    const session = charts.get(sessionId(id));
    if (!session) throw chartError('NOT_FOUND', '图表会话不存在');
    return session;
  }

  function diagnostics() {
    return { faulted, stopping, rendered, released, sessions: [...charts.values()].map(session => ({
      sessionId: session.id, closing: session.closing, leases: session.leases.size,
      lastRequestId: session.lastRequestId,
    })) };
  }

  function execute({ op, sessionId: id, input }) {
    if (op === 'diagnostics') return diagnostics();
    if (op === 'stop') {
      stopping = true;
      for (const session of charts.values()) { session.closing = true; dispose(session); }
      return { drained: charts.size === 0 };
    }
    if (op === 'close') {
      sessionId(id);
      const session = charts.get(id);
      if (!session) return { closed: true };
      session.closing = true;
      return { closed: dispose(session) };
    }
    if (op === 'release') {
      const session = requireSession(id);
      const frameId = input?.frameId;
      if (!Number.isSafeInteger(frameId) || frameId < 1) throw chartError('INVALID_INPUT', '租约编号无效');
      if (!session.leases.has(frameId)) throw chartError('UNKNOWN_LEASE', '租约不存在或已经归还');
      if (!session.chart.releaseFrame(frameId)) throw chartError('NATIVE_FAILURE', '原生租约拒绝归还');
      session.leases.delete(frameId);
      released++;
      return { released: true, closed: dispose(session) };
    }
    if (faulted || stopping) throw chartError('UNAVAILABLE', '原生图表运行时不可用');
    if (op === 'open') {
      sessionId(id);
      validateOpen(input);
      if (charts.has(id)) throw chartError('DUPLICATE_SESSION', '会话编号重复');
      if (charts.size >= LIMITS.sessions) throw chartError('SESSION_BUSY', '两个会话仍在使用或排空');
      const chart = new NativeChart(1, 1);
      const session = { id, chart, leases: new Set(), closing: false, lastRequestId: 0 };
      charts.set(id, session);
      // 失败也保留 chart，统一由 close 排空；不能凭异常推断原生资源已销毁。
      const loaded = chart.loadSeries(input.timestamps, input.values);
      const backend = chart.stats().backend;
      if (!loaded || !['rawPoints', 'from', 'to', 'loadMs'].every(key => Number.isFinite(loaded[key]))
        || typeof backend !== 'string') throw chartError('NATIVE_FAILURE', '原生数据加载结果无效');
      return { rawPoints: loaded.rawPoints, from: loaded.from, to: loaded.to, loadMs: loaded.loadMs, backend };
    }
    if (op !== 'render' && op !== 'hitTest') throw chartError('INVALID_INPUT', '未知图表操作');
    const session = requireSession(id);
    if (session.closing) throw chartError('CLOSED', '会话正在排空');
    if (input?.sessionId !== id) throw chartError('INVALID_INPUT', '会话编号不匹配');
    if (op === 'hitTest') {
      validateHitTest(input);
      const hit = session.chart.hitTest(input.timestamp);
      if (!hit || !['index', 'timestamp', 'value'].every(key => Number.isFinite(hit[key]))) {
        throw chartError('NATIVE_FAILURE', '原生查询结果无效');
      }
      return { index: hit.index, timestamp: hit.timestamp, value: hit.value };
    }
    validateRender(input);
    if (input.requestId <= session.lastRequestId) throw chartError('STALE_REQUEST', '请求编号必须严格递增');
    if (session.leases.size >= LIMITS.surfaces) throw chartError('SURFACE_BUSY', '三个输出纹理仍被引用');
    session.lastRequestId = input.requestId;
    session.chart.resize(input.width, input.height);
    session.chart.setViewport(input.from, input.to);
    session.chart.setColors(input.background, input.line);
    const frame = session.chart.render();
    // 返回值未经传输，验证失败时没有 Electron 外部引用，可立即归还。
    try {
      const metrics = frameMetrics(frame);
      if (!Buffer.isBuffer(frame.handle) || frame.handle.length !== 8 || session.leases.has(frame.frameId)) {
        throw chartError('NATIVE_FAILURE', '原生共享纹理句柄或租约无效');
      }
      session.leases.add(frame.frameId);
      rendered++;
      return { ...metrics, handle: frame.handle };
    } catch (error) {
      if (Number.isSafeInteger(frame?.frameId) && !session.leases.has(frame.frameId)) session.chart.releaseFrame(frame.frameId);
      throw error;
    }
  }

  return {
    diagnostics,
    dispatch(message) {
      try { return { id: message.id, ok: true, result: execute(message), state: diagnostics() }; }
      catch (error) {
        const expected = ['INVALID_INPUT', 'NOT_FOUND', 'CLOSED', 'UNAVAILABLE', 'SESSION_BUSY',
          'SURFACE_BUSY', 'STALE_REQUEST', 'DUPLICATE_SESSION', 'UNKNOWN_LEASE'];
        const fatal = !expected.includes(error.code);
        if (fatal) faulted = true;
        // 不回传 addon 错误栈或装载路径。
        return { id: message.id, ok: false, fatal, error: fatal ? 'NATIVE_FAILURE' : error.code, state: diagnostics() };
      }
    },
  };
}

// 被普通 Node/HTTP host 导入时不会装载 NAPI，也不会启动任何线程。
if (!isMainThread && workerData?.kind === 'harness-native-chart-v1') {
  let runtime;
  try {
    if (workerData.platform !== 'darwin' || process.platform !== 'darwin' || !isAbsolute(workerData.addonPath)) {
      throw new Error('unsupported');
    }
    const { NativeChart } = createRequire(import.meta.url)(workerData.addonPath);
    if (typeof NativeChart !== 'function' || !['loadSeries', 'setColors', 'render', 'releaseFrame',
      'resize', 'setViewport', 'hitTest', 'stats', 'dispose'].every(key => typeof NativeChart.prototype[key] === 'function')) {
      throw new Error('incompatible');
    }
    // 在专属线程探测真实 GPU 初始化；仅 addon 能装载不等于当前设备可渲染。
    // 探测不产生帧、没有外部租约，不占用正式会话池。
    const probe = new NativeChart(1, 1);
    probe.dispose();
    runtime = createNativeChartWorkerRuntime({ NativeChart });
    parentPort.postMessage({ type: 'ready', available: true });
  } catch {
    parentPort.postMessage({ type: 'ready', available: false, reason: 'NATIVE_UNAVAILABLE: 原生运行时无法装载或不支持当前平台' });
  }
  parentPort.on('message', message => {
    const response = runtime?.dispatch(message) ?? { id: message.id, ok: false, error: 'UNAVAILABLE' };
    // 不使用 transferList：指针字节可复制，租约始终由当前线程中的 chart 持有。
    parentPort.postMessage(response);
  });
}
