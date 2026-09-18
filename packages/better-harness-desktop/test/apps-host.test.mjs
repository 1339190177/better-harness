import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAppsHost } from '../src/apps-host.mjs';

/** A port nothing is listening on, claimed and released just for the test. */
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function tempDataDirectory() {
  return mkdtemp(join(tmpdir(), 'apps-host-test-'));
}

test('starts an owned host, serves the marker route, and stops it cleanly', async () => {
  const dataDirectory = await tempDataDirectory();
  const port = await freePort();
  let host;
  try {
    host = await startAppsHost({ dataDirectory, ports: [port], readyTimeoutMs: 10_000 });
    assert.ok(host, 'the host started');
    assert.equal(host.owned, true);
    assert.equal(host.url, `http://127.0.0.1:${port}`);
    const info = await (await fetch(`${host.url}/api/host/info`)).json();
    assert.equal(info.mode, 'kirocrew-node-host');
    await host.stop();
    await assert.rejects(fetch(`${host.url}/api/host/info`, { signal: AbortSignal.timeout(500) }));
  } finally {
    await host?.stop();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('reuses a running host instead of spawning a second one', async () => {
  const dataDirectory = await tempDataDirectory();
  const port = await freePort();
  let first;
  try {
    first = await startAppsHost({ dataDirectory, ports: [port], readyTimeoutMs: 10_000 });
    assert.ok(first);
    const second = await startAppsHost({ dataDirectory, ports: [port], readyTimeoutMs: 10_000 });
    assert.ok(second);
    assert.equal(second.owned, false);
    assert.equal(second.url, first.url);
  } finally {
    await first?.stop();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('skips a port that answers something other than a host', async () => {
  const squatter = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"mode":"not-the-host"}');
  });
  await new Promise((resolve) => squatter.listen(0, '127.0.0.1', resolve));
  const squattedPort = squatter.address().port;
  const dataDirectory = await tempDataDirectory();
  const freeCandidate = await freePort();
  let host;
  try {
    host = await startAppsHost({ dataDirectory, ports: [squattedPort, freeCandidate], readyTimeoutMs: 10_000 });
    assert.ok(host, 'the host took the free port');
    assert.equal(host.url, `http://127.0.0.1:${freeCandidate}`);
  } finally {
    await host?.stop();
    await new Promise((resolve) => squatter.close(resolve));
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
