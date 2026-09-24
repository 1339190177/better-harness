import { MAX_CHART_AREA, MAX_CHART_DIMENSION, MAX_CHART_SAMPLES, prepareSamples, sampleBounds, type ChartSample } from './chart-model.js';
import type { NativeChartBridge, NativeChartFrame, NativeChartHit, NativeChartRender, NativeChartSession } from './bridge.js';

export type ChartRenderInput = Omit<NativeChartRender, 'sessionId' | 'requestId'>;
export type ChartState = { mode: 'loading' | 'native' | 'standard' | 'error'; reason?: string; backend?: string };
interface Callbacks { state(value: ChartState): void; frame(value: NativeChartFrame): void }
interface Flight { request: NativeChartRender; transported: boolean; presented: boolean }
const FRAME_TIMEOUT_MS = 15000;

function isBackpressure(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return code === 'REQUEST_BUSY' || code === 'SURFACE_BUSY'
    || /(?:^|[\s:])(?:REQUEST_BUSY|SURFACE_BUSY)(?=:|\s|$)/.test(String(error));
}

// 所有 Surface 共用开关队列；数据替换先等待 close 排空，避免占满两个 session 配额。
let lifecycle: Promise<unknown> = Promise.resolve();
function serialize<T>(action: () => Promise<T>): Promise<T> {
  const result = lifecycle.then(action);
  lifecycle = result.catch(() => undefined);
  return result;
}
let requestSequence = 0;

export class ChartController {
  private samples: ChartSample[];
  private session?: NativeChartSession;
  private disposed = false;
  private failed = false;
  private active = false;
  private unsubscribe?: () => void;
  private latest?: ChartRenderInput;
  private dirty = false;
  private raf?: number;
  private inFlight?: Flight;
  private timeout?: ReturnType<typeof setTimeout>;
  private disposal?: Promise<void>;
  private probeRaf?: number;
  private probeTimeout?: ReturnType<typeof setTimeout>;
  private probeBusy = false;
  private probeLatest?: { timestamp: number; receive: (hit: NativeChartHit) => void };

  constructor(private bridge: NativeChartBridge, private surfaceId: string, samples: readonly ChartSample[], private callbacks: Callbacks) {
    this.samples = prepareSamples(samples).samples;
  }

  async start(): Promise<void> {
    this.callbacks.state({ mode: 'loading' });
    try {
      await serialize(async () => {
        if (this.disposed) return;
        const capability = await this.bridge.capabilities();
        if (this.disposed) return;
        if (capability.version !== 1 || !capability.available) {
          this.callbacks.state({ mode: 'standard', reason: capability.reason });
          return;
        }
        if (!this.samples.length || this.samples.length > MAX_CHART_SAMPLES) throw new Error('无有效有界样本');
        this.unsubscribe = this.bridge.subscribe(this.surfaceId, frame => this.receiveFrame(frame), message => {
          // 背压通知不是当前帧的完成信号；仍由其 Promise、回执和总超时驱动。
          if (!isBackpressure(message)) this.fail(message);
        });
        const session = await this.bridge.open({ surfaceId: this.surfaceId,
          timestamps: this.samples.map(s => s.timestamp), values: this.samples.map(s => s.value) });
        // open 不能取消；迟到结果必须在同一个队列任务中关闭，不能遗留占用配额。
        if (this.disposed || this.failed) { await this.bridge.close(session.sessionId); return; }
        this.session = session;
        if (!session.sessionId || session.rawPoints !== this.samples.length || !Number.isFinite(session.from)
          || !Number.isFinite(session.to) || session.from > this.samples[0].timestamp
          || session.to < this.samples[this.samples.length - 1].timestamp) throw new Error('原生图表返回了不匹配的数据范围');
        this.callbacks.state({ mode: 'native', backend: session.backend });
        this.schedule();
      });
    } catch (error) { this.fail(String(error)); }
  }

  setActive(active: boolean): void {
    this.active = active;
    if (!active && this.raf !== undefined) { cancelAnimationFrame(this.raf); this.raf = undefined; }
    if (!active) this.clearProbe();
    if (active) this.schedule();
  }

  request(input: ChartRenderInput): void {
    if (this.disposed || this.failed) return;
    const bounds = sampleBounds(this.samples);
    if (![input.width, input.height].every(value => Number.isSafeInteger(value) && value >= 1 && value <= MAX_CHART_DIMENSION)
      || input.width * input.height > MAX_CHART_AREA
      || ![input.background, input.line].every(rgb => Array.isArray(rgb) && rgb.length === 3
        && [0, 1, 2].every(i => Number.isInteger(rgb[i]) && rgb[i] >= 0 && rgb[i] <= 255))
      || ![input.from, input.to, input.to - input.from].every(Number.isFinite)
      || input.from >= input.to || input.from < bounds.from || input.to > bounds.to) {
      this.fail('无效的图表视域或 byte 调色板'); return;
    }
    this.latest = { ...input, background: [...input.background], line: [...input.line] };
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (!this.active || this.disposed || this.failed || !this.session || !this.dirty || this.inFlight || this.raf !== undefined) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = undefined;
      if (!this.active || !this.latest || !this.session || this.disposed || this.failed) return;
      const request = { ...this.latest, sessionId: this.session.sessionId, requestId: ++requestSequence };
      const flight: Flight = { request, transported: false, presented: false };
      this.inFlight = flight;
      this.dirty = false;
      // 背压重试和新的 latest 输入不重置期限，防止永远忙碌。
      this.timeout ??= setTimeout(() => this.fail('等待原生 Canvas 传输及绘制回执超时'), FRAME_TIMEOUT_MS);
      void Promise.resolve().then(() => this.bridge.render(request)).then(() => {
        flight.transported = true;
        this.finishFlight(flight);
      }).catch(error => {
        if (this.disposed || this.failed || this.inFlight !== flight) return;
        if (!isBackpressure(error)) { this.fail(String(error)); return; }
        this.inFlight = undefined;
        this.dirty = true;
        this.schedule();
      });
    });
  }

  private finishFlight(flight: Flight): void {
    if (this.disposed || this.failed || this.inFlight !== flight || !flight.transported || !flight.presented) return;
    clearTimeout(this.timeout);
    this.timeout = undefined;
    this.inFlight = undefined;
    this.schedule();
  }

  private receiveFrame(frame: NativeChartFrame): void {
    const flight = this.inFlight, request = flight?.request;
    if (this.disposed || this.failed || !flight || flight.presented || !request || frame.sessionId !== request.sessionId || frame.surfaceId !== this.surfaceId
      || frame.requestId !== request.requestId) return;
    if (frame.from !== request.from || frame.to !== request.to || frame.width !== request.width || frame.height !== request.height
      || frame.rawPoints !== this.samples.length || ![frame.yMin, frame.yMax].every(Number.isFinite)
      || ![frame.lodMs, frame.encodeMs, frame.gpuWaitMs, frame.canvasMs, frame.presentedAt].every(value => Number.isFinite(value) && value >= 0)
      || ![frame.rawPoints, frame.visiblePoints, frame.renderedVertices].every(value => Number.isSafeInteger(value) && value >= 0)
      || !Number.isSafeInteger(frame.frameId) || frame.frameId < 1 || frame.visiblePoints > frame.rawPoints
      || frame.yMin > frame.yMax) { this.fail('原生 Canvas 回执与请求不匹配'); return; }
    flight.presented = true;
    const latest = this.latest;
    const current = latest && latest.from === request.from && latest.to === request.to && latest.width === request.width && latest.height === request.height
      && latest.background.every((channel, i) => channel === request.background[i]) && latest.line.every((channel, i) => channel === request.line[i]);
    if (this.active && current) this.callbacks.frame(frame);
    this.finishFlight(flight);
  }

  /** 悬停查询同样单请求在途；结果必须仍属于同一数据及最新查询。 */
  probe(timestamp: number, receive: (hit: NativeChartHit) => void): void {
    if (!Number.isFinite(timestamp) || this.disposed || this.failed || !this.active || !this.session) return;
    this.probeLatest = { timestamp, receive };
    void this.flushProbe();
  }
  clearProbe(): void {
    this.probeLatest = undefined;
    if (this.probeRaf !== undefined) cancelAnimationFrame(this.probeRaf);
    this.probeRaf = undefined;
    clearTimeout(this.probeTimeout);
    this.probeTimeout = undefined;
  }

  private async flushProbe(): Promise<void> {
    if (this.probeBusy || this.probeRaf !== undefined || !this.probeLatest || !this.session || this.disposed || this.failed || !this.active) return;
    const query = this.probeLatest, sessionId = this.session.sessionId;
    this.probeBusy = true;
    this.probeTimeout ??= setTimeout(() => this.fail('等待原生探针超时'), FRAME_TIMEOUT_MS);
    let retry = false;
    try {
      const hit = await this.bridge.hitTest({ sessionId, timestamp: query.timestamp });
      if (this.disposed || this.failed || !this.active || this.session?.sessionId !== sessionId || query !== this.probeLatest) return;
      const sample = this.samples[hit.index];
      if (!Number.isInteger(hit.index) || !sample || sample.timestamp !== hit.timestamp || sample.value !== hit.value) {
        this.fail('原生探针与保留样本不匹配'); return;
      }
      query.receive(hit);
    } catch (error) {
      if (!this.disposed && this.probeLatest) {
        if (isBackpressure(error)) retry = true;
        else this.fail(String(error));
      }
    } finally {
      this.probeBusy = false;
      if (retry && this.active && !this.disposed) {
        this.probeRaf = requestAnimationFrame(() => { this.probeRaf = undefined; void this.flushProbe(); });
      } else {
        clearTimeout(this.probeTimeout);
        this.probeTimeout = undefined;
        if (this.probeLatest === query) this.probeLatest = undefined;
        else void this.flushProbe();
      }
    }
  }

  private fail(reason: string): void {
    if (this.disposed || this.failed) return;
    this.failed = true;
    this.callbacks.state({ mode: 'error', reason });
    void this.dispose().catch(() => undefined);
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    if (this.raf !== undefined) cancelAnimationFrame(this.raf);
    clearTimeout(this.timeout);
    this.unsubscribe?.();
    this.inFlight = undefined;
    this.clearProbe();
    this.disposal = serialize(async () => {
      const session = this.session;
      this.session = undefined;
      if (session) await this.bridge.close(session.sessionId);
    });
    return this.disposal;
  }
}
