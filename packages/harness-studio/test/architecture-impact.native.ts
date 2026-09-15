import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
 * The fixture publishes a declared model, because a projection with no declared
 * elements is exactly the state this test exists to rule out: a commit that
 * changes a bound module has to come back with that element marked.
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
  git(path, "add", "store.ts", "api.ts");
  git(path, "commit", "-m", "feat: add store and api");
  await writeFile(join(path, "api.ts"), "import { load } from \"./store\";\nexport const read = () => load() + 1;\n", "utf8");
  git(path, "add", "api.ts");
  git(path, "commit", "-m", "feat: read one more");
  await writeDeclaredModel(path);
  return { path, sha: git(path, "rev-parse", "HEAD") };
}

/** A declared model with one container bound to the fixture's modules. */
async function writeDeclaredModel(root: string): Promise<void> {
  const directory = join(root, ".better-harness", "architecture");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "model.json"), JSON.stringify({
    elements: [{ id: "api", name: "API", kind: "Container", description: null, technology: "TypeScript", tags: ["core"], parent_id: null }],
    relationships: [],
  }), "utf8");
  await writeFile(join(directory, "bindings.json"), JSON.stringify([{ path_glob: "**/api.ts", element_id: "api" }]), "utf8");
}

const staged = transports.filter((entry) => existsSync(entry.executable));

describe.skipIf(staged.length === 0)("architecture impact over the staged host", () => {
  it.each(staged)("projects a real commit onto the declared model over $transport", async ({ executable, transport }) => {
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
    // And the projection is real: the declared model came back, and the binding
    // marked the element whose module this commit changed.
    expect(payload.elements).toEqual([expect.objectContaining({ id: "api", kind: "Container" })]);
    expect(payload.changedHitIds).toEqual(["api"]);
    expect(payload.omitted).toEqual([]);
    expect(payload.dsl).toContain("workspace");
  }, 90_000);
});
