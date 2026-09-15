import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { isArchitectureImpact, type ArchitectureImpactProvider, type ArchitectureImpactReading } from "../src/contracts/architecture-impact.js";
import { startHarnessStudioServer, type StartedHarnessStudioServer } from "../src/server/server.js";
import {
  ARCH_HOST_PROTOCOL_VERSION,
  RustArchHostError,
  createRustArchHost,
} from "../src/server/workspace/rust-arch-provider.js";

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

/** Two commits whose second one changes a tracked module. */
async function makeGitWorkspace(): Promise<Fixture> {
  const path = await makeDirectory("studio-architecture-");
  git(path, "init", "-b", "main");
  git(path, "config", "user.name", "Alice Example");
  git(path, "config", "user.email", "alice@example.com");
  await writeFile(join(path, "greeting.ts"), "export const greeting = \"hello\";\n", "utf8");
  git(path, "add", ".");
  git(path, "commit", "-m", "feat: add greeting");
  await writeFile(join(path, "greeting.ts"), "export const greeting = \"hi there\";\n", "utf8");
  git(path, "add", ".");
  git(path, "commit", "-m", "feat: greet differently");
  return { path, sha: git(path, "rev-parse", "HEAD") };
}

/** What `arch.snapshot` answers, in the host's own snake_case wire shape. */
function snapshotResult(changedSymbols = 2): unknown {
  return {
    snapshot: {
      model: {
        elements: [{ id: "api", name: "API", kind: "Container", tags: ["core"], parent_id: "system" }],
        relationships: [{ id: "rel", source_id: "api", target_id: "store", kind: "Imports" }],
      },
      observed_edges: [{ id: "obs", source_id: "api", target_id: "store", kind: "ResolvedCall" }],
      code_hit_ids: ["api"],
      changed_hit_ids: ["api"],
    },
    dsl: "workspace \"Architecture Impact\" \"declared + observed\" {}\n",
    overlay: { changedSymbols, impactedSymbols: 1, impactedFiles: ["greeting.ts"] },
  };
}

function recordingProvider(result: () => unknown): ArchitectureImpactProvider & { calls: Array<{ trackedPaths: string[]; changedPaths: string[]; sources: Array<{ path: string }> }> } {
  const calls: Array<{ trackedPaths: string[]; changedPaths: string[]; sources: Array<{ path: string }> }> = [];
  return {
    calls,
    async architectureImpact(params) {
      calls.push({ trackedPaths: [...params.trackedPaths], changedPaths: [...params.changedPaths], sources: params.sources.map(({ path }) => ({ path })) });
      return result() as ArchitectureImpactReading;
    },
  };
}

describe("arch.snapshot route", () => {
  async function openFixture(provider?: ArchitectureImpactProvider): Promise<Fixture & { url: string }> {
    const appDir = await makeDirectory("studio-architecture-app-");
    await writeFile(join(appDir, "index.html"), "<!doctype html><title>Architecture fixture</title>", "utf8");
    const workspace = await makeGitWorkspace();
    const selections = [workspace.path];
    started = await startHarnessStudioServer({
      appDir,
      ...(provider === undefined ? {} : { architectureImpactProvider: provider }),
      workspaceDirectoryPicker: async () => selections.shift(),
      workspaceSessionProvider: { discover: async () => ({ label: "architecture", sessions: [] }) },
    });
    await fetch(`${started.url}/api/workspace/open`, { method: "POST" });
    return { ...workspace, url: started.url };
  }

  it("says the host is missing rather than answering an empty projection", async () => {
    const fixture = await openFixture();
    const response = await fetch(`${fixture.url}/api/git/commits/${fixture.sha}/architecture`);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({ kind: "CommitArchitectureImpactV1", sha: fixture.sha, status: "unavailable" });
    expect(payload.error).toMatch(/host is unavailable/u);
    // A reader must be able to tell "no impact" from "no reading"; the empty
    // projection is only ever carried by an explicit `unavailable`.
    expect(isArchitectureImpact(payload)).toBe(true);
    expect(payload.dsl).toBe("");
  });

  it("hands the commit's changed sources and tracked paths to the host", async () => {
    const provider = recordingProvider(() => snapshotResult());
    const fixture = await openFixture(provider);
    const payload = await (await fetch(`${fixture.url}/api/git/commits/${fixture.sha}/architecture`)).json();

    expect(payload).toMatchObject({ status: "impact", sha: fixture.sha, dsl: (snapshotResult() as { dsl: string }).dsl });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.changedPaths).toEqual(["greeting.ts"]);
    expect(provider.calls[0]!.sources.map(({ path }) => path)).toEqual(["greeting.ts"]);
    expect(provider.calls[0]!.trackedPaths).toContain("greeting.ts");
  });

  it("separates a change that reached the model from one that did not", async () => {
    const touched = await openFixture(recordingProvider(() => snapshotResult(3)));
    expect(await (await fetch(`${touched.url}/api/git/commits/${touched.sha}/architecture`)).json()).toMatchObject({ status: "impact" });

    const untouched = await openFixture(recordingProvider(() => snapshotResult(0)));
    expect(await (await fetch(`${untouched.url}/api/git/commits/${untouched.sha}/architecture`)).json()).toMatchObject({ status: "no-impact" });
  });

  it("answers a second request for the same commit from cache", async () => {
    const provider = recordingProvider(() => snapshotResult());
    const fixture = await openFixture(provider);
    const url = `${fixture.url}/api/git/commits/${fixture.sha}/architecture`;

    const first = await (await fetch(url)).json();
    const second = await (await fetch(url)).json();
    expect(second).toEqual(first);
    expect(provider.calls).toHaveLength(1);
  });

  it("reports a failed host as unavailable with its reason, not as an unrenderable error", async () => {
    const fixture = await openFixture({
      architectureImpact: async () => { throw new RustArchHostError("Arch host arch.snapshot timed out.", "timeout"); },
    });
    const response = await fetch(`${fixture.url}/api/git/commits/${fixture.sha}/architecture`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "unavailable", error: "Arch host arch.snapshot timed out." });
  });

  it("reports a changed file it refuses to read as unavailable, naming the file", async () => {
    const fixture = await openFixture(recordingProvider(() => snapshotResult()));
    // Larger than the arch host's own per-file bound, so the read is refused
    // rather than truncated into a source the facts layer would misread.
    await writeFile(join(fixture.path, "bulk.ts"), `export const bulk = "${"x".repeat(520_000)}";\n`, "utf8");
    git(fixture.path, "add", ".");
    git(fixture.path, "commit", "-m", "feat: add bulk");
    const sha = git(fixture.path, "rev-parse", "HEAD");

    const response = await fetch(`${fixture.url}/api/git/commits/${sha}/architecture`);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({ kind: "CommitArchitectureImpactV1", sha, status: "unavailable" });
    expect(payload.error).toContain("bulk.ts");
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
  child.pid = 4321;
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

describe("native arch host provider", () => {
  it("describes its own protocol and maps the snapshot onto the Studio contract", async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const child = fakeHostProcess((request) => {
      requests.push({ method: request.method, params: request.params });
      return request.method === "host.describe"
        ? { version: 1, id: request.id, result: { protocol: ARCH_HOST_PROTOCOL_VERSION, pid: 43, capabilities: ["arch.snapshot"] } }
        : { version: 1, id: request.id, result: snapshotResult() };
    });
    const host = createRustArchHost({ executable: "/native/harness-arch-host", spawnProcess: () => child as never });
    try {
      await expect(host.describe()).resolves.toMatchObject({ protocol: ARCH_HOST_PROTOCOL_VERSION });
      const reading = await host.architectureImpact({
        sources: [{ path: "greeting.ts", source: "export const greeting = 1;\n" }],
        trackedPaths: ["greeting.ts"],
        changedPaths: ["greeting.ts"],
      });
      // The wire is snake_case and refuses unknown fields; the contract is
      // camelCase. Both sides are asserted, because a silent mismatch here is
      // an empty diagram a reader would read as "no impact".
      expect(requests[1]!.params).toEqual({
        sources: [{ path: "greeting.ts", source: "export const greeting = 1;\n" }],
        tracked_paths: ["greeting.ts"],
        changed_paths: ["greeting.ts"],
      });
      expect(reading).toEqual({
        elements: [{ id: "api", name: "API", kind: "Container", tags: ["core"], parentId: "system" }],
        relationships: [{ id: "rel", sourceId: "api", targetId: "store", kind: "Imports" }],
        observedEdges: [{ id: "obs", sourceId: "api", targetId: "store", kind: "ResolvedCall" }],
        codeHitIds: ["api"],
        changedHitIds: ["api"],
        overlay: { changedSymbols: 2, impactedSymbols: 1, impactedFiles: ["greeting.ts"] },
        dsl: (snapshotResult() as { dsl: string }).dsl,
      });
    } finally {
      await host.close();
    }
    expect(child.killed).toBe(true);
  });

  it("refuses a host that answers in another shape instead of inventing an empty reading", async () => {
    const child = fakeHostProcess((request) => ({ version: 1, id: request.id, result: { snapshot: { model: { elements: [{ id: "api", kind: "Service" }] } } } }));
    const host = createRustArchHost({ executable: "/native/harness-arch-host", spawnProcess: () => child as never });
    try {
      await expect(host.architectureImpact({ sources: [], trackedPaths: [], changedPaths: [] }))
        .rejects.toMatchObject({ failure: "protocol" });
    } finally {
      await host.close();
    }
  });

  it("refuses a reply that lost a container rather than answering no impact", async () => {
    // A reply missing `snapshot`, `overlay` or `dsl` must not become a zero
    // reading: "no impact" is a finding, and inventing it hides the broken host.
    const valid = snapshotResult() as Record<string, unknown>;
    const without = (field: string): Record<string, unknown> => {
      const copy = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
      delete copy[field];
      return copy;
    };
    for (const result of [without("snapshot"), without("overlay"), without("dsl"), { ...valid, snapshot: [] }, { ...valid, snapshot: { model: { elements: [], relationships: [] } } }]) {
      const child = fakeHostProcess((request) => ({ version: 1, id: request.id, result }));
      const host = createRustArchHost({ executable: "/native/harness-arch-host", spawnProcess: () => child as never });
      try {
        await expect(host.architectureImpact({ sources: [], trackedPaths: [], changedPaths: [] }))
          .rejects.toMatchObject({ failure: "protocol" });
      } finally {
        await host.close();
      }
    }
  });

  it("refuses an oversized request locally instead of letting the host die on it", async () => {
    const child = fakeHostProcess((request) => ({ version: 1, id: request.id, result: snapshotResult() }));
    const host = createRustArchHost({ executable: "/native/harness-arch-host", timeoutMs: 200, spawnProcess: () => child as never });
    try {
      await expect(host.architectureImpact({
        sources: [{ path: "bulk.ts", source: "x".repeat(4 * 1024 * 1024) }],
        trackedPaths: [],
        changedPaths: ["bulk.ts"],
      })).rejects.toMatchObject({ failure: "limit" });
      // The host was never handed a frame it would exit on, so it is still there.
      expect(child.killed).toBe(false);
    } finally {
      await host.close();
    }
  });

  it("refuses a host that never proves the NSXPC hop", async () => {
    const child = fakeHostProcess((request) => ({ version: 1, id: request.id, result: { protocol: ARCH_HOST_PROTOCOL_VERSION } }));
    const host = createRustArchHost({ executable: "/native/harness-arch-client", transport: "nsxpc", timeoutMs: 200, spawnProcess: () => child as never });
    try {
      await expect(host.describe()).rejects.toThrow(/NSXPC/u);
    } finally {
      await host.close();
    }
  });

  it("kills a host that misses its deadline instead of waiting forever", async () => {
    const child = fakeHostProcess(() => undefined);
    const host = createRustArchHost({ executable: "/native/harness-arch-host", timeoutMs: 10, spawnProcess: () => child as never });
    try {
      await expect(host.architectureImpact({ sources: [], trackedPaths: [], changedPaths: [] }))
        .rejects.toMatchObject({ failure: "timeout" });
    } finally {
      await host.close();
    }
    expect(child.killed).toBe(true);
  });

  it("separates a bounded refusal from a malformed request", async () => {
    const child = fakeHostProcess((request) => ({
      version: 1,
      id: request.id,
      error: { code: String(request.params.tracked_paths?.[0]) === "limit" ? "limit/files" : "invalid-path", message: "refused" },
    }));
    const host = createRustArchHost({ executable: "/native/harness-arch-host", spawnProcess: () => child as never });
    try {
      await expect(host.architectureImpact({ sources: [], trackedPaths: ["limit"], changedPaths: [] })).rejects.toMatchObject({ failure: "limit" });
      await expect(host.architectureImpact({ sources: [], trackedPaths: ["other"], changedPaths: [] })).rejects.toMatchObject({ failure: "call" });
    } finally {
      await host.close();
    }
  });
});
