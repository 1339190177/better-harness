import { app, BrowserWindow, ipcMain, sharedTexture } from 'electron';
import { createServer } from 'node:http';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeChartController } from '../../src/native-chart-host.mjs';

// 集成验收专用最小窗口：复用生产 host/worker/preload，不复制其逻辑。
// 只在服务根页面加载图表桥接，与 Studio 的 origin/pathname 授权规则一致。
const addonPath = process.env.HARNESS_CHART_ADDON;
if (!isAbsolute(addonPath ?? '')) throw new Error('HARNESS_CHART_ADDON 必须是绝对路径');
// 集成验收不能读写真实用户数据目录。
if (process.env.HARNESS_CHART_USER_DATA) app.setPath('userData', process.env.HARNESS_CHART_USER_DATA);

// 验收驱动由脚本注入；页面只需提供与 Studio 相同的服务根文档。
const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>native chart bridge smoke</title>
<style>html,body{margin:0;height:100%}</style></head><body></body></html>`;

const server = createServer((request, response) => {
  if (request.url !== '/') { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
});
await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
const origin = `http://127.0.0.1:${server.address().port}`;

const charts = createNativeChartController({ ipcMain, sharedTexture, addonPath });
globalThis.harnessNativeChartDiagnostics = () => charts.diagnostics();

// ESM 入口必须先完成求值：顶层等待 ready 会与 Electron 启动互相等待。
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 800, height: 480, show: false,
    webPreferences: {
      preload: fileURLToPath(new URL('../../src/native-chart-preload.cjs', import.meta.url)),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
    },
  });
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(origin)) event.preventDefault(); });
  window.once('ready-to-show', () => window?.show());
  charts.attach(window, origin);

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    event.preventDefault();
    window.destroy();
    Promise.allSettled([charts.stop()]).finally(() => { server.close(); app.exit(0); });
  });
  await window.loadURL(`${origin}/`);
}).catch(error => {
  console.error(error);
  server.close();
  app.exit(1);
});
