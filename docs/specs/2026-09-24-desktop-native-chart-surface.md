# Desktop Native Chart Surface

## Traceability
- Spec ID: native-chart-surface-poc（保留初建标识；本文件即其 Desktop 迭代）
- Status: Implemented（macOS 原生链路已验证；Studio 打包验收待并行改动解除后完成）

## Intent
用户纠正交付边界：图表能力必须融入 Desktop 正式功能，而非独立 PoC。原独立实验仅作底层证据，现已迁入 Desktop 并退役。

## Desktop Acceptance Scenarios
- D-1：可复用 NativeChartSurface 集成 Sessions → Performance，以真实、有限耗时记录展示调用开始时间与耗时趋势；保留原区间列表、类别筛选、来源联动和缺失值语义。默认界面不生成合成数据，不新增 demo 导航。10M 合成数据仅用于压力测试。
- D-2：GPU runtime 归属 `packages/better-harness-desktop/rust/chart-runtime`。main 专属 worker 独占 addon、Dataset、LOD、GPU 初始化/等待；不得阻塞 Electron main 或 Studio Node host。真实时间戳排序/相同时间戳/稀疏采样正确处理，GPU 等待有界，超时进入故障状态且不得提前复用外部租约。
- D-3：版本化最小 preload API 验证发送窗口、主 frame、Studio origin 与入口文档路径。页面只能提交不超过 20,000 个已被服务端截断的真实摘要点，无文件路径、原生句柄、任意方法调用；10M 测试直接在 native 数据层进行。
- D-4：最多两个活跃或排空中的 chart session，每会话最多三个 surface；异步请求关联、单帧背压、全引用释放回执、迟到帧、项目/筛选切换、卸载、导航、关闭和 worker 故障均有测试。same-process worker 指针只传至 main，由 main 导入，不进入 renderer。
- D-5：Desktop 正式构建生成 addon、依赖 NOTICE，开发态和打包态均显式接线；安装包内能加载运行时。macOS 原生 GPU 可用时使用真实 sharedTexture；Windows/Linux/浏览器用真实有界数据的普通 SVG/列表功能，并明确标记后端，不能冒充原生 GPU 已实现。
- D-6：沿用 Studio i18n、主题实际解析的语义颜色、控件、密度；支持滚轮缩放/拖拽/键盘/原始样本选择及来源定位。主视图展示数据而非十个性能指标；详细诊断折叠显示真实 LOD/等待等，GPU execution 无 query 时 N/A。
- D-7：通过 Rust、桥接、UI 行为测试及真实 Desktop（含打包路径）的图像/生命周期验证；宽/紧凑/窄屏、明暗模式无溢出或页面错误。不将 mock、PoC 测试或 macOS 通过冒充完整产品或其它平台证明。

## Desktop Tasks and Non-goals
1. 将原生代码迁入 Desktop 独立 crate（Cargo.lock、license），扩展显式时序加载并保留 10M LOD oracle。
2. 新增 chart worker、host、sandbox preload 与 main 接线；原生阻塞工作移出 main，建立异步租约管理。
3. Studio 可复用图表 Surface + Performance 真实数据适配；跨平台功能保留普通渲染，不扩大为全新图表产品或文件导入平台。
4. 接入 rust build/staging/after-pack/签名/NOTICE，执行正式开发态及打包验收。
5. 退役独立 npm/Electron PoC，避免两套运行时与测试所有权；不改版本、CHANGELOG、roadmap，不提交或发布。

## Historical PoC Acceptance Scenarios
以下为已退役独立实验的验收场景，仅作历史记录；其能力已由 D-2/D-4 覆盖。
- AC-1：Rust 生成 10,000,000 个确定性时序样本，数据不进入 JavaScript；按物理像素分桶输出真实 min/max，按时间排序、去重，输出不超过 `2 × width + 2` 个点。允许预计算范围极值索引，结果须与逐样本扫描一致。
- AC-2：使用 Rust 1.96、re_renderer 0.37.0、wgpu 30.0.1、napi-rs 和 Electron 44。macOS 上真实 IOSurface 经 Electron sharedTexture → VideoFrame → Canvas 展示，禁止位图回传或模拟曲线作为替代。Windows/Linux 的平台边界明确返回 unsupported，不宣称实现或验证。
- AC-3：原生 GPU 提交完成后才能导入；最多三个租用中的输出 surface，仅在 allReferencesReleased 回执后复用。resize、异常、关闭必须遵循同一所有权约束；VideoFrame 和导入引用在 finally 释放。
- AC-4：支持滚轮锚点缩放、拖拽平移、十字线和最近原始样本查询；提供可见缩放/复位按钮及键盘缩放、平移、查询替代。输入按 rAF 合并，单个请求在途，限制尺寸和数据量，拒绝非有限 viewport。
- AC-5：显示 raw/visible/LOD 点数、LOD 毫秒、CPU 编码提交耗时、GPU 等待墙钟耗时和成功绘入 Canvas 的帧率。没有 timestamp query 时 GPU execution time 显示 N/A，不把等待或 CPU 时间标为 GPU 时间。静止时不伪造 60 FPS，可显式开启连续渲染测量。
- AC-6：保持 sandbox、contextIsolation，关闭 nodeIntegration。addon 只在 main 加载；preload 接收纹理并向 DOM Canvas 绘制，React 仅使用白名单桥接。IOSurfaceRef 指针只存在 main，不通过普通 IPC 暴露给页面。
- AC-7：遵循根 DESIGN.md 的语义 token、单图工具栏/指标行，无卡片；验证 1440×900、1024×768、390×844 的焦点、溢出、错误状态和真实图像截图。初始化错误明确可见，无假数据 fallback。

## Historical PoC Non-goals
以下限制针对已退役的独立实验，不再描述 Desktop 实现：完整图表框架、产品菜单/打包接线、新 host、Windows/Linux 共享资源实现、导出文件和发布；同步 GPU 等待阻塞 main 也已由 Desktop 的专属 worker 取代。

## Historical PoC Plan and Tasks
以下独立实验目录已在 Desktop 接入完成后退役，源码迁入 Desktop crate，仅保留为历史记录。
1. `dev/native-chart-poc/native/`：Dataset、精确 MinMax LOD、viewport、hit-test、napi API、re_renderer 离屏渲染和三槽 surface 池；macOS IOSurface 与 Metal/wgpu 互操作独立封装。
2. `dev/native-chart-poc/electron/`：main、sandbox preload、React 单图界面和输入合并；正确导入本进程 IOSurfaceRef Buffer，错误释放与背压。
3. 独立 private `package.json`、构建/启动/测试脚本，输出至本地 `dist`；保留 Cargo.lock。依赖可复用仓库现有安装，不修改产品版本、CHANGELOG 或 roadmap。
4. Rust 单测对照扫描 oracle；Node IPC/交互行为测试；真实 Electron Playwright 验证交互、像素、资源回收与截图，记录版本及实际计时。

## Historical PoC Test and Review Evidence
- AC-1/4：`npm --prefix dev/native-chart-poc test` 的 36 项 Node 行为测试通过；覆盖精确视域、像素上限、输入合并辅助函数及 main 调度/异常/生命周期。`npm --prefix dev/native-chart-poc run test:native` 的 21 项 Rust 测试通过，含扫描 oracle、10M 点、稀疏尖峰、浮点边界和真实 GPU 测试；另有 addon API 与 Electron 三帧像素集成检查通过。
- AC-2/3/6：Apple M4 Pro、Electron 44.2.0、内置 Node 24.20.0 的真实 IOSurface → sharedTexture → VideoFrame → Canvas 验证通过。独立 `npm ci`、release 构建、TypeScript 检查通过；没有借位图 fallback 获得通过结果。
- AC-4/5/7：`npm --prefix dev/native-chart-poc run test:electron` 验证按钮/滚轮缩放、拖拽/键盘平移、原始样本探针、焦点、尺寸/主题更新、0 FPS 静止状态和 reload 释放通过。页面 console/page errors 为零，宽/紧凑/窄屏无横向溢出。
- 该实验的一次回执记录：2816×1055 输出下 10M → 5634 个 LOD 顶点；LOD 2.02 ms、CPU 编码提交 0.17 ms、GPU 等待墙钟 1.86 ms、Canvas 回执帧率 102.2（采样值，不是稳定基准）；107 帧全部释放。
- 该实验期间文档链接完整性 8 项通过；其目录不属于产品构建或发布，且已被退役。

## Desktop Test and Review Evidence
- D-2（原生运行时）：`rust/chart-runtime` 为独立 Desktop crate，`npm --prefix packages/better-harness-desktop run test:chart` 的 44 项测试通过（LOD/timestamp oracle、池与租约、真实 GPU）。真实时间戳分桶、重复时间、epoch 单点与全重复 padding 视域均有断言。构建打包接线由 `test:chart-packaging` 覆盖产物路径、过滤项与 NOTICE 结构。
- D-3/D-4（桥接）：`npm --prefix packages/better-harness-desktop test` 的 71 项行为测试通过（3 项平台相关跳过），覆盖授权（窗口/主 frame/origin/入口路径）、单请求背压、迟到帧、全引用释放确认、超时与有界排空；`npm run smoke:chart-bridge` 用生产 host/worker/preload/addon 在真实 Electron 上验证非均匀/重复时间戳加载、真实共享纹理像素、主题与尺寸更新、真实最近样本查询，并在关闭后把会话排空到 0（`framesReceived/imported/mainReleased/allReferencesReleased/released` 全部为 3）。
- D-6（界面）：Studio `test/native-chart.test.ts` 56 项通过，覆盖有界样本、缺失值语义、真实时间轴、缩放/平移/探针纯函数与 native/Standard 双后端契约；`test/browser/native-chart.spec.mjs` 18 项通过，覆盖三种布局、双主题、滚轮/拖拽/键盘、等距取较晚、Esc 只清探针、重复样本证据关联、能力降级、迟到 open 排空、项目切换与 200% reflow。
- D-5/D-7（打包态）：`better-harness-desktop:build` 全链路通过；`stage` + `electron-builder --dir` 产出安装包，`Contents/Frameworks/harness-chart-runtime.node`（adhoc 已签名）与 `Contents/Resources/native/harness-chart-runtime.NOTICES.txt` 均就位。`npm run smoke:chart-packaged` 在安装包内的真实 Studio 页面完成同一套原生验证：Electron 44.4.2、Metal/IOSurface、真实曲线像素、主题/尺寸更新、真实时间戳查询，并在关闭后把会话排空到 0；`consoleErrors` 为空。截图见 `dist/native-chart-smoke/packaged-light.png`。
- 既有桌面冒烟：`npm test` 71 项通过；`npm run smoke`（dev）与 `node scripts/smoke.mjs --packaged` 均通过，`rendererSandbox`/`httpAuthorization`/`errors: []` 保持，说明加入 preload 与图表控制器未破坏既有安全基线与原生服务链路。
- 观察到的抖动：dev 冒烟曾出现一次未归因的 502（重跑通过）。为此在 `scripts/smoke.mjs` 增加了失败响应 URL 记录，使路由级失败可归因；图表用例在重型构建并发时也曾因启动超过默认等待而失败，串行重跑 18/18 通过。
- 尚未验证：GPU execution time 仍显示 N/A（未启用 timestamp query）；首帧编码/等待明显高于后续帧（首帧 23.2 ms / 30.3 ms），属管线预热，未做稳定基准。开发态本地 Electron 为 44.2.0，锁文件与打包产物为 44.4.2，存在版本漂移。

## Run
- 原生与打包：`npm --prefix packages/better-harness-desktop run build:chart`、`run test:chart`、`run test:chart-packaging`。
- 真实桥接验收：`npm --prefix packages/better-harness-desktop run smoke:chart-bridge`（集成窗口）与 `run smoke:chart-packaged`（安装包内 Studio 页面）；需先构建 addon，回执与截图在 `dist/native-chart-smoke/`。
- 完整桌面：`npm run better-harness-desktop:build` 后 `npm run better-harness-desktop:dev`；安装包验收用 `packages/better-harness-desktop/scripts/smoke.mjs --packaged`。需要 Rust 1.96.0 与 macOS Metal。

## Risks and Boundaries
Electron sharedTexture 属实验 API；unsafe IOSurface/Metal/wgpu 所有权与同步集中在 `packages/better-harness-desktop/rust/chart-runtime/src/platform/macos.rs`，且只允许专门 worker 线程调用（main/Studio host 不得初始化 GPU）。`releaseFrame` 只能由全引用释放回执触发；仍有外部租约时不得 `dispose` 或 terminate worker，宁可保留到进程退出以避免悬垂指针。Windows/Linux 只有 fail-closed 边界与 Studio 侧真实 Standard 渲染，未实现共享输出，也未在实机编译验证；Intel Mac 未测试。锁文件与本地安装的 Electron 版本为 44.4.2 / 实测 44.2.0，存在漂移。没有 Story/issue 或外部 CI 输入，不推断其状态。
