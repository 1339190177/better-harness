import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect } from '@playwright/test';

// 通过生产 host/worker/preload/addon 走真实 Electron → IOSurface → sharedTexture → Canvas，
// 不使用位图回退，也不把 mock 结果当作原生证据。--packaged 用安装包内的 Studio 页面。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist', 'native-chart-smoke');
const packaged = process.argv.includes('--packaged');
const addon = process.env.HARNESS_CHART_ADDON ?? join(root, 'dist/native/harness-chart-runtime.node');
await mkdir(output, { recursive: true });

// 非均匀时间戳、重复时间与空档：验证真实时间轴而非索引轴。
const base = Date.parse('2026-09-24T09:00:00Z');
const timestamps = [base, base, base + 1500, base + 4000, base + 4000, base + 9750, base + 21300];
const values = [12, 0, 48, 7, 91, 33, 5];
const receipt = { platform: process.platform, mode: packaged ? 'packaged' : 'dev-harness', checks: [], screenshots: [] };

const packagedExecutable = process.platform === 'darwin'
  ? join(root, 'dist', 'installers', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Harness Studio.app', 'Contents', 'MacOS', 'Harness Studio')
  : process.platform === 'win32'
    ? join(root, 'dist', 'installers', 'win-unpacked', 'Harness Studio.exe')
    : join(root, 'dist', 'installers', 'linux-unpacked', 'harness-studio');
const userData = await mkdtemp(join(tmpdir(), 'native-chart-smoke-'));

const application = await electron.launch({
  ...(packaged ? { executablePath: packagedExecutable } : {}),
  args: packaged ? [`--user-data-dir=${userData}`] : [join(root, 'test', 'fixtures', 'native-chart-main.mjs')],
  env: { ...process.env, HARNESS_CHART_ADDON: addon, HARNESS_CHART_USER_DATA: userData },
  timeout: 90_000,
});
const errors = [];
try {
  const page = await application.firstWindow({ timeout: 30_000 });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  // 打包态等 Studio 应用就绪；开发态等集成窗口装载桥接。两者都必须先有版本化桥接。
  await expect.poll(() => page.evaluate(() => typeof window.harnessNativeChart), { timeout: 60_000 }).toBe('object');

  const preferences = await application.evaluate(({ BrowserWindow }) => {
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration };
  });
  assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  receipt.versions = await application.evaluate(() => ({ electron: process.versions.electron, node: process.versions.node }));
  receipt.checks.push('sandbox/contextIsolation/nodeIntegration 与既有 Desktop 基线一致');

  // 驱动脚本同时适用于集成窗口和打包 Studio 页面：只使用版本化桥接契约。
  await page.evaluate(() => {
    const surfaceId = `chart-${crypto.randomUUID()}`;
    const canvas = document.createElement('canvas');
    canvas.id = surfaceId;
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:320px;z-index:2147483647';
    canvas.dataset.surfaceId = surfaceId;
    document.body.append(canvas);
    const metrics = [];
    let session, request = { width: 640, height: 320, background: [255, 255, 255], line: [22, 95, 146] };
    let sequence = 0, pending, scheduled = false;
    window.chartFrames = metrics;
    window.chartSurface = () => canvas;
    // render 的 Promise 只是传输完成；只有 onFrame 回执才算已绘入 Canvas。
    const flush = () => {
      scheduled = false;
      const patch = pending; pending = undefined;
      if (!patch || !session) return;
      request = { ...request, ...patch };
      window.harnessNativeChart.render({ ...request, sessionId: session.sessionId, requestId: ++sequence })
        .catch(error => { window.chartError = String(error); });
    };
    window.render = patch => { pending = patch ?? {}; if (!scheduled) { scheduled = true; requestAnimationFrame(flush); } };
    window.startChart = async (ts, vs) => {
      const open = await window.harnessNativeChart.open({ surfaceId, timestamps: ts, values: vs });
      session = open;
      request = { ...request, from: open.from, to: open.to };
      window.harnessNativeChart.subscribe(surfaceId, frame => { metrics.push(frame); flush(); },
        message => { window.chartError = message; });
      window.render({});
      return open;
    };
    window.probe = async timestamp => {
      const hit = await window.harnessNativeChart.hitTest({ sessionId: session.sessionId, timestamp });
      session.lastHit = hit;
      return hit;
    };
    window.closeChart = async () => {
      const id = session.sessionId;
      session = undefined;
      await window.harnessNativeChart.close(id);
      canvas.remove();
    };
    // 仅测试读取像素，用于证明画布内容来自真实共享纹理。
    window.canvasPixels = () => {
      const rgba = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let line = 0;
      for (let i = 0; i < rgba.length; i += 4) if (rgba[i + 2] > rgba[i] + 20) line++;
      return { width: canvas.width, height: canvas.height, line };
    };
  });
  await page.locator('canvas[data-surface-id]').waitFor();

  const capability = await page.evaluate(() => window.harnessNativeChart.capabilities());
  assert.equal(capability.version, 1);
  if (process.platform !== 'darwin') {
    assert.equal(capability.available, false);
    receipt.backend = capability.reason;
    receipt.result = 'unsupported-platform';
    await writeFile(join(output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(JSON.stringify(receipt, null, 2));
  } else {
    assert.equal(capability.available, true, capability.reason);
    const opened = await page.evaluate(({ timestamps: ts, values: vs }) => window.startChart(ts, vs), { timestamps, values });
    assert.equal(opened.rawPoints, timestamps.length);
    assert.equal(opened.from, base);
    assert.equal(opened.to, base + 21300);
    receipt.backend = opened.backend;
    receipt.loadMs = opened.loadMs;
    assert.match(opened.backend, /Metal/);
    receipt.checks.push('真实原生会话加载非均匀/重复时间戳数据');

    // 真图证据：Canvas 像素来自共享 GPU 纹理，且仅统计成功绘入的回执。
    await expect.poll(() => page.evaluate(() => window.chartFrames.length), { timeout: 30_000 }).toBeGreaterThan(0);
    const failure = await page.evaluate(() => window.chartError);
    assert.equal(failure, undefined, `桥接报告错误：${failure}`);
    const first = await page.evaluate(() => window.canvasPixels());
    assert(first.line > first.width, JSON.stringify(first));
    const metrics = await page.evaluate(() => window.chartFrames.at(-1));
    assert.equal(metrics.rawPoints, timestamps.length);
    assert(metrics.renderedVertices <= metrics.width * 2 + 2);
    assert.equal('handle' in metrics, false);
    receipt.metrics = metrics;
    receipt.checks.push('真实共享纹理曲线像素与有界 LOD 顶点');
    await page.screenshot({ path: join(output, `${receipt.mode}-light.png`) });
    receipt.screenshots.push(join(output, `${receipt.mode}-light.png`));

    // 颜色来自 Studio 语义 token 的 RGB byte，不是硬编码调色板。
    await page.evaluate(() => window.render({ background: [40, 40, 45], line: [124, 188, 236] }));
    await expect.poll(() => page.evaluate(() => window.chartFrames.at(-1).frameId), { timeout: 20_000 })
      .toBeGreaterThan(metrics.frameId);
    const dark = await page.evaluate(() => window.canvasPixels());
    assert(dark.line > dark.width, JSON.stringify(dark));

    // 尺寸变化会替换空闲输出槽，不能与在途租约冲突。
    await page.evaluate(() => window.render({ width: 512 }));
    await expect.poll(() => page.evaluate(() => window.chartFrames.at(-1).width), { timeout: 20_000 }).toBe(512);
    receipt.pool = await application.evaluate(() => globalThis.harnessNativeChartDiagnostics());
    assert(receipt.pool.framesReceived >= 3 && receipt.pool.released >= 2);
    assert(receipt.pool.released <= receipt.pool.framesReceived);
    receipt.checks.push('主题/尺寸更新产生新帧，租约按回执归还');

    // 真实原始样本查询：返回保留数据的最近样本，不返回 LOD 顶点。
    const hit = await page.evaluate(value => window.probe(value), base + 4100);
    assert(Number.isInteger(hit.index) && hit.timestamp === base + 4000 && hit.value === 7);
    receipt.hit = hit;
    receipt.checks.push('真实时间戳最近样本查询');

    await page.evaluate(() => window.closeChart());
    await expect.poll(async () => (await application.evaluate(() => globalThis.harnessNativeChartDiagnostics())).sessions.length,
      { timeout: 20_000 }).toBe(0);
    const drained = await application.evaluate(() => globalThis.harnessNativeChartDiagnostics());
    assert.equal(drained.sessions.length, 0);
    assert(drained.released >= 3);
    receipt.drained = { framesReceived: drained.framesReceived, released: drained.released, allReferencesReleased: drained.allReferencesReleased };
    receipt.checks.push('关闭后会话排空且原生租约全部归还');
    assert.deepEqual(errors, []);
    receipt.consoleErrors = errors;
    receipt.result = 'passed';
    await writeFile(join(output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(JSON.stringify(receipt, null, 2));
  }
} catch (error) {
  receipt.result = 'failed';
  receipt.error = String(error);
  receipt.consoleErrors = errors;
  await writeFile(join(output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  throw error;
} finally {
  await application.close();
  await rm(userData, { recursive: true, force: true, maxRetries: 5 });
}
