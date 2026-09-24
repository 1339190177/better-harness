import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { startHarnessStudioServer } from '../../dist/server/server.js';
import { isPerformanceResult } from '../../dist/contracts/session-performance.js';
import { validateRender } from '../../../better-harness-desktop/src/native-chart-protocol.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const base = Date.parse('2026-09-24T09:00:00Z');
// API 证据夹具：刻意保留稀疏时间、重复时间、零与缺失。不是业务生成器或 GPU 证明。
const span = (id, startMs, durationMs, kind, turnId = 'main') => ({ id, startMs, durationMs, kind, turnId,
  endMs: startMs === null || durationMs === null ? null : startMs + durationMs,
  label: id, basis: 'event-pair', status: durationMs === null ? 'incomplete' : 'complete', parentId: null, relationship: null,
  evidence: [{ source: 'segments/timing.jsonl', line: 3, eventType: 'tool.requested', timestampMs: startMs ?? base }], facts: {} });
const spans = [span('late-call', base + 10000, 95, 'tool', 'second'), span('model-call', base, 23, 'model'),
  span('shell-call', base + 1000, 7, 'shell'), span('zero-call', base, 0, 'tool'),
  span('missing-duration', base + 500, null, 'hook'), span('missing-start', null, 10, 'tool')];
const summary = {
  id: 'timing-fixture', provider: 'qoder', label: 'Inspect retained timing evidence', firstSeenMs: base, lastSeenMs: base + 11000, lastActivityMs: base + 11000,
  breakdown: { totalMs: 11000, activityTotalMs: 125, segments: [] },
  wallMs: 11000, completedTurnMs: 5000, timedUnionMs: 125, unattributedTurnMs: 4875, longestMs: 95,
  turnCount: 2, toolCount: 3, retryCount: 0, firstTokenStatus: 'unrecorded',
  usage: { inputTokens: null, outputTokens: null, cacheReadInputTokens: null, cacheCreationInputTokens: null, reasoningOutputTokens: null, totalTokens: null, countedRequests: 0, contextWindow: null, models: [], basis: 'unrecorded' },
  metrics: [], subagents: { count: 0, timedCount: 0, cumulativeMs: null, elapsedMs: null, maxMs: null, peakConcurrency: 0, unlinkedCount: 0, unlinkedTurnCount: 0 },
  findings: [], coverage: { files: 1, events: 9, invalidLines: 0, invalidTimestamps: 0, unreadableFiles: 0, truncated: false, unpairedEvents: 2, ambiguousPairs: 0, clockConflicts: 0 }, status: 'partial',
};
const detail = { schemaVersion: 1, engine: 'rust', session: summary, spans, totalSpans: spans.length, omittedSpans: 0,
  turns: [{ id: 'turn-main', label: 'main', startMs: base, endMs: base + 2000, durationMs: 2000, isSubagent: false, parentSpanId: null, evidence: [] },
    { id: 'turn-second', label: 'second', startMs: base + 8000, endMs: base + 11000, durationMs: 3000, isSubagent: false, parentSpanId: null, evidence: [] }] };
const catalog = { schemaVersion: 1, engine: 'rust', provider: 'qoder', status: 'partial', sessions: [summary], coverage: { discoveredSessions: 1, omittedSessions: 0, directoryLimitReached: false, unreadableDirectories: 0 } };
let root, studio, project, pickedDirectory;
const extraRoots = [];
const projectDetail = workspace => workspace === root ? detail : { ...detail, spans: detail.spans.map(span => ({ ...span, durationMs: span.durationMs === null ? null : span.durationMs + 50 })) };
test.beforeAll(async () => {
  expect(isPerformanceResult(detail, true)).toBe(true); expect(isPerformanceResult(catalog, false)).toBe(true);
  root = await realpath(await mkdtemp(join(tmpdir(), 'native-chart-browser-'))); pickedDirectory = root;
  studio = await startHarnessStudioServer({ appDir: join(packageRoot, 'dist', 'app'), port: 0,
    workspaceDirectoryPicker: async () => pickedDirectory, workspaceSessionProvider: { discover: async () => ({ label: 'Chart fixture', sessions: [] }) },
    sessionPerformanceProvider: { analyzeSessionPerformance: async request => request.source
      ? { schemaVersion: 1, engine: 'rust', source: request.source.source, line: 3, startLine: 2, content: 'model.request.started\ntool.requested\ntool.execution.finished', truncated: false, scannedBytes: 100 }
      : structuredClone(request.sessionId ? projectDetail(request.workspace) : catalog) },
  });
  project = (await (await fetch(`${studio.url}/api/projects/open`, { method: 'POST' })).json()).project;
});
test.afterAll(async () => { await studio?.close(); for (const directory of [root, ...extraRoots].filter(Boolean)) await rm(directory, { recursive: true, force: true }); });
async function open(page, query = '') {
  await page.addInitScript(() => localStorage.setItem('harness-studio-language', 'en'));
  await page.goto(`${studio.url}/#/projects/${project.id}/sessions/performance?session=timing-fixture&turn=all${query}`);
  await expect(page.getByTestId('native-chart-root')).toBeVisible();
  await page.getByTestId('native-chart-canvas').scrollIntoViewIfNeeded();
}
async function range(page) { return page.getByTestId('native-chart-root').evaluate(el => [Number(el.dataset.from), Number(el.dataset.to)]); }
async function bridge(page, options = {}) {
  // mock 只代替 transport/GPU；所有输入必须通过未复制的 Desktop 真协议。
  await page.exposeFunction('__validateChartRender', request => { validateRender(request); });
  await page.addInitScript(options => {
    const callbacks = new Map(), sessions = new Map();
    const state = window.__chartTest = { opens: [], renders: [], closes: [], subscriptions: [], unsubscribed: [], hits: [], autoFrame: false, failOpen: false, delayOpen: false, delayClose: false, ...options };
    state.present = index => {
      const request = state.renders[index], session = sessions.get(request.sessionId);
      if (!session) return;
      const values = session.values.filter((_, i) => session.timestamps[i] >= request.from && session.timestamps[i] <= request.to);
      callbacks.get(session.surfaceId)?.frame({ ...request, surfaceId: session.surfaceId, frameId: index + 1,
        rawPoints: session.values.length, visiblePoints: values.length, renderedVertices: values.length,
        lodMs: 0.1, encodeMs: 0.2, gpuWaitMs: 0.3, yMin: values.length ? Math.min(...values) : 0, yMax: values.length ? Math.max(...values) : 1,
        canvasMs: 0.1, presentedAt: performance.now() });
    };
    state.error = message => { for (const callback of callbacks.values()) callback.error(message); };
    window.harnessNativeChart = {
      capabilities: async () => ({ version: 1, available: options.available !== false, reason: options.available === false ? 'unsupported test platform' : undefined }),
      subscribe: (surfaceId, frame, error) => { state.subscriptions.push(surfaceId); callbacks.set(surfaceId, { frame, error }); return () => { state.unsubscribed.push(surfaceId); callbacks.delete(surfaceId); }; },
      open: async data => {
        if (!callbacks.has(data.surfaceId)) throw new Error('subscribe must precede open');
        state.opens.push(data);
        if (state.failOpen) throw new Error('test backend initialization failed');
        const sessionId = `00000000-0000-4000-8000-${String(state.opens.length).padStart(12, '0')}`;
        if (state.delayOpen) await new Promise(resolve => { state.releaseOpen = resolve; });
        sessions.set(sessionId, data);
        return { sessionId, rawPoints: data.values.length, from: Math.min(...data.timestamps), to: Math.max(...data.timestamps), loadMs: 0.1, backend: 'mock-bridge' };
      },
      render: async request => {
        await window.__validateChartRender(request);
        state.renders.push(request);
        if (state.busyRender) { const code = state.busyRender; state.busyRender = undefined; throw new Error(`${code}: occupied`); }
        if (state.autoFrame) setTimeout(() => state.present(state.renders.indexOf(request)), 10);
        if (state.delayRender) await new Promise(resolve => { state.releaseRender = resolve; });
      },
      hitTest: async request => {
        state.hits.push(request);
        const session = sessions.get(request.sessionId);
        let index = 0;
        for (let i = 1; i < session.timestamps.length; i++) {
          const distance = Math.abs(session.timestamps[i] - request.timestamp), best = Math.abs(session.timestamps[index] - request.timestamp);
          if (distance < best || (distance === best && session.timestamps[i] > session.timestamps[index])) index = i;
        }
        if (state.delayHit) await new Promise(resolve => { state.releaseHit = resolve; });
        return { index, timestamp: session.timestamps[index], value: session.values[index] };
      },
      close: async sessionId => { state.closes.push(sessionId); if (state.delayClose) await new Promise(resolve => { state.releaseClose = resolve; }); sessions.delete(sessionId); },
    };
  }, options);
}

for (const layout of [{ name: 'wide', width: 1440, height: 900 }, { name: 'compact', width: 1024, height: 768 }, { name: 'narrow', width: 390, height: 844 }]) {
  test(`Standard uses retained timestamps and durations: ${layout.name}`, async ({ page }, info) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.setViewportSize(layout); await page.emulateMedia({ colorScheme: 'dark' }); await open(page);
    await expect(page.getByTestId('native-chart-status')).toHaveText('Standard');
    await expect(page.getByTestId('native-chart-root')).toHaveAttribute('data-samples', '4');
    await expect(page.locator('.native-chart-plot')).toHaveCSS('position', 'relative');
    const points = await page.locator('.native-chart-standard polyline').getAttribute('points');
    const x = points.split(' ').map(point => Number(point.split(',')[0]));
    expect(x).toHaveLength(4); expect(x[0]).toBe(x[1]); expect((x[2] - x[0]) / (x[3] - x[0])).toBeCloseTo(0.1);
    await expect(page.locator('.native-chart-x-axis time').first()).toHaveAttribute('datetime', new Date(base).toISOString());
    await expect(page.locator('.native-chart-y-label')).toHaveText('Duration (ms) · 0 – 95');
    await expect(page.locator('.native-chart-diagnostics')).not.toHaveAttribute('open', '');
    await expect(page.locator('.native-chart-plot')).toHaveCSS('background-color', await page.evaluate(() => { const probe = document.createElement('div'); probe.style.background = 'var(--color-workspace)'; document.body.append(probe); const value = getComputedStyle(probe).backgroundColor; probe.remove(); return value; }));
    await page.getByTestId('native-chart-canvas').focus();
    await expect(page.locator('.native-chart-plot')).toHaveCSS('outline-style', 'solid');
    for (const theme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const foreground = await page.getByTestId('native-chart-root').evaluate(el => {
        const probe = document.createElement('span'); probe.style.color = 'var(--color-text)'; el.append(probe);
        const color = getComputedStyle(probe).color; probe.remove(); return color;
      });
      await expect(page.getByTestId('native-chart-zoom-in')).toHaveCSS('color', foreground);
      await page.locator('.native-chart-data > summary').click();
      await expect(page.locator('.native-chart-data li button').first()).toHaveCSS('color', foreground);
      await page.locator('.native-chart-data > summary').click(); await page.getByTestId('native-chart-canvas').focus();
      await page.screenshot({ path: info.outputPath(`native-chart-standard-${layout.name}${theme === 'light' ? '-light' : ''}.png`) });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('.performance-analysis').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test('Standard zoom, wheel, drag, keyboard probes and original evidence stay linked', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await open(page);
  const canvas = page.getByTestId('native-chart-canvas');
  await page.getByTestId('native-chart-zoom-in').click(); await expect.poll(() => range(page)).toEqual([base + 2500, base + 7500]);
  await canvas.focus(); await canvas.press('ArrowRight'); await expect.poll(() => range(page)).toEqual([base + 3000, base + 8000]);
  await canvas.press('Home'); await expect.poll(() => range(page)).toEqual([base, base + 10000]);
  await canvas.press('Shift+ArrowLeft'); await canvas.press('Shift+ArrowLeft');
  await expect(page.getByTestId('native-chart-cursor')).toContainText('model-call');
  await canvas.press('Shift+ArrowRight'); await expect(page.getByTestId('native-chart-cursor')).toContainText('zero-call');
  await canvas.press('Enter'); await expect(page.locator('.performance-evidence')).toBeFocused();
  await expect(page.locator('.performance-evidence-head')).toContainText('zero-call');
  await page.locator('.performance-source-link').first().click(); await expect(page.getByRole('region', { name: 'Source log' })).toBeFocused();
  await page.getByRole('region', { name: 'Source log' }).press('Escape');
  await page.locator('.performance-evidence').press('Escape'); await expect(canvas).toBeFocused();
  await canvas.press('+'); await expect.poll(async () => { const [a, b] = await range(page); return b - a; }).toBe(5000);
  await canvas.press('-'); await expect.poll(() => range(page)).toEqual([base, base + 10000]);
  const box = await canvas.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -300); await expect.poll(async () => { const [a, b] = await range(page); return b - a; }).toBeLessThan(10000);
  const previous = await range(page); await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2); await page.mouse.up();
  await expect.poll(async () => (await range(page))[0]).toBeLessThan(previous[0]);
  await page.getByTestId('native-chart-reset').click();
  await canvas.click({ position: { x: 1, y: box.height / 2 } }); await expect(page.locator('.performance-evidence-head')).toContainText('model-call');
  await page.locator('.performance-evidence').press('Escape');
  await page.getByLabel('Category', { exact: true }).selectOption('tool'); await expect(page.getByTestId('native-chart-root')).toHaveAttribute('data-samples', '2');
  await page.getByLabel('Execution turn', { exact: true }).selectOption('turn-main'); await expect(page.getByTestId('native-chart-root')).toHaveAttribute('data-samples', '1');
  await expect(page.locator('.native-chart-standard circle')).toHaveCount(1);
  await page.locator('.storage-events > summary').click(); await expect(page.locator('.performance-span')).toHaveCount(2);
  await expect(page.locator('.performance-span').filter({ hasText: 'missing-start' })).toBeVisible();
  await page.getByLabel('Category', { exact: true }).selectOption('hook'); await expect(page.getByTestId('native-chart-root')).toHaveAttribute('data-samples', '0');
  await expect(page.getByTestId('native-chart-root')).toContainText('No retained samples');
  await expect(page.locator('.performance-span').filter({ hasText: 'missing-duration' })).toContainText('—');
});

for (const native of [false, true]) {
  test(`${native ? 'mock native' : 'Standard'}: wheel preserves system gestures and normalizes line/page units`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    if (native) await bridge(page, { autoFrame: true });
    await open(page);
    const canvas = page.getByTestId('native-chart-canvas');
    const wheel = options => canvas.evaluate(async (el, options) => {
      const rect = el.getBoundingClientRect();
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, deltaY: -20, ...options });
      el.dispatchEvent(event);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return event.defaultPrevented;
    }, options);
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true },
      { cancelable: false }, { deltaX: 100, deltaY: 0 }, { deltaX: 100, deltaY: -1 }]) {
      expect(await wheel(options)).toBe(false);
      expect(await range(page)).toEqual([base, base + 10000]);
    }
    const units = await canvas.evaluate(el => {
      const style = getComputedStyle(el);
      return [1, parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2, el.getBoundingClientRect().height];
    });
    for (const deltaMode of [0, 1, 2]) {
      await page.getByTestId('native-chart-reset').click(); await expect.poll(() => range(page)).toEqual([base, base + 10000]);
      await page.getByTestId('native-chart-zoom-in').click(); await expect.poll(() => range(page)).toEqual([base + 2500, base + 7500]);
      expect(await wheel({ deltaMode, deltaY: -20 / units[deltaMode] })).toBe(true);
      const [from, to] = await range(page);
      expect(to - from).toBeCloseTo(5000 * Math.exp(-20 * 0.002), 2);
    }
    if (native) await expect(page.getByTestId('native-chart-status')).toHaveText('Native · mock-bridge');
  });
}

for (const eventType of ['pointercancel', 'lostpointercapture']) {
  test(`${eventType} cancels tracking and suppresses clicks; next real click still selects evidence`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 }); await open(page);
    const canvas = page.getByTestId('native-chart-canvas');
    await page.getByTestId('native-chart-zoom-in').click(); await expect.poll(() => range(page)).toEqual([base + 2500, base + 7500]);
    await canvas.evaluate(el => el.addEventListener('pointerdown', event => { el.dataset.pointer = String(event.pointerId); }));
    const box = await canvas.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    // 下一次真实 pointer 事件才激活 pending capture；先激活，再验证丢失捕获。
    await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2);
    await canvas.evaluate((el, eventType) => {
      const pointerId = Number(el.dataset.pointer);
      if (eventType === 'lostpointercapture') el.releasePointerCapture(pointerId);
      else el.dispatchEvent(new PointerEvent(eventType, { bubbles: true, pointerId }));
    }, eventType);
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2); await page.mouse.up();
    await page.waitForTimeout(50);
    expect(await range(page)).toEqual([base + 2500, base + 7500]);
    await expect(page.locator('.performance-evidence')).toHaveCount(0);
    await page.getByTestId('native-chart-reset').click(); await expect.poll(() => range(page)).toEqual([base, base + 10000]);
    await canvas.click({ position: { x: 1, y: box.height / 2 } });
    await expect(page.locator('.performance-evidence-head')).toContainText('model-call');
  });
}

test('Standard midpoint selects the later timestamp; Esc clears only probe and duplicate keyboard evidence stays linked', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await open(page);
  const canvas = page.getByTestId('native-chart-canvas'); await canvas.focus();
  await canvas.evaluate(el => { const rect = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rect.left + rect.width * 0.05 })); });
  await expect(page.getByTestId('native-chart-cursor')).toContainText('shell-call');
  await canvas.press('Escape'); await expect(page.locator('.native-chart-crosshair')).toHaveCount(0);
  await expect(canvas).toBeFocused(); expect(await range(page)).toEqual([base, base + 10000]);
  await canvas.press('Shift+ArrowRight'); await expect(page.getByTestId('native-chart-cursor')).toContainText('model-call');
  await canvas.press('Shift+ArrowRight'); await expect(page.getByTestId('native-chart-cursor')).toContainText('zero-call');
  await canvas.press('Enter'); await expect(page.locator('.performance-evidence-head')).toContainText('zero-call');
  await expect(page.locator('.performance-evidence')).toBeFocused();
});

test('mock bridge: Esc invalidates a pending probe; duplicate keyboard datum keeps original evidence id', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await bridge(page, { autoFrame: true, delayHit: true }); await open(page);
  const canvas = page.getByTestId('native-chart-canvas'); await canvas.focus();
  await canvas.evaluate(el => { const rect = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rect.left })); });
  await expect.poll(() => page.evaluate(() => window.__chartTest.hits.length)).toBe(1);
  await canvas.press('Escape'); await expect(page.locator('.native-chart-crosshair')).toHaveCount(0);
  await page.evaluate(() => { window.__chartTest.delayHit = false; window.__chartTest.releaseHit(); });
  await page.waitForTimeout(50); await expect(page.locator('.native-chart-crosshair')).toHaveCount(0);
  await expect(canvas).toBeFocused(); expect(await range(page)).toEqual([base, base + 10000]);
  await canvas.press('Shift+ArrowRight'); await expect(page.getByTestId('native-chart-cursor')).toContainText('model-call');
  await canvas.press('Shift+ArrowRight'); await expect(page.getByTestId('native-chart-cursor')).toContainText('zero-call');
  await canvas.press('Enter'); await expect(page.locator('.performance-evidence-head')).toContainText('zero-call');
  await expect(page.locator('.performance-evidence')).toBeFocused();
  expect(await page.evaluate(() => window.__chartTest.opens.length)).toBe(1);
});

test('mock bridge: presented-before-transport waits; transient surface pressure recovers without closing', async ({ page }) => {
  await bridge(page, { autoFrame: true, delayRender: true }); await open(page);
  await expect(page.getByTestId('native-chart-status')).toHaveText('Native · mock-bridge');
  await page.getByTestId('native-chart-zoom-in').click(); await page.getByTestId('native-chart-zoom-in').click();
  await expect.poll(async () => { const [from, to] = await range(page); return to - from; }).toBe(2500);
  await page.waitForTimeout(100); expect(await page.evaluate(() => window.__chartTest.renders.length)).toBe(1);
  await page.evaluate(() => { window.__chartTest.delayRender = false; window.__chartTest.busyRender = 'SURFACE_BUSY'; window.__chartTest.releaseRender(); });
  await expect(page.getByTestId('native-chart-status')).toHaveText('Native · mock-bridge');
  expect(await page.evaluate(() => window.__chartTest.renders.length)).toBe(3);
  expect(await page.evaluate(() => window.__chartTest.closes)).toEqual([]);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('surface area and ratio stay valid for native and palette-error Standard fallback', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await bridge(page, { autoFrame: true }); await open(page);
  await expect(page.getByTestId('native-chart-status')).toHaveText('Native · mock-bridge');
  await page.locator('.native-chart-plot').evaluate(el => { el.style.width = '4096px'; el.style.height = '2048px'; });
  await expect.poll(() => page.evaluate(() => window.__chartTest.renders.at(-1).height)).toBeGreaterThan(1000);
  await expect(page.getByTestId('native-chart-status')).toHaveText('Native · mock-bridge');
  const size = await page.evaluate(() => { const { width, height } = window.__chartTest.renders.at(-1); return { width, height }; });
  expect(size.width * size.height).toBeLessThanOrEqual(8_000_000);
  expect(Math.abs(size.width - size.height * 2)).toBeLessThanOrEqual(2);
  await page.locator('.native-chart-plot').evaluate(el => { el.style.backgroundColor = 'transparent'; window.dispatchEvent(new Event('resize')); });
  await expect(page.getByRole('alert')).toBeVisible(); await page.getByRole('button', { name: 'Use Standard' }).click();
  await expect(page.getByTestId('native-chart-standard')).toHaveAttribute('viewBox', `0 0 ${size.width} ${size.height}`);
  await expect(page.locator('.native-chart-standard circle')).toHaveCount(4);
});

test('capability false keeps a real Standard curve', async ({ page }) => {
  await bridge(page, { available: false }); await open(page);
  await expect(page.getByTestId('native-chart-status')).toHaveText('Standard');
  expect(await page.evaluate(() => window.__chartTest.opens.length)).toBe(0);
  await expect(page.locator('.native-chart-standard circle')).toHaveCount(4);
});

test('mock bridge: bounded data, receipt backpressure, theme, resize and hidden lifecycle', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await page.emulateMedia({ colorScheme: 'dark' }); await bridge(page); await open(page);
  await expect.poll(() => page.evaluate(() => window.__chartTest.renders.length)).toBe(1);
  expect(await page.evaluate(() => window.__chartTest.opens[0])).toMatchObject({ timestamps: [base, base, base + 1000, base + 10000], values: [23, 0, 7, 95] });
  await expect(page.getByTestId('native-chart-canvas')).toHaveAttribute('id', /^chart-[0-9a-f-]{36}$/);
  await expect(page.getByTestId('native-chart-status')).toHaveText('Waiting for Canvas…');
  await page.getByTestId('native-chart-zoom-in').click(); await page.getByTestId('native-chart-zoom-in').click();
  await expect.poll(async () => { const [from, to] = await range(page); return to - from; }).toBe(2500);
  expect(await page.evaluate(() => window.__chartTest.renders.length)).toBe(1);
  await page.evaluate(() => window.__chartTest.present(0));
  await expect.poll(() => page.evaluate(() => window.__chartTest.renders.length)).toBe(2);
  expect(await page.evaluate(() => window.__chartTest.renders[1].to - window.__chartTest.renders[1].from)).toBe(2500);
  await page.evaluate(() => { window.__chartTest.autoFrame = true; window.__chartTest.present(1); });
  await expect(page.getByTestId('native-chart-status')).toHaveText('Native · mock-bridge');
  const beforeTheme = await page.evaluate(() => window.__chartTest.renders.at(-1).background);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => page.evaluate(() => window.__chartTest.renders.at(-1).background)).not.toEqual(beforeTheme);
  const palette = await page.locator('.native-chart-plot').evaluate(el => { const style = getComputedStyle(el); const rgb = text => text.match(/[\d.]+/g).slice(0, 3).map(Number).map(Math.round); return { background: rgb(style.backgroundColor), line: rgb(style.color) }; });
  expect(await page.evaluate(() => { const { background, line } = window.__chartTest.renders.at(-1); return { background, line }; })).toEqual(palette);
  const beforeResize = await page.evaluate(() => window.__chartTest.renders.at(-1).width);
  await page.setViewportSize({ width: 1024, height: 768 }); await page.getByTestId('native-chart-canvas').scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => window.__chartTest.renders.at(-1).width)).not.toBe(beforeResize);
  await page.getByTestId('native-chart-canvas').hover(); await expect.poll(() => page.evaluate(() => window.__chartTest.hits.length)).toBeGreaterThan(0);
  await page.locator('.performance-analysis').evaluate(el => { el.style.paddingBottom = '2000px'; el.scrollTop = el.scrollHeight; });
  await expect(page.getByTestId('native-chart-canvas')).not.toBeInViewport();
  await page.waitForTimeout(150);
  const idle = await page.evaluate(() => window.__chartTest.renders.length);
  await page.setViewportSize({ width: 1010, height: 768 }); await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__chartTest.renders.length)).toBe(idle);
  await page.locator('.performance-analysis').evaluate(el => { el.style.paddingBottom = ''; });
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(50); const hidden = await page.evaluate(() => window.__chartTest.renders.length);
  await page.setViewportSize({ width: 1000, height: 760 }); await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__chartTest.renders.length)).toBe(hidden);
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await page.getByLabel('Category', { exact: true }).selectOption('tool');
  await expect.poll(() => page.evaluate(() => window.__chartTest.closes.length)).toBe(1);
  await page.getByTestId('native-chart-canvas').scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => window.__chartTest.opens.length)).toBe(2);
  expect(await page.evaluate(() => window.__chartTest.opens[1].values)).toEqual([0, 95]);
  await page.evaluate(() => location.hash = location.hash.split('/sessions/performance')[0] + '/sessions');
  await expect.poll(() => page.evaluate(() => window.__chartTest.closes.length)).toBe(2);
});

test('mock bridge: initialization/runtime errors, Standard recovery and retry', async ({ page }) => {
  await bridge(page, { failOpen: true }); await open(page);
  await expect(page.getByRole('alert')).toContainText('test backend initialization failed');
  await page.getByRole('button', { name: 'Use Standard' }).click(); await expect(page.getByTestId('native-chart-status')).toHaveText('Standard');
  await expect(page.locator('.native-chart-standard circle')).toHaveCount(4);
  await page.reload(); await page.getByTestId('native-chart-canvas').scrollIntoViewIfNeeded();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.evaluate(() => { window.__chartTest.failOpen = false; window.__chartTest.autoFrame = true; });
  await page.getByRole('button', { name: 'Retry native chart' }).click();
  await expect(page.getByTestId('native-chart-status')).toHaveText('Native · mock-bridge');
  await page.evaluate(() => window.__chartTest.error('test worker failed'));
  await expect(page.getByRole('alert')).toContainText('test worker failed');
  await expect.poll(() => page.evaluate(() => window.__chartTest.closes.length)).toBe(1);
  await page.getByRole('button', { name: 'Use Standard' }).click(); await expect(page.getByTestId('native-chart-status')).toHaveText('Standard');
});

test('mock bridge: late open is drained before filtered data opens', async ({ page }) => {
  await bridge(page, { delayOpen: true, delayClose: true }); await open(page);
  await expect.poll(() => page.evaluate(() => window.__chartTest.opens.length)).toBe(1);
  await page.getByLabel('Category', { exact: true }).selectOption('tool'); await page.getByTestId('native-chart-canvas').scrollIntoViewIfNeeded();
  await page.evaluate(() => { window.__chartTest.delayOpen = false; window.__chartTest.releaseOpen(); });
  await expect.poll(() => page.evaluate(() => window.__chartTest.closes.length)).toBe(1);
  expect(await page.evaluate(() => window.__chartTest.opens.length)).toBe(1);
  await page.evaluate(() => { window.__chartTest.delayClose = false; window.__chartTest.releaseClose(); });
  await expect.poll(() => page.evaluate(() => window.__chartTest.opens.length)).toBe(2);
  expect(await page.evaluate(() => window.__chartTest.unsubscribed.length)).toBe(1);
});

test('Chinese, reduced motion and 200% reflow keep evidence accessible', async ({ page }, info) => {
  await page.setViewportSize({ width: 1024, height: 768 }); await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await open(page); await page.evaluate(() => { localStorage.setItem('harness-studio-language', 'zh-CN'); });
  // init script 的 English 偏好会在 reload 生效，显式后置设置当前页面语言存储。
  await page.addInitScript(() => localStorage.setItem('harness-studio-language', 'zh-CN')); await page.reload();
  await expect(page.getByTestId('native-chart-root')).toContainText('调用耗时趋势');
  await page.evaluate(() => document.documentElement.style.zoom = '2'); await page.getByTestId('native-chart-canvas').scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.locator('.native-chart-data > summary').click(); await expect(page.locator('.native-chart-data li button')).toHaveCount(4);
  await page.locator('.native-chart-data li button').first().click(); await expect(page.locator('.performance-evidence')).toContainText('model-call');
  await page.screenshot({ path: info.outputPath('native-chart-zh-reflow.png') });
});

test('mock bridge: project change closes the old session and cannot reuse its samples', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await bridge(page, { autoFrame: true }); await open(page);
  await expect(page.getByTestId('native-chart-status')).toHaveText('Native · mock-bridge');
  const previousId = await page.getByTestId('native-chart-canvas').getAttribute('id');
  pickedDirectory = await realpath(await mkdtemp(join(tmpdir(), 'native-chart-project-'))); extraRoots.push(pickedDirectory);
  // 走正式入口刷新 shell 的项目目录；仅向 API 发请求不会更新当前页面的项目状态。
  await page.locator('.studio-project-switcher > button').click();
  const opened = page.waitForResponse(response => /\/api\/projects\/open(?:\?|$)/.test(response.url()) && response.request().method() === 'POST');
  await page.locator('.studio-project-open').click();
  const nextProject = (await (await opened).json()).project;
  expect(nextProject.id).not.toBe(project.id);
  await expect(page).toHaveURL(new RegExp(`/projects/${nextProject.id}/sessions/performance`));
  await expect(page.getByTestId('native-chart-canvas')).not.toHaveAttribute('id', previousId);
  await page.getByLabel('Execution turn', { exact: true }).selectOption('all');
  await page.getByTestId('native-chart-canvas').scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => window.__chartTest.closes)).toContain('00000000-0000-4000-8000-000000000001');
  await expect.poll(() => page.evaluate(() => window.__chartTest.opens.at(-1).values)).toEqual([73, 50, 57, 145]);
  await expect(page.getByTestId('native-chart-status')).toHaveText('Native · mock-bridge');
});
