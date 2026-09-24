export interface ChartSample { timestamp: number; value: number; id: string }
export interface ChartViewport { from: number; to: number }
/** Desktop 和 Rust setColors 接收不透明 sRGB 整数 byte，不是归一化通道。 */
export type ChartRGB = [number, number, number];
export const MAX_CHART_SAMPLES = 4000;
export const MAX_CHART_DIMENSION = 4096;
export const MAX_CHART_AREA = 8_000_000;

/** 等比降采样；向下取整保证面积不因像素舍入超过 host 上限。 */
export function surfaceSize(cssWidth: number, cssHeight: number, dpr = 1): { width: number; height: number } {
  if (![cssWidth, cssHeight, dpr].every(Number.isFinite) || cssWidth < 0 || cssHeight < 0 || dpr <= 0) {
    throw new RangeError('图表尺寸必须非负有限，像素比例必须为正');
  }
  const width = Math.max(1, cssWidth), height = Math.max(1, cssHeight);
  const scale = Math.min(dpr, 2, MAX_CHART_DIMENSION / width, MAX_CHART_DIMENSION / height,
    Math.sqrt(MAX_CHART_AREA / width) / Math.sqrt(height));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

/** 只处理服务端已保留的有界前缀；缺失值绝不转成零，也不扫描百万点。 */
export function prepareSamples(input: readonly ChartSample[]): { samples: ChartSample[]; omitted: number } {
  const seen = new Set<string>();
  const samples = input.slice(0, MAX_CHART_SAMPLES).filter(sample => {
    if (typeof sample.timestamp !== 'number' || !Number.isFinite(sample.timestamp) || Math.abs(sample.timestamp) > 8.64e15
      || typeof sample.value !== 'number' || !Number.isFinite(sample.value) || !sample.id || seen.has(sample.id)) return false;
    seen.add(sample.id);
    return true;
  }).map(sample => ({ timestamp: sample.timestamp, value: sample.value, id: sample.id }));
  // ECMAScript 的稳定排序保留同一时间戳的原始证据次序。
  samples.sort((a, b) => a.timestamp - b.timestamp);
  return { samples, omitted: input.length - samples.length };
}

export function durationSamples(spans: readonly { id: string; startMs: number | null; durationMs: number | null }[]): ChartSample[] {
  return prepareSamples(spans.slice(0, MAX_CHART_SAMPLES).flatMap(span =>
    span.startMs === null || span.durationMs === null ? [] : [{ id: span.id, timestamp: span.startMs, value: span.durationMs }])).samples;
}

export function sampleBounds(samples: readonly ChartSample[]): ChartViewport {
  if (!samples.length) return { from: 0, to: 1 };
  const from = samples[0].timestamp, to = samples[samples.length - 1].timestamp;
  return from === to ? { from: Math.max(-8.64e15, from - 500), to: Math.min(8.64e15, to + 500) } : { from, to };
}

export function clampViewport(view: ChartViewport, bounds: ChartViewport): ChartViewport {
  if (!Number.isFinite(view.from) || !Number.isFinite(view.to) || view.to <= view.from) return bounds;
  const width = Math.min(bounds.to - bounds.from, Math.max(1, view.to - view.from));
  const from = Math.max(bounds.from, Math.min(bounds.to - width, view.from));
  return { from, to: from + width };
}

export function zoomViewport(view: ChartViewport, factor: number, ratio: number, bounds: ChartViewport): ChartViewport {
  const anchor = view.from + (view.to - view.from) * ratio;
  const width = Math.min(bounds.to - bounds.from, Math.max(1, (view.to - view.from) * factor));
  return clampViewport({ from: anchor - width * ratio, to: anchor + width * (1 - ratio) }, bounds);
}

export function panViewport(view: ChartViewport, delta: number, bounds: ChartViewport): ChartViewport {
  return clampViewport({ from: view.from + delta, to: view.to + delta }, bounds);
}

/** 和原生点坐标一致：首尾是像素中心，不是外侧边界。 */
export function pixelPosition(value: number, min: number, max: number, size: number): number {
  const range = max - min;
  const ratio = max === min ? 0.5 : Number.isFinite(range) ? (value - min) / range : (value / 2 - min / 2) / (max / 2 - min / 2);
  return 0.5 + ratio * (Math.max(1, size) - 1);
}

export function nearestSampleIndex(samples: readonly ChartSample[], timestamp: number): number {
  if (!samples.length || !Number.isFinite(timestamp)) return -1;
  let lo = 0, hi = samples.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (samples[mid].timestamp < timestamp) lo = mid + 1; else hi = mid; }
  if (lo === samples.length || (lo > 0 && timestamp - samples[lo - 1].timestamp < samples[lo].timestamp - timestamp)) lo--;
  // 相同 timestamp 的鼠标探针选择首个样本，Shift+方向键仍可逐条访问。
  while (lo > 0 && samples[lo - 1].timestamp === samples[lo].timestamp) lo--;
  return lo;
}

/** Standard 只绘制真实可见样本，不用索引代替横轴，也不插入虚构样本。 */
export function standardGeometry(samples: readonly ChartSample[], view: ChartViewport, width: number, height: number) {
  const visible = samples.filter(sample => sample.timestamp >= view.from && sample.timestamp <= view.to);
  const yMin = visible.length ? Math.min(...visible.map(s => s.value)) : 0;
  const yMax = visible.length ? Math.max(...visible.map(s => s.value)) : 1;
  const points = visible.map(sample => ({ ...sample,
    x: pixelPosition(sample.timestamp, view.from, view.to, width),
    y: height - pixelPosition(sample.value, yMin, yMax, height),
  }));
  return { points, yMin, yMax, polyline: points.map(p => `${p.x},${p.y}`).join(' ') };
}

/** 严格解析完整 rgb/rgba；原生无 alpha，不能静默丢弃透明度或钳制无效值。 */
export function parseComputedRGB(color: string): ChartRGB {
  const invalid = (): never => { throw new Error('无法解析不透明 Studio 语义颜色'); };
  const match = /^rgba?\(([^()]*)\)$/i.exec(color.trim());
  if (!match) return invalid();
  const body = match[1].trim(), legacy = body.includes(',');
  const parts = legacy ? body.split(',').map(part => part.trim()) : body.split('/').map(part => part.trim());
  const channels = legacy ? parts.slice(0, 3) : parts[0].split(/\s+/);
  const alpha = legacy ? parts[3] : parts[1];
  if ((legacy ? parts.length !== 3 && parts.length !== 4 : parts.length > 2) || channels.length !== 3
    || (legacy && channels.some(part => part.endsWith('%')) && !channels.every(part => part.endsWith('%')))) return invalid();
  const parse = (value: string, maximum: number): number => {
    if (!/^[+-]?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?%?$/i.test(value)) return invalid();
    const percent = value.endsWith('%'), number = Number(percent ? value.slice(0, -1) : value);
    if (!Number.isFinite(number) || number < 0 || number > (percent ? 100 : maximum)) return invalid();
    return percent ? number / 100 * maximum : number;
  };
  if (alpha !== undefined && parse(alpha, 1) !== 1) return invalid();
  return channels.map(channel => Math.round(parse(channel, 255))) as ChartRGB;
}
