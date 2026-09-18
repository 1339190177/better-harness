import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

/** The host answers this route with a marker only it serves. */
async function isAppsHost(url) {
  try {
    const response = await fetch(`${url}/api/host/info`, { signal: AbortSignal.timeout(700) });
    if (!response.ok) return false;
    const info = await response.json();
    return info?.mode === 'kirocrew-node-host';
  } catch {
    return false;
  }
}

/**
 * Where the host script lives. A packaged build keeps the package inside
 * `app.asar`, which only Electron's patched fs can read; the process that runs
 * it is a plain Node (`ELECTRON_RUN_AS_NODE`), so the path must point at the
 * unpacked mirror electron-builder writes beside the archive.
 */
function hostScriptPath() {
  const resolved = require.resolve('@qoder-ai/harness-studio-apps/server');
  return resolved.replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2');
}

async function waitForHost(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isAppsHost(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

/**
 * Bring up the apps host for this desktop session, or reuse one already
 * running (a previous session, or one the operator started by hand — the
 * desktop never owns what it did not spawn). It comes before Studio so the
 * Studio server can point `--apps-host` at it from its first request.
 *
 * A host that cannot be reached or started returns undefined: Studio then
 * explains the surface instead of hosting it, which beats refusing to start.
 */
export async function startAppsHost({ dataDirectory, ports = [8799, 8800, 8801], readyTimeoutMs = 8000 } = {}) {
  for (const port of ports) {
    const url = `http://127.0.0.1:${port}`;
    if (await isAppsHost(url)) return { url, owned: false, stop: async () => {} };
  }
  const script = hostScriptPath();
  for (const port of ports) {
    const url = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, [
      script,
      '--port', String(port),
      // The host's own state and app-data home live under the desktop's data
      // directory: the packaged app cannot write inside its asar, and the
      // session's enablement should survive a relaunch.
      '--state-dir', join(dataDirectory, 'apps-host'),
      '--home', join(dataDirectory, 'apps-host', 'home'),
    ], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (data) => process.stdout.write(`[apps-host] ${data}`));
    child.stderr?.on('data', (data) => process.stderr.write(`[apps-host] ${data}`));
    let exited = false;
    child.once('exit', () => { exited = true; });
    const ready = await waitForHost(url, readyTimeoutMs);
    if (ready && !exited) {
      return {
        url,
        owned: true,
        stop: () => new Promise((resolve) => {
          if (exited) { resolve(); return; }
          child.once('exit', () => resolve());
          child.kill();
        }),
      };
    }
    // A refused port (EADDRINUSE) exits the child immediately; a silent one is
    // killed here before the next candidate is tried.
    try { child.kill(); } catch { /* already gone */ }
  }
  return undefined;
}
