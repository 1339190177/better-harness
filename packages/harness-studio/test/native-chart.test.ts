import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChartController, type ChartRenderInput } from '../src/app/native-chart/chart-controller.js';
import { durationSamples, nearestSampleIndex, panViewport, parseComputedRGB, pixelPosition, prepareSamples, sampleBounds, standardGeometry, surfaceSize, zoomViewport } from '../src/app/native-chart/chart-model.js';
import type { NativeChartBridge, NativeChartFrame, NativeChartRender } from '../src/app/native-chart/bridge.js';
import { validateRender, LIMITS } from '../../better-harness-desktop/src/native-chart-protocol.mjs';

const base = Date.parse('2026-09-24T09:00:00Z');
const samples = [{ id: 'call-a', timestamp: base, value: 23 }, { id: 'call-b', timestamp: base + 1000, value: 7 }, { id: 'call-c', timestamp: base + 10000, value: 95 }];
const input: ChartRenderInput = { ...sampleBounds(samples), width: 800, height: 200, background: [255, 255, 255], line: [26, 51, 77] };
const sessionId = '00000000-0000-4000-8000-000000000001';
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture() {
  let frame!: (frame: NativeChartFrame) => void, error!: (message: string) => void;
  const state = vi.fn(), presented = vi.fn(), unsubscribe = vi.fn();
  const order: string[] = [];
  const bridge: NativeChartBridge = {
    capabilities: vi.fn(async () => ({ version: 1, available: true })),
    subscribe: vi.fn((_id, f, e) => { frame = f; error = e; order.push('subscribe'); return unsubscribe; }),
    open: vi.fn(async () => { order.push('open'); return { sessionId, ...sampleBounds(samples), rawPoints: samples.length, loadMs: 1, backend: 'test-bridge' }; }),
    render: vi.fn(async request => { validateRender(request); order.push('render'); }),
    hitTest: vi.fn(async () => ({ index: 1, timestamp: samples[1].timestamp, value: samples[1].value })),
    close: vi.fn(async () => { order.push('close'); }),
  };
  const controller = new ChartController(bridge, 'chart-test', samples, { state, frame: presented });
  const receipt = (request: NativeChartRender): NativeChartFrame => ({ ...request, surfaceId: 'chart-test', frameId: 1,
    rawPoints: 3, visiblePoints: 3, renderedVertices: 3, lodMs: 0.1, encodeMs: 0.1, gpuWaitMs: 0.5,
    yMin: 7, yMax: 95, canvasMs: 0.2, presentedAt: 20 });
  return { bridge, controller, state, presented, unsubscribe, order, frame: (value: NativeChartFrame) => frame(value), error: (value: string) => error(value), receipt };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('真实有界样本与 Standard 几何', () => {
  it('过滤缺失和非有限数据，保留零耗时并稳定排序同一 timestamp', () => {
    expect(durationSamples([
      { id: 'later', startMs: base + 10, durationMs: 17 }, { id: 'zero', startMs: base, durationMs: 0 },
      { id: 'same', startMs: base, durationMs: 22 }, { id: 'missing', startMs: base, durationMs: null },
      { id: 'no-start', startMs: null, durationMs: 33 }, { id: 'bad', startMs: base, durationMs: Infinity },
      { id: 'bad-start', startMs: NaN, durationMs: 7 },
    ])).toEqual([{ id: 'zero', timestamp: base, value: 0 }, { id: 'same', timestamp: base, value: 22 }, { id: 'later', timestamp: base + 10, value: 17 }]);
  });
  it('只检查前 4000 条，不读取/发送超大数组尾部', () => {
    const bounded = Array.from({ length: 4000 }, (_, i) => ({ id: String(i), timestamp: base + i, value: i }));
    Object.defineProperty(bounded, 4000, { get: () => { throw new Error('不能读取尾部'); } });
    bounded.length = 10_000_000;
    const result = prepareSamples(bounded);
    expect(result.samples).toHaveLength(4000);
    expect(result.omitted).toBe(9_996_000);
  });
  it('横轴是稀疏时间而非序号，纵轴使用实际耗时', () => {
    const geometry = standardGeometry(samples, sampleBounds(samples), 101, 101);
    expect(geometry.points.map(p => [p.id, p.x])).toEqual([['call-a', 0.5], ['call-b', 10.5], ['call-c', 100.5]]);
    expect(geometry.yMin).toBe(7); expect(geometry.yMax).toBe(95);
    expect(geometry.points[1].y).toBe(100.5); expect(geometry.points[2].y).toBe(0.5);
    expect(standardGeometry(samples, { from: base + 20, to: base + 30 }, 100, 100).points).toEqual([]);
  });
  it('Date 极限 singleton padding 仍能格式化；极大有限值不会溢出坐标', () => {
    const bounds = sampleBounds([{ id: 'edge', timestamp: 8.64e15, value: 1 }]);
    expect(() => new Date(bounds.to).toISOString()).not.toThrow();
    expect(bounds.to).toBeGreaterThan(bounds.from);
    expect(pixelPosition(0, -1e308, 1e308, 100)).toBe(50);
  });
  it('singleton、重复时间及常量纵轴不会零除', () => {
    const equal = [{ ...samples[0] }, { ...samples[0], id: 'second' }];
    expect(sampleBounds(equal)).toEqual({ from: base - 500, to: base + 500 });
    expect(standardGeometry(equal, sampleBounds(equal), 100, 100).points.map(p => [p.x, p.y])).toEqual([[50, 50], [50, 50]]);
    expect(pixelPosition(7, 7, 7, 1)).toBe(0.5);
  });
  it('缩放平移有界，探针返回原始索引，同时间可稳定定位', () => {
    const bounds = sampleBounds(samples);
    const zoom = zoomViewport(bounds, 0.5, 0.5, bounds);
    expect(zoom).toEqual({ from: base + 2500, to: base + 7500 });
    expect(panViewport(zoom, -100000, bounds)).toEqual({ from: base, to: base + 5000 });
    expect(zoomViewport(bounds, 0, 0.5, bounds).to - zoomViewport(bounds, 0, 0.5, bounds).from).toBe(1);
    expect(nearestSampleIndex(samples, base + 900)).toBe(1);
    expect(nearestSampleIndex([], base)).toBe(-1);
    expect(nearestSampleIndex([{ ...samples[0] }, { ...samples[0], id: 'duplicate' }, samples[1]], base + 1)).toBe(0);
  });
  it('等距取较晚时间，重复时间的首样本在精确、邻近和域外查询均一致', () => {
    const repeated = [samples[0], { ...samples[0], id: 'first-duplicate' }, samples[1], { ...samples[1], id: 'later-duplicate' }];
    for (const [at, index] of [[base - 1, 0], [base, 0], [base + 1, 0], [base + 500, 2], [base + 1000, 2], [base + 2000, 2]]) {
      expect(nearestSampleIndex(repeated, at)).toBe(index);
    }
  });
  it.each([
    ['rgb(255, 128, 0)', [255, 128, 0]], ['rgb(10 20 30)', [10, 20, 30]],
    ['rgba(10.4, 20.5, 254.9, 1)', [10, 21, 255]], ['rgb(100% 50% 0% / 100%)', [255, 128, 0]],
    ['rgba(10 20 30 / 1)', [10, 20, 30]], ['rgb(1e2, 0, 0)', [100, 0, 0]],
  ])('computed %s 输出 byte 并通过真实 Desktop 协议', (color, expected) => {
    const background = parseComputedRGB(color as string);
    expect(background).toEqual(expected);
    expect(() => validateRender({ ...input, background, sessionId, requestId: 1 })).not.toThrow();
  });
  it.each(['var(--color-workspace)', 'rgb(256, 0, 0)', 'rgb(-0.1 0 0)', 'rgb(1..2, 0, 0)',
    'rgb(1, 2, 3)garbage', 'rgb(1, 2, 3', 'rgb(1, 2 3)', 'rgb(1 2 3, 1)', 'rgb(1 2 3 /)',
    'rgb(101% 0% 0%)', 'rgb(1e999 0 0)', 'rgba(1, 2, 3, 2)', 'rgba(1, 2, 3, 0.5)',
    'rgb(1, 2%, 3)', 'rgb(1, 2, 3, 1, 1)', 'rgb(1 2 3 / 1 / 1)'])('拒绝无效或无法表达的颜色 %s，不 clamp', color => {
    expect(() => parseComputedRGB(color)).toThrow();
  });
  it.each([[4096, 2048, 1], [8000, 4000, 2], [4000, 8000, 2], [4096, 4096, 3], [390, 200, 2],
    [1e308, 1e308, 2], [0, 0, 1]])('surface %s × %s @%s 不超真实 host 限制且保持比例', (width, height, dpr) => {
    const size = surfaceSize(width, height, dpr);
    expect(size.width * size.height).toBeLessThanOrEqual(LIMITS.area);
    expect(() => validateRender({ ...input, ...size, sessionId, requestId: 1 })).not.toThrow();
    const ratio = Math.max(1, width) / Math.max(1, height);
    expect(Math.abs(size.width - size.height * ratio)).toBeLessThanOrEqual(Math.max(1, ratio));
  });
  it('surface 拒绝无效尺寸和 DPR，普通尺寸按真实 DPR 缩放', () => {
    expect(surfaceSize(800, 200, 2)).toEqual({ width: 1600, height: 400 });
    for (const args of [[-1, 1, 1], [Infinity, 1, 1], [1, NaN, 1], [1, 1, 0]]) {
      expect(() => surfaceSize(...args as [number, number, number])).toThrow();
    }
  });
});

describe('桥接生命周期（mock，不是原生绘制证据）', () => {
  it('subscribe 在 open 前；transport 完成仍需回执，rAF 合并为最新请求', async () => {
    const f = fixture(); await f.controller.start(); f.controller.setActive(true);
    f.controller.request(input); await vi.advanceTimersByTimeAsync(16);
    expect(f.order).toEqual(['subscribe', 'open', 'render']);
    f.controller.request({ ...input, to: base + 7000 }); f.controller.request({ ...input, to: base + 5000 });
    await vi.advanceTimersByTimeAsync(32);
    expect(f.bridge.render).toHaveBeenCalledTimes(1); expect(f.presented).not.toHaveBeenCalled();
    const first = vi.mocked(f.bridge.render).mock.calls[0][0];
    f.frame({ ...f.receipt(first), sessionId: 'stale-session' });
    expect(f.presented).not.toHaveBeenCalled();
    f.frame(f.receipt(first)); await vi.advanceTimersByTimeAsync(16);
    expect(f.bridge.render).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.bridge.render).mock.calls[1][0].to).toBe(base + 5000);
    await f.controller.dispose();
  });
  it('真实顺序：Canvas 回执先到，main 传输 Promise 未完成时绝不发第二帧', async () => {
    const f = fixture(); let release!: () => void;
    vi.mocked(f.bridge.render).mockImplementationOnce(request => {
      validateRender(request);
      f.frame(f.receipt(request));
      return new Promise(resolve => { release = resolve; });
    });
    await f.controller.start(); f.controller.setActive(true); f.controller.request(input);
    await vi.advanceTimersByTimeAsync(16);
    expect(f.presented).toHaveBeenCalledOnce();
    const first = vi.mocked(f.bridge.render).mock.calls[0][0];
    f.frame(f.receipt(first)); expect(f.presented).toHaveBeenCalledOnce();
    f.controller.request({ ...input, to: base + 7000 }); f.controller.request({ ...input, to: base + 5000 });
    await vi.advanceTimersByTimeAsync(100); expect(f.bridge.render).toHaveBeenCalledOnce();
    release(); await flush(); await vi.advanceTimersByTimeAsync(16);
    expect(f.bridge.render).toHaveBeenCalledTimes(2);
    const next = vi.mocked(f.bridge.render).mock.calls[1][0]; expect(next.to).toBe(base + 5000);
    f.frame(f.receipt(first)); expect(f.presented).toHaveBeenCalledOnce();
    f.frame(f.receipt(next)); expect(f.presented).toHaveBeenCalledTimes(2);
    await f.controller.dispose();
  });
  it('回执先到但已过时仍等待传输，不公布旧主题/尺寸的指标', async () => {
    const f = fixture(); let release!: () => void;
    vi.mocked(f.bridge.render).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await f.controller.start(); f.controller.setActive(true); f.controller.request(input); await vi.advanceTimersByTimeAsync(16);
    const first = vi.mocked(f.bridge.render).mock.calls[0][0];
    f.controller.request({ ...input, width: 600, background: [10, 20, 30] }); f.frame(f.receipt(first));
    await vi.advanceTimersByTimeAsync(32);
    expect(f.presented).not.toHaveBeenCalled(); expect(f.bridge.render).toHaveBeenCalledOnce();
    release(); await flush(); await vi.advanceTimersByTimeAsync(16);
    const next = vi.mocked(f.bridge.render).mock.calls[1][0]; expect(next.width).toBe(600);
    f.frame(f.receipt(next)); expect(f.presented).toHaveBeenCalledOnce(); await f.controller.dispose();
  });
  it.each(['REQUEST_BUSY', 'SURFACE_BUSY'])('%s 的 IPC 字符串拒绝在 rAF 重试最新输入，不清除当前展示', async code => {
    const f = fixture(); await f.controller.start(); f.controller.setActive(true); f.controller.request(input);
    await vi.advanceTimersByTimeAsync(16); f.frame(f.receipt(vi.mocked(f.bridge.render).mock.calls[0][0]));
    vi.mocked(f.bridge.render).mockRejectedValueOnce(new Error(`Error invoking remote method 'render': Error: ${code}: occupied`));
    f.controller.request({ ...input, to: base + 7000 }); await vi.advanceTimersByTimeAsync(16);
    expect(f.bridge.close).not.toHaveBeenCalled(); expect(f.presented).toHaveBeenCalledOnce();
    expect(f.state).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'native' }));
    f.controller.request({ ...input, to: base + 5000 }); await vi.advanceTimersByTimeAsync(16);
    const next = vi.mocked(f.bridge.render).mock.calls[2][0]; expect(next.to).toBe(base + 5000);
    expect(next.requestId).toBeGreaterThan(vi.mocked(f.bridge.render).mock.calls[1][0].requestId);
    f.frame(f.receipt(next)); expect(f.presented).toHaveBeenCalledTimes(2); await f.controller.dispose();
  });
  it('背压通知不解锁/中断当前在途帧', async () => {
    const f = fixture(); let release!: () => void;
    vi.mocked(f.bridge.render).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await f.controller.start(); f.controller.setActive(true); f.controller.request(input); await vi.advanceTimersByTimeAsync(16);
    f.controller.request({ ...input, to: base + 5000 }); f.error('SURFACE_BUSY: releasing'); f.error('REQUEST_BUSY: pending');
    await vi.advanceTimersByTimeAsync(32); expect(f.bridge.render).toHaveBeenCalledOnce();
    release(); await flush(); await vi.advanceTimersByTimeAsync(32); expect(f.bridge.render).toHaveBeenCalledOnce();
    f.frame(f.receipt(vi.mocked(f.bridge.render).mock.calls[0][0])); await vi.advanceTimersByTimeAsync(16);
    expect(f.bridge.render).toHaveBeenCalledTimes(2); expect(f.bridge.close).not.toHaveBeenCalled(); await f.controller.dispose();
  });
  it('持续背压和最新输入不能重置 15 秒总期限，停止后无更多重试', async () => {
    const f = fixture(); vi.mocked(f.bridge.render).mockRejectedValue({ code: 'SURFACE_BUSY' });
    await f.controller.start(); f.controller.setActive(true); f.controller.request(input);
    await vi.advanceTimersByTimeAsync(10000); f.controller.request({ ...input, width: 600 });
    await vi.advanceTimersByTimeAsync(5016);
    expect(f.state).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'error', reason: expect.stringContaining('超时') }));
    const calls = vi.mocked(f.bridge.render).mock.calls.length;
    expect(calls).toBeGreaterThan(1); expect(calls).toBeLessThan(1000);
    await vi.advanceTimersByTimeAsync(1000); expect(f.bridge.render).toHaveBeenCalledTimes(calls); await f.controller.dispose();
  });
  it('回执不能取消仍 pending 的传输总超时；dispose 后迟到 resolve 不调度', async () => {
    const f = fixture(); let release!: () => void;
    vi.mocked(f.bridge.render).mockImplementationOnce(request => { f.frame(f.receipt(request)); return new Promise(resolve => { release = resolve; }); });
    await f.controller.start(); f.controller.setActive(true); f.controller.request(input); await vi.advanceTimersByTimeAsync(16);
    f.controller.request({ ...input, width: 600 }); await vi.advanceTimersByTimeAsync(15000);
    expect(f.state).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'error' }));
    release(); await flush(); await vi.advanceTimersByTimeAsync(100); expect(f.bridge.render).toHaveBeenCalledOnce(); await f.controller.dispose();
  });
  it('拒绝归一化小数颜色、面积超限和非整数尺寸，而不是依赖 mock 放行', async () => {
    for (const invalid of [{ ...input, line: [0.1, 0.2, 0.3] }, { ...input, width: 4096, height: 2048 }, { ...input, width: 100.5 }]) {
      const f = fixture(); await f.controller.start(); f.controller.setActive(true); f.controller.request(invalid as ChartRenderInput);
      await vi.advanceTimersByTimeAsync(16); expect(f.bridge.render).not.toHaveBeenCalled();
      expect(f.state).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'error' })); await f.controller.dispose();
    }
  });
  it('singleton 回执也严格验证请求视域，绝不接受 native clamp 后的范围', async () => {
    const f = fixture(), state = vi.fn(), presented = vi.fn(); let frame!: (frame: NativeChartFrame) => void;
    vi.mocked(f.bridge.subscribe).mockImplementation((_id, receive) => { frame = receive; return () => undefined; });
    vi.mocked(f.bridge.open).mockResolvedValue({ sessionId, from: base, to: base, rawPoints: 1, loadMs: 0, backend: 'test' });
    const controller = new ChartController(f.bridge, 'chart-test', [samples[0]], { state, frame: presented });
    await controller.start(); controller.setActive(true); controller.request({ ...input, ...sampleBounds([samples[0]]) });
    await vi.advanceTimersByTimeAsync(16); const request = vi.mocked(f.bridge.render).mock.calls[0][0];
    frame({ ...f.receipt(request), from: base, to: base, rawPoints: 1, visiblePoints: 1 });
    expect(state).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'error' })); expect(presented).not.toHaveBeenCalled(); await controller.dispose();
  });
  it('探针背压只重试最新查询，清除后忽略迟到结果且取消期限', async () => {
    const f = fixture(), receive = vi.fn(); let release!: (value: { index: number; timestamp: number; value: number }) => void;
    vi.mocked(f.bridge.hitTest).mockRejectedValueOnce('REQUEST_BUSY: pending').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await f.controller.start(); f.controller.setActive(true); f.controller.probe(base, receive); await flush();
    f.controller.probe(base + 1000, receive); expect(f.bridge.hitTest).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(16);
    expect(vi.mocked(f.bridge.hitTest).mock.calls[1][0].timestamp).toBe(base + 1000);
    f.controller.clearProbe(); release({ index: 1, timestamp: base + 1000, value: 7 }); await flush();
    await vi.advanceTimersByTimeAsync(16000); expect(receive).not.toHaveBeenCalled(); expect(f.bridge.close).not.toHaveBeenCalled(); await f.controller.dispose();
  });
  it('隐藏取消待绘帧；恢复仅发一帧，静止不持续 render', async () => {
    const f = fixture(); await f.controller.start(); f.controller.setActive(true); f.controller.request(input);
    f.controller.setActive(false); await vi.advanceTimersByTimeAsync(100);
    expect(f.bridge.render).not.toHaveBeenCalled();
    f.controller.setActive(true); await vi.advanceTimersByTimeAsync(16);
    f.frame(f.receipt(vi.mocked(f.bridge.render).mock.calls[0][0]));
    await vi.advanceTimersByTimeAsync(1000); expect(f.bridge.render).toHaveBeenCalledTimes(1);
    await f.controller.dispose(); expect(f.unsubscribe).toHaveBeenCalledOnce();
  });
  it('迟到 open 在下一份数据 open 前关闭，等待 draining close', async () => {
    const f = fixture(), next = fixture();
    let resolveOpen!: (value: Awaited<ReturnType<NativeChartBridge['open']>>) => void;
    let resolveClose!: () => void;
    vi.mocked(f.bridge.open).mockImplementation(() => new Promise(resolve => { resolveOpen = resolve; }));
    vi.mocked(f.bridge.close).mockImplementation(() => new Promise(resolve => { resolveClose = resolve; }));
    const starting = f.controller.start(); await flush();
    const closing = f.controller.dispose(); const nextStarting = next.controller.start();
    resolveOpen({ sessionId: 'late', ...sampleBounds(samples), rawPoints: 3, loadMs: 1, backend: 'test' }); await flush();
    expect(f.bridge.close).toHaveBeenCalledWith('late'); expect(next.bridge.open).not.toHaveBeenCalled();
    resolveClose(); await starting; await closing; await nextStarting;
    expect(next.bridge.open).toHaveBeenCalledOnce(); await next.controller.dispose();
  });
  it('capability false 使用 Standard，而 capability true + open 失败保持可见错误', async () => {
    const f = fixture(); vi.mocked(f.bridge.capabilities).mockResolvedValue({ version: 1, available: false, reason: 'unsupported' });
    await f.controller.start(); expect(f.state).toHaveBeenLastCalledWith({ mode: 'standard', reason: 'unsupported' });
    expect(f.bridge.open).not.toHaveBeenCalled(); await f.controller.dispose();
    const bad = fixture(); vi.mocked(bad.bridge.open).mockRejectedValue(new Error('GPU initialization failed'));
    await bad.controller.start(); expect(bad.state).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'error' })); await bad.controller.dispose();
  });
  it('数据范围不匹配、render 拒绝和无绘制回执不会报告成功', async () => {
    const f = fixture(); vi.mocked(f.bridge.open).mockResolvedValue({ sessionId: 'bad', from: base + 1, to: base + 10000, rawPoints: 3, loadMs: 1, backend: 'test' });
    await f.controller.start(); expect(f.state).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'error' })); await f.controller.dispose();
    expect(f.bridge.close).toHaveBeenCalledWith('bad');
    const timeout = fixture(); await timeout.controller.start(); timeout.controller.setActive(true); timeout.controller.request(input);
    await vi.advanceTimersByTimeAsync(15016); expect(timeout.presented).not.toHaveBeenCalled();
    expect(timeout.state).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'error' })); await timeout.controller.dispose();
    const rejected = fixture(); vi.mocked(rejected.bridge.render).mockRejectedValue(new Error('transport failed'));
    await rejected.controller.start(); rejected.controller.setActive(true); rejected.controller.request(input);
    await vi.advanceTimersByTimeAsync(16); expect(rejected.state).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'error' })); await rejected.controller.dispose();
  });
  it('theme/resize 变化时丢弃旧展示回执，旧 requestId 不解锁新帧', async () => {
    const f = fixture(); await f.controller.start(); f.controller.setActive(true); f.controller.request(input);
    await vi.advanceTimersByTimeAsync(16); const first = vi.mocked(f.bridge.render).mock.calls[0][0];
    f.controller.request({ ...input, width: 600, line: [77, 102, 128] }); f.frame(f.receipt(first));
    expect(f.presented).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(16);
    const second = vi.mocked(f.bridge.render).mock.calls[1][0]; f.frame(f.receipt(first));
    expect(f.presented).not.toHaveBeenCalled(); f.frame(f.receipt(second)); expect(f.presented).toHaveBeenCalledOnce();
    await f.controller.dispose(); f.frame(f.receipt(second)); expect(f.presented).toHaveBeenCalledOnce();
  });
  it('错误回执必须可见并关闭 session，不得冒充成功 Canvas', async () => {
    const f = fixture(); await f.controller.start(); f.controller.setActive(true); f.controller.request(input);
    await vi.advanceTimersByTimeAsync(16); const request = vi.mocked(f.bridge.render).mock.calls[0][0];
    f.frame({ ...f.receipt(request), yMax: NaN });
    expect(f.state).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'error' }));
    expect(f.presented).not.toHaveBeenCalled(); await f.controller.dispose(); expect(f.bridge.close).toHaveBeenCalledOnce();
  });
  it('卸载后迟到的 hitTest 不回调；悬停只执行一个查询和最新后继', async () => {
    const f = fixture(), receive = vi.fn(); let resolve!: (value: { index: number; timestamp: number; value: number }) => void;
    vi.mocked(f.bridge.hitTest).mockImplementation(() => new Promise(done => { resolve = done; }));
    await f.controller.start(); f.controller.setActive(true);
    f.controller.probe(base, receive); f.controller.probe(base + 100, receive); f.controller.probe(base + 1000, receive);
    expect(f.bridge.hitTest).toHaveBeenCalledOnce();
    resolve({ index: 0, timestamp: base, value: 23 }); await flush();
    expect(receive).not.toHaveBeenCalled(); expect(f.bridge.hitTest).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.bridge.hitTest).mock.calls[1][0].timestamp).toBe(base + 1000);
    await f.controller.dispose(); resolve({ index: 1, timestamp: base + 1000, value: 7 }); await flush();
    expect(receive).not.toHaveBeenCalled();
  });
  it('探针验证原始值和索引，丢弃卸载后的结果', async () => {
    const f = fixture(), receive = vi.fn(); await f.controller.start(); f.controller.setActive(true);
    f.controller.probe(base + 1000, receive); await flush();
    expect(receive).toHaveBeenCalledWith({ index: 1, timestamp: base + 1000, value: 7 });
    vi.mocked(f.bridge.hitTest).mockResolvedValue({ index: 99, timestamp: base, value: 0 });
    f.controller.probe(base, receive); await flush();
    expect(f.state).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'error' }));
    expect(receive).toHaveBeenCalledTimes(1); await f.controller.dispose();
  });
});
