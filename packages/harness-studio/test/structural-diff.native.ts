import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isStructuralDiffResult } from "../src/contracts/structural-diff.js";
import { startHarnessStudioServer, type StartedHarnessStudioServer } from "../src/server/server.js";
import { createRustDiffHost } from "../src/server/workspace/rust-diff-provider.js";

/**
 * The whole chain, with the real engine: Studio -> provider -> (NSXPC bridge on
 * macOS) -> harness-diff-host -> vendored difftastic. The unit suites stub the
 * provider and the driver separately, so only this can catch a mismatch between
 * them.
 */
const here = dirname(fileURLToPath(import.meta.url));
const nativeDir = resolve(here, "../../better-harness-desktop/dist/native");
const STDIO_HOST = join(nativeDir, process.platform === "win32" ? "harness-diff-host.exe" : "harness-diff-host");
// The NSXPC bridge only resolves its launchd service from inside the dev .app.
const NSXPC_BRIDGE = join(nativeDir, "Harness Diff.app", "Contents", "MacOS", "harness-diff-client");

const transports = [
  { transport: "stdio" as const, executable: STDIO_HOST },
  ...(process.platform === "darwin" ? [{ transport: "nsxpc" as const, executable: NSXPC_BRIDGE }] : []),
];

const directories: string[] = [];
let started: StartedHarnessStudioServer | undefined;
let host: ReturnType<typeof createRustDiffHost> | undefined;

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

async function makeGitWorkspace(): Promise<{ path: string; sha: string }> {
  const path = await makeDirectory("studio-structural-native-");
  git(path, "init", "-b", "main");
  git(path, "config", "user.name", "Alice Example");
  git(path, "config", "user.email", "alice@example.com");
  await writeFile(join(path, "view.tsx"), [
    "export function Row(props: { id: string }) {",
    "  return <div data-id={props.id} />;",
    "}",
    "",
  ].join("\n"), "utf8");
  git(path, "add", ".");
  git(path, "commit", "-m", "feat: add row");
  await writeFile(join(path, "view.tsx"), [
    "export function Row(props: { id: string; label: string }) {",
    "  return <div data-id={props.id} data-label={props.label} />;",
    "}",
    "",
  ].join("\n"), "utf8");
  git(path, "add", ".");
  git(path, "commit", "-m", "feat: label the row");
  return { path, sha: git(path, "rev-parse", "HEAD") };
}

const staged = transports.filter((entry) => existsSync(entry.executable));

describe.skipIf(staged.length === 0)("structural diff over the staged host", () => {
  it.each(staged)("reads a real commit file structurally over $transport", async ({ executable, transport }) => {
    const appDir = await makeDirectory("studio-structural-native-app-");
    await writeFile(join(appDir, "index.html"), "<!doctype html><title>Structural native</title>", "utf8");
    const workspace = await makeGitWorkspace();
    const selections = [workspace.path];
    host = createRustDiffHost({ executable, transport, timeoutMs: 60_000 });
    await host.describe();
    started = await startHarnessStudioServer({
      appDir,
      structuralDiffProvider: host,
      workspaceDirectoryPicker: async () => selections.shift(),
      workspaceSessionProvider: { discover: async () => ({ label: "native", sessions: [] }) },
    });
    await fetch(`${started.url}/api/workspace/open`, { method: "POST" });

    const response = await fetch(`${started.url}/api/git/commits/${workspace.sha}/structural-diff?path=view.tsx`);
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(isStructuralDiffResult(payload)).toBe(true);
    expect(payload).toMatchObject({ kind: "StructuralDiffV1", path: "view.tsx", status: "changed", language: "TypeScript TSX" });

    // The engine's value is that it narrows the change. A line-level diff would
    // report both lines as rewritten; a structural one reports only the added
    // tokens, so each side must rebuild its own source line exactly.
    const rows = payload.lines as Array<{ lhs: { segments: Array<{ text: string; novel: boolean }> } | null; rhs: { segments: Array<{ text: string; novel: boolean }> } | null }>;
    const rebuilt = (side: { segments: Array<{ text: string }> } | null): string => side === null ? "" : side.segments.map((segment) => segment.text).join("");
    expect(rebuilt(rows[0]!.lhs)).toBe("export function Row(props: { id: string }) {");
    expect(rebuilt(rows[0]!.rhs)).toBe("export function Row(props: { id: string; label: string }) {");
    const novelOnLeft = rows[0]!.lhs!.segments.filter((segment) => segment.novel).map((segment) => segment.text);
    expect(novelOnLeft).toEqual([]);
    const novelOnRight = rows[0]!.rhs!.segments.filter((segment) => segment.novel).map((segment) => segment.text);
    expect(novelOnRight.join("")).toContain("label");
    // Line 2 changed too, and only its added attribute is marked on the right.
    expect(rows[1]!.rhs!.segments.filter((segment) => segment.novel).map((segment) => segment.text).join("")).toContain("data-label");
    // Line 3 is untouched on both sides.
    expect(rows[2]!.lhs!.segments.every((segment) => !segment.novel)).toBe(true);
    expect(rows[2]!.rhs!.segments.every((segment) => !segment.novel)).toBe(true);
  }, 90_000);
});
