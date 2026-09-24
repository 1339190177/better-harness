import type { ChartRGB, ChartViewport } from './chart-model.js';

/** 仅包含 preload 成功绘入 Canvas 后的回执，不含 native handle。 */
export interface NativeChartFrame extends ChartViewport {
  sessionId: string; surfaceId: string; requestId: number; frameId: number;
  width: number; height: number; rawPoints: number; visiblePoints: number; renderedVertices: number;
  lodMs: number; encodeMs: number; gpuWaitMs: number; yMin: number; yMax: number;
  canvasMs: number; presentedAt: number;
}
export interface NativeChartSession extends ChartViewport {
  sessionId: string; rawPoints: number; loadMs: number; backend: string;
}
export interface NativeChartRender extends ChartViewport {
  sessionId: string; width: number; height: number;
  background: ChartRGB; line: ChartRGB; requestId: number;
}
export interface NativeChartHit { index: number; timestamp: number; value: number }
export interface NativeChartBridge {
  capabilities(): Promise<{ version: 1; available: boolean; reason?: string }>;
  open(options: { surfaceId: string; timestamps: number[]; values: number[] }): Promise<NativeChartSession>;
  render(options: NativeChartRender): Promise<void>;
  hitTest(options: { sessionId: string; timestamp: number }): Promise<NativeChartHit>;
  close(sessionId: string): Promise<void>;
  subscribe(surfaceId: string, onFrame: (frame: NativeChartFrame) => void, onError: (message: string) => void): () => void;
}
declare global {
  interface Window { harnessNativeChart?: NativeChartBridge }
}
