import type { Buffer } from 'node:buffer';

export interface LoadedSeries {
  rawPoints: number;
  from: number;
  to: number;
  loadMs: number;
}

export interface HitResult {
  index: number;
  timestamp: number;
  value: number;
}

export interface RenderedFrame {
  frameId: number;
  width: number;
  height: number;
  // 本进程 IOSurfaceRef 的原生端序指针字节，不是像素、IOSurfaceID 或 Mach port。
  // worker 只交给同进程 main；main 导入 handle: { ioSurface: Buffer.from(handle) }，pixelFormat: 'bgra'。
  // worker postMessage 会把 Buffer 克隆为 Uint8Array；绝不能把指针传给 renderer。
  handle: Buffer;
  rawPoints: number;
  // 闭区间 [from, to] 内的真实样本数，重复时间戳逐项计数；间隙/完全域外时为 0。
  visiblePoints: number;
  // 原始样本的 LOD 顶点数，不含 re_renderer 内部扩展；最多 2 × width + 2。
  // 保留可见首尾及各桶 min/max 的原始索引；不按时间去重，无可见样本时为 0。
  // 完全重合的几何绘制为点，但此计数仍保留实际 LOD 索引数。
  renderedVertices: number;
  lodMs: number;
  encodeMs: number;
  // GPU 等待墙钟时间，不是 GPU execution time；未使用 timestamp query。
  gpuWaitMs: number;
  // 实际 LOD/GPU 使用的视域，精确等于最近一次成功 setViewport 的 from/to，无 clamp 或补点。
  // loadSeries 成功后重置为真实首尾时间；失败的视域更新保持旧视域。
  from: number;
  to: number;
  // 可见真实样本精确 f64 极值；常值相等；空可见区间返回 0、1。
  yMin: number;
  yMax: number;
}

export interface Stats {
  backend: string;
  // 当前由池持有的输出数，0..3；不计内部纹理或故障后保留至进程退出的资源。
  allocatedSurfaces: number;
  inFlight: number;
  renderedFrames: number;
  releasedFrames: number;
}

// 全部同步方法：只在专用 Node worker 上加载 addon、构造、调用和销毁。
// 禁止在 Electron main / Studio host 调用 GPU 初始化或等待。实例不可跨线程转移。
// macOS 使用真实 Metal / IOSurface；其它平台构造时明确抛出 UNSUPPORTED。
export class NativeChart {
  // 物理像素尺寸（CSS 尺寸 × DPR，由 host 取整），各为 1..4096 整数，面积 <= 8,388,608。
  constructor(width: number, height: number);
  // 等长、1..20,000；时间戳有限且非递减（允许重复），值有限，均保留 f64。
  // 不自动排序、不生成合成数据。成功后视域重置为真实首尾时间；失败保持旧数据。
  // 返回的 from/to 是数据域，单点或全部同时间时相等，不会自动 padding。
  loadSeries(timestamps: number[], values: number[]): LoadedSeries;
  // 两个端点必须有限且 from <= to；允许小数及零跨度，区间两端均可见。
  // 显式时间戳不 clamp：允许包含或超出数据域，由 UI 负责视域收敛。
  // 单点/同时间数据可传入 center ±500 等 padding，render 原样返回请求端点。
  // 间隙或完全域外只绘制背景，不补造端点；非法请求不改变当前视域。
  // Rust 隐式整数时间生成/测试 helper 的旧 clamp 语义不受影响，JS 不暴露该入口。
  setViewport(from: number, to: number): void;
  resize(width: number, height: number): void;
  // 来自 Studio 已解析的语义 token；sRGB 通道必须是 0..255 整数，无 alpha。
  setColors(background: [number, number, number], line: [number, number, number]): void;
  // 仅兼容旧测试；正式 host 应使用 setColors。
  setTheme(dark: boolean): void;
  // 查询必须有限；独立于当前视域和 LOD，在全部原始样本中二分查找。
  // 域外取最近端点，等距选较晚时间，重复时间总取首个样本；返回真实样本时间而非查询时间。
  hitTest(timestamp: number): HitResult;
  // 单 worker 同步编码/提交，device.poll 最多等待 5 秒。故障后禁止继续使用，需重建。
  render(): RenderedFrame;
  // 只能在 main 确认未导入或 allReferencesReleased 后调用；未知/重复帧返回 false。
  releaseFrame(frameId: number): boolean;
  stats(): Stats;
  // inFlight 非零抛 SURFACE_BUSY 且不销毁；成功后重复安全，stats/releaseFrame 仍可调用。
  // 提交完成状态不明的 GPU 资源永久隔离至进程退出，绝不提前销毁或复用。
  dispose(): void;
}
