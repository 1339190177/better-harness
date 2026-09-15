import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isArchitectureImpact } from "../src/contracts/architecture-impact.js";
import { startHarnessStudioServer, type StartedHarnessStudioServer } from "../src/server/server.js";
import { createRustArchHost } from "../src/server/workspace/rust-arch-provider.js";

/**
 * The whole chain, with the real host: Studio -> provider -> (NSXPC bridge on
 * macOS) -> harness-arch-host -> arch-core. The unit suite stubs the driver, so
 * only this can catch a mismatch between the wire contract and the provider.
 *
 * The declared model is deliberately absent here. Discovery of `workspace.dsl`
 * / `workspace.json` is its own spec task, so this asserts the reading the pane
 * can make today: the change overlay is real, and "no declared elements" is not
 * reported as "host is unavailable".
 */
const here = dirname(fileURLToPath(import.meta.url));
const nativeDir = resolve(here, "../../better-harness-desktop/dist/native");
const STDIO_HOST = join(nativeDir, process.platform === "win32" ? "harness-arch-host.exe" : "harness-arch-host");
// The NSXPC bridge only resolves its launchd service from inside the dev .app.
const NSXPC_BRIDGE = join(nativeDir, "Harness Arch.app", "Contents", "MacOS", "harness-arch-client");

const transports = [
  { transport: "stdio" as const, executable: STDIO_HOST },
  ...(process.platform === "darwin" ? [{ transport: "nsxpc" as const, executable: NSXPC_BRIDGE }] : []),
];

const directories: string[] = [];
let started: StartedHarnessStudioServer | undefined;
let host: ReturnType<typeof createRustArchHost> | undefined;

afterEach(async () => {
  await started?.close();
  started = undefined;
  await host?.close();
  host = undefined;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function git(repoPath: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repoPath, encoding: "utf8" }).trim();
}

async function makeDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

/** Two commits whose second one changes a module that imports another one. */
async function makeGitWorkspace(): Promise<{ path: string; sha: string }> {
  const path = await makeDirectory("studio-architecture-native-");
  git(path, "init", "-b", "main");
  git(path, "config", "user.name", "Alice Example");
  git(path, "config", "user.email", "alice@example.com");
  await writeFile(join(path, "store.ts"), "export function load(): number {\n  return 1;\n}\n", "utf8");
  await writeFile(join(path, "api.ts"), "import { load } from \"./store\";\nexport const read = () => load();\n", "utf8");
  git(path, "add", ".");
  git(path, "commit", "-m", "feat: add store and api");
  await writeFile(join(path, "api.ts"), "import { load } from \"./store\";\nexport const read = () => load() + 1;\n", "utf8");
  git(path, "add", ".");
  git(path, "commit", "-m", "feat: read one more");
  return { path, sha: git(path, "rev-parse", "HEAD") };
}

const staged = transports.filter((entry) => existsSync(entry.executable));

describe.skipIf(staged.length === 0)("architecture impact over the staged host", () => {
  it.each(staged)("reads a real commit's impact over $transport instead of reporting the host unavailable", async ({ executable, transport }) => {
    const appDir = await makeDirectory("studio-architecture-native-app-");
    await writeFile(join(appDir, "index.html"), "<!doctype html><title>Architecture native</title>", "utf8");
    const workspace = await makeGitWorkspace();
    const selections = [workspace.path];
    host = createRustArchHost({ executable, transport, timeoutMs: 60_000 });
    await host.describe();
    started = await startHarnessStudioServer({
      appDir,
      architectureImpactProvider: host,
      workspaceDirectoryPicker: async () => selections.shift(),
      workspaceSessionProvider: { discover: async () => ({ label: "native", sessions: [] }) },
    });
    await fetch(`${started.url}/api/workspace/open`, { method: "POST" });

    const response = await fetch(`${started.url}/api/git/commits/${workspace.sha}/architecture`);
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(isArchitectureImpact(payload)).toBe(true);
    expect(payload).toMatchObject({ kind: "CommitArchitectureImpactV1", sha: workspace.sha, status: "impact" });
    expect(payload.error).toBeUndefined();
    // The facts layer really ran: the changed module carries symbols, and the
    // overlay counts them rather than answering a zero it never computed.
    expect(payload.overlay.changedSymbols).toBeGreaterThan(0);
    expect(payload.overlay.impactedFiles.length).toBeGreaterThan(0);
    // No declared model is discovered yet, so the projection has no elements —
    // which is a reading, not an "unavailable".
    expect(payload.elements).toEqual([]);
    expect(payload.dsl).toContain("workspace");
  }, 90_000);
});
