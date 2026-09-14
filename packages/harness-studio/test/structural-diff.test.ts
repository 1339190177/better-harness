import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  isStructuralDiffResult,
  type StructuralDiffProvider,
} from "../src/contracts/structural-diff.js";
import { startHarnessStudioServer, type StartedHarnessStudioServer } from "../src/server/server.js";
import {
  DIFF_HOST_PROTOCOL_VERSION,
  RustDiffHostError,
  createRustDiffHost,
} from "../src/server/workspace/rust-diff-provider.js";

const directories: string[] = [];
let started: StartedHarnessStudioServer | undefined;

afterEach(async () => {
  await started?.close();
  started = undefined;
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

interface Fixture {
  path: string;
  sha: string;
}

/** Two commits whose second one changes, adds, and rewrites a binary file. */
async function makeGitWorkspace(): Promise<Fixture> {
  const path = await makeDirectory("studio-structural-");
  git(path, "init", "-b", "main");
  git(path, "config", "user.name", "Alice Example");
  git(path, "config", "user.email", "alice@example.com");
  await writeFile(join(path, "greeting.ts"), "const greeting = \"hello\";\n", "utf8");
  await writeFile(join(path, "logo.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00]));
  git(path, "add", ".");
  git(path, "commit", "-m", "feat: add greeting");
  await writeFile(join(path, "greeting.ts"), "const greeting = \"hi there\";\n", "utf8");
  await writeFile(join(path, "added.ts"), "export const added = 1;\n", "utf8");
  await writeFile(join(path, "logo.bin"), Buffer.from([0x00, 0x09, 0x02, 0x00]));
  git(path, "add", ".");
  git(path, "commit", "-m", "feat: greet differently");
  return { path, sha: git(path, "rev-parse", "HEAD") };
}

/** A structural result that satisfies the contract, so a passing route is meaningful. */
function sampleResult(): unknown {
  const novel = (text: string): unknown[] => [
    { text: "const greeting = ", novel: false, highlight: "normal" },
    { text, novel: true, highlight: "string" },
  ];
  return {
    language: "TypeScript",
    status: "changed",
    lines: [{ lhs: { lineNumber: 1, segments: novel("\"hello\"") }, rhs: { lineNumber: 1, segments: novel("\"hi there\"") } }],
  };
}

function recordingProvider(result: () => unknown): StructuralDiffProvider & { calls: Array<{ path: string; before: string; after: string }> } {
  const calls: Array<{ path: string; before: string; after: string }> = [];
  return {
    calls,
    async structuralDiff(params) {
      calls.push(params);
      return result();
    },
  };
}

describe("StructuralDiffV1 contract", () => {
  it("accepts the shape the host produces", () => {
    expect(isStructuralDiffResult(sampleResult())).toBe(true);
  });

  it("rejects a side that loses its text or numbers", () => {
    const withoutText = sampleResult() as { lines: Array<{ rhs: { segments: Array<Record<string, unknown>> } }> };
    delete withoutText.lines[0]!.rhs.segments[1]!.text;
    expect(isStructuralDiffResult(withoutText)).toBe(false);

    const zeroNumbered = sampleResult() as { lines: Array<{ lhs: { lineNumber: number } }> };
    zeroNumbered.lines[0]!.lhs.lineNumber = 0;
    expect(isStructuralDiffResult(zeroNumbered)).toBe(false);
  });

  it("rejects an unknown status and a non-array line list", () => {
    const badStatus = sampleResult() as { status: string };
    badStatus.status = "rewritten";
    expect(isStructuralDiffResult(badStatus)).toBe(false);

    expect(isStructuralDiffResult({ language: "Rust", status: "changed", lines: "none" })).toBe(false);
  });
});

describe("structural diff route", () => {
  async function openFixture(provider?: StructuralDiffProvider): Promise<Fixture & { url: string }> {
    const appDir = await makeDirectory("studio-structural-app-");
    await writeFile(join(appDir, "index.html"), "<!doctype html><title>Structural fixture</title>", "utf8");
    const workspace = await makeGitWorkspace();
    const selections = [workspace.path];
    started = await startHarnessStudioServer({
      appDir,
      ...(provider === undefined ? {} : { structuralDiffProvider: provider }),
      workspaceDirectoryPicker: async () => selections.shift(),
      workspaceSessionProvider: { discover: async () => ({ label: "structural", sessions: [] }) },
    });
    await fetch(`${started.url}/api/workspace/open`, { method: "POST" });
    return { ...workspace, url: started.url };
  }

  it("reports the capability only when a host is staged", async () => {
    const withoutHost = await openFixture();
    expect(await (await fetch(`${withoutHost.url}/api/config`)).json()).toMatchObject({ structuralDiffEnabled: false });
    const refused = await fetch(`${withoutHost.url}/api/git/commits/${withoutHost.sha}/structural-diff?path=greeting.ts`);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ code: "DIFF_HOST_UNAVAILABLE" });
  });

  it("diffs the two revisions git holds and answers in its own contract", async () => {
    const provider = recordingProvider(() => sampleResult());
    const fixture = await openFixture(provider);
    expect(await (await fetch(`${fixture.url}/api/config`)).json()).toMatchObject({ structuralDiffEnabled: true });

    const response = await fetch(`${fixture.url}/api/git/commits/${fixture.sha}/structural-diff?path=greeting.ts`);
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload).toMatchObject({ kind: "StructuralDiffV1", sha: fixture.sha, path: "greeting.ts", language: "TypeScript", status: "changed" });
    expect(isStructuralDiffResult(payload)).toBe(true);
    // The engine is handed text, never a path it resolves itself.
    expect(provider.calls).toEqual([{ path: "greeting.ts", before: "const greeting = \"hello\";\n", after: "const greeting = \"hi there\";\n" }]);
    // The route is a pass-through over the engine's lines: it must neither drop
    // nor reshape them. That a side's segments rebuild its own line is the
    // engine's invariant, asserted where the segments are produced, in
    // packages/better-harness-desktop/rust/difftastic-core/tests/bridge.rs.
    expect(payload.lines).toEqual((sampleResult() as { lines: unknown }).lines);
  });

  it("reads an added file's older side as empty rather than as a missing revision", async () => {
    const provider = recordingProvider(() => sampleResult());
    const fixture = await openFixture(provider);

    await fetch(`${fixture.url}/api/git/commits/${fixture.sha}/structural-diff?path=added.ts`);
    expect(provider.calls[0]).toMatchObject({ path: "added.ts", before: "" });
    expect(provider.calls[0]!.after).toContain("export const added = 1;");
  });

  it("answers a second request for the same file from cache", async () => {
    const provider = recordingProvider(() => sampleResult());
    const fixture = await openFixture(provider);
    const url = `${fixture.url}/api/git/commits/${fixture.sha}/structural-diff?path=greeting.ts`;

    const first = await (await fetch(url)).json();
    const second = await (await fetch(url)).json();
    expect(second).toEqual(first);
    expect(provider.calls).toHaveLength(1);
  });

  it("refuses a binary file before the engine is asked", async () => {
    const provider = recordingProvider(() => sampleResult());
    const fixture = await openFixture(provider);

    const response = await fetch(`${fixture.url}/api/git/commits/${fixture.sha}/structural-diff?path=logo.bin`);
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ code: "BINARY_FILE" });
    expect(provider.calls).toHaveLength(0);
  });

  it("reports a file the commit does not touch, and a missing path", async () => {
    const fixture = await openFixture(recordingProvider(() => sampleResult()));

    const missing = await fetch(`${fixture.url}/api/git/commits/${fixture.sha}/structural-diff?path=absent.ts`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "FILE_NOT_FOUND" });

    const noPath = await fetch(`${fixture.url}/api/git/commits/${fixture.sha}/structural-diff`);
    expect(noPath.status).toBe(400);
    expect(await noPath.json()).toMatchObject({ code: "INVALID_PATH" });
  });

  it("keeps a host refusal distinguishable from a host failure", async () => {
    const refusing = await openFixture({ structuralDiff: async () => { throw new RustDiffHostError("too slow", "timeout"); } });
    const timedOut = await fetch(`${refusing.url}/api/git/commits/${refusing.sha}/structural-diff?path=greeting.ts`);
    expect(timedOut.status).toBe(504);
    expect(await timedOut.json()).toMatchObject({ code: "STRUCTURAL_DIFF_TIMEOUT" });

    const limited = await openFixture({ structuralDiff: async () => { throw new RustDiffHostError("too big", "limit"); } });
    const tooLarge = await fetch(`${limited.url}/api/git/commits/${limited.sha}/structural-diff?path=greeting.ts`);
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ code: "STRUCTURAL_DIFF_TOO_LARGE" });

    const malformed = await openFixture({ structuralDiff: async () => ({ language: "Rust" }) });
    const failed = await fetch(`${malformed.url}/api/git/commits/${malformed.sha}/structural-diff?path=greeting.ts`);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ code: "STRUCTURAL_DIFF_FAILED" });
  });
});

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  killed: boolean;
  kill: () => void;
}

/** Mirrors the real host: one line in, at most one line out. */
function fakeHostProcess(respond: (request: { id: number; method: string; params: Record<string, unknown> }) => object | undefined): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 9876;
  child.killed = false;
  child.kill = () => { if (child.killed) return; child.killed = true; child.emit("exit", 0); };
  child.stdin.on("data", (chunk: Buffer | string) => {
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) continue;
      const request = JSON.parse(line) as { id: number; method: string; params: Record<string, unknown> };
      const reply = respond(request);
      if (reply !== undefined && !child.killed) child.stdout.write(`${JSON.stringify(reply)}\n`);
    }
  });
  return child;
}

describe("native diff host provider", () => {
  it("describes the protocol and returns a result", async () => {
    const child = fakeHostProcess((request) => request.method === "host.describe"
      ? { version: 1, id: request.id, result: { protocol: DIFF_HOST_PROTOCOL_VERSION, pid: 42 } }
      : { version: 1, id: request.id, result: sampleResult() });
    const host = createRustDiffHost({ executable: "/native/harness-diff-host", spawnProcess: () => child as never });
    try {
      await expect(host.describe()).resolves.toMatchObject({ protocol: DIFF_HOST_PROTOCOL_VERSION });
      await expect(host.structuralDiff({ path: "a.ts", before: "a\n", after: "b\n" })).resolves.toMatchObject({ status: "changed" });
    } finally {
      await host.close();
    }
    expect(child.killed).toBe(true);
  });

  it("refuses a host that never proves the NSXPC hop", async () => {
    const child = fakeHostProcess((request) => ({ version: 1, id: request.id, result: { protocol: DIFF_HOST_PROTOCOL_VERSION } }));
    const host = createRustDiffHost({ executable: "/native/harness-diff-client", transport: "nsxpc", timeoutMs: 200, spawnProcess: () => child as never });
    try {
      await expect(host.describe()).rejects.toThrow(/NSXPC/);
    } finally {
      await host.close();
    }
  });

  it("separates a per-file refusal from an environment failure", async () => {
    const child = fakeHostProcess((request) => ({
      version: 1,
      id: request.id,
      error: { code: String(request.params.path) === "limit" ? "limit/revision" : "invalid-path", message: "refused" },
    }));
    const host = createRustDiffHost({ executable: "/native/harness-diff-host", spawnProcess: () => child as never });
    try {
      await expect(host.structuralDiff({ path: "limit", before: "", after: "" })).rejects.toMatchObject({ failure: "limit" });
      await expect(host.structuralDiff({ path: "other", before: "", after: "" })).rejects.toMatchObject({ failure: "call" });
    } finally {
      await host.close();
    }
  });

  it("kills a host that misses its deadline instead of waiting forever", async () => {
    const child = fakeHostProcess(() => undefined);
    const host = createRustDiffHost({ executable: "/native/harness-diff-host", timeoutMs: 10, spawnProcess: () => child as never });
    try {
      await expect(host.structuralDiff({ path: "a.ts", before: "", after: "" })).rejects.toMatchObject({ failure: "timeout" });
    } finally {
      await host.close();
    }
    expect(child.killed).toBe(true);
  });
});
