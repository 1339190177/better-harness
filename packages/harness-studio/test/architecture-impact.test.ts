import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { isArchitectureImpact, type ArchitectureImpactProvider, type ArchitectureImpactReading } from "../src/contracts/architecture-impact.js";
import { MAX_HOP_FILES, selectImportHop } from "../src/server/architecture-hop.js";
import { startHarnessStudioServer, type StartedHarnessStudioServer } from "../src/server/server.js";
import {
  ARCH_HOST_PROTOCOL_VERSION,
  RustArchHostError,
  createRustArchHost,
  type RustArchHost,
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

/** The declared model a fixture project publishes, in arch-core's own shape. */
const FIXTURE_MODEL = {
  elements: [{ id: "api", name: "API", kind: "Container", description: null, technology: null, tags: ["core"], parent_id: null }],
  relationships: [],
};

/** Written after the fixture's commits, so it is worktree state, not a change. */
async function writeDeclaredModel(root: string, model: unknown = FIXTURE_MODEL): Promise<void> {
  const directory = join(root, ".better-harness", "architecture");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "model.json"), JSON.stringify(model), "utf8");
  await writeFile(join(directory, "bindings.json"), JSON.stringify([{ path_glob: "**/greeting.ts", element_id: "api" }]), "utf8");
}

/** Two commits whose second one changes a module that a neighbour calls. */
async function makeGitWorkspace(): Promise<Fixture> {
  const path = await makeDirectory("studio-architecture-");
  git(path, "init", "-b", "main");
  git(path, "config", "user.name", "Alice Example");
  git(path, "config", "user.email", "alice@example.com");
  await writeFile(join(path, "greeting.ts"), "export const greeting = \"hello\";\n", "utf8");
  // Tracked and unchanged: the neighbour whose import the hop has to read.
  await writeFile(join(path, "caller.ts"), "import { greeting } from \"./greeting\";\nexport const call = () => greeting;\n", "utf8");
  git(path, "add", "greeting.ts", "caller.ts");
  git(path, "commit", "-m", "feat: add greeting");
  await writeFile(join(path, "greeting.ts"), "export const greeting = \"hi there\";\n", "utf8");
  git(path, "add", "greeting.ts");
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
    skipped: [],
    overlay: { changedSymbols, impactedSymbols: 1, impactedFiles: ["greeting.ts"] },
  };
}

function recordingProvider(result: () => unknown): ArchitectureImpactProvider & { calls: Array<{ trackedPaths: string[]; changedPaths: string[]; sources: Array<{ path: string }>; modelJson: unknown; bindings: Array<{ pathGlob: string; elementId: string }> }> } {
  const calls: Array<{ trackedPaths: string[]; changedPaths: string[]; sources: Array<{ path: string }>; modelJson: unknown; bindings: Array<{ pathGlob: string; elementId: string }> }> = [];
  return {
    calls,
    async architectureImpact(params) {
      calls.push({
        trackedPaths: [...params.trackedPaths],
        changedPaths: [...params.changedPaths],
        sources: params.sources.map(({ path }) => ({ path })),
        modelJson: params.modelJson,
        bindings: [...params.bindings],
      });
      // A provider always answers with the files it could not extract, so a stub
      // has to as well or it is not answering the question that was asked.
      return { skipped: [], ...(result() as Partial<ArchitectureImpactReading>) } as ArchitectureImpactReading;
    },
  };
}
describe("import hop", () => {
  it("offers the neighbours a relative import can reach, never the change itself", () => {
    const hop = selectImportHop(
      ["src/store.ts", "src/api.ts", "src/feature/deep.ts", "docs/readme.md"],
      ["src/store.ts"],
      new Set(),
    );
    // Same directory first, then the one above it; Markdown cannot be parsed.
    expect(hop.candidates).toEqual(["src/api.ts"]);
    expect(hop.truncated).toBe(0);
  });

  it("reaches the directory above the change", () => {
    const hop = selectImportHop(["src/index.ts", "src/feature/store.ts"], ["src/feature/store.ts"], new Set());
    expect(hop.candidates).toEqual(["src/index.ts"]);
  });

  it("stays inside its bound and reports what it left out", () => {
    const tracked = Array.from({ length: MAX_HOP_FILES + 5 }, (_, index) => `src/m${String(index).padStart(3, "0")}.ts`);
    const hop = selectImportHop(tracked, ["src/subject.ts"], new Set());
    expect(hop.candidates).toHaveLength(MAX_HOP_FILES);
    expect(hop.truncated).toBe(5);
    expect(hop.firstDropped).toBe(`src/m${String(MAX_HOP_FILES).padStart(3, "0")}.ts`);
  });
});

describe("arch.snapshot route", () => {
  async function openFixture(
    provider?: ArchitectureImpactProvider,
    options: { declaredModel?: boolean } = {},
  ): Promise<Fixture & { url: string }> {
    const appDir = await makeDirectory("studio-architecture-app-");
    await writeFile(join(appDir, "index.html"), "<!doctype html><title>Architecture fixture</title>", "utf8");
    const workspace = await makeGitWorkspace();
    if (options.declaredModel !== false) await writeDeclaredModel(workspace.path);
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

  it("hands the commit's changed sources, its one-hop neighbours, tracked paths and declared model to the host", async () => {
    const provider = recordingProvider(() => snapshotResult());
    const fixture = await openFixture(provider);
    const payload = await (await fetch(`${fixture.url}/api/git/commits/${fixture.sha}/architecture`)).json();

    expect(payload).toMatchObject({ status: "impact", sha: fixture.sha, dsl: (snapshotResult() as { dsl: string }).dsl });
    expect(payload.omitted).toEqual([]);
    expect(provider.calls).toHaveLength(1);
    // The neighbour is sent as context so a caller the commit did not touch can
    // be found, while the change itself stays exactly the changed file.
    expect(provider.calls[0]!.sources.map(({ path }) => path)).toEqual(["greeting.ts", "caller.ts"]);
    expect(provider.calls[0]!.changedPaths).toEqual(["greeting.ts"]);
    expect(provider.calls[0]!.trackedPaths).toContain("caller.ts");
    // Without the declared model the projection would have nothing to mark, so
    // it has to reach the host, together with the binding that maps paths onto it.
    expect(provider.calls[0]!.modelJson).toEqual(FIXTURE_MODEL);
    expect(provider.calls[0]!.bindings).toEqual([{ pathGlob: "**/greeting.ts", elementId: "api" }]);
  });

  it("says no model was declared rather than showing an empty projection", async () => {
    const provider = recordingProvider(() => snapshotResult());
    const fixture = await openFixture(provider, { declaredModel: false });

    const payload = await (await fetch(`${fixture.url}/api/git/commits/${fixture.sha}/architecture`)).json();
    expect(payload).toMatchObject({ kind: "CommitArchitectureImpactV1", status: "unavailable" });
    expect(payload.error).toContain(".better-harness/architecture/model.json");
    expect(provider.calls).toHaveLength(0);
  });

  it("names a declared model it cannot read instead of ignoring it", async () => {
    const fixture = await openFixture(recordingProvider(() => snapshotResult()));
    await rm(join(fixture.path, ".better-harness"), { recursive: true, force: true });
    await writeFile(join(fixture.path, "workspace.dsl"), "workspace {}\n", "utf8");

    const payload = await (await fetch(`${fixture.url}/api/git/commits/${fixture.sha}/architecture`)).json();
    expect(payload.status).toBe("unavailable");
    expect(payload.error).toContain("workspace.dsl");
    expect(payload.error).toContain("not readable yet");
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

  it("reads the commit around a file it refuses to read, reporting the omission", async () => {
    const provider = recordingProvider(() => snapshotResult());
    const fixture = await openFixture(provider);
    // Larger than the arch host's own per-file bound, so the file is left out of
    // the reading — named, but not allowed to cost the reader every other file.
    await writeFile(join(fixture.path, "bulk.json"), `{"bulk": "${"x".repeat(520_000)}"}\n`, "utf8");
    await writeFile(join(fixture.path, "greeting.ts"), "export const greeting = \"third\";\n", "utf8");
    // Stage only this commit's files: the declared model is worktree state and
    // belongs to no commit under test.
    git(fixture.path, "add", "bulk.json", "greeting.ts");
    git(fixture.path, "commit", "-m", "feat: add bulk beside a change");
    const sha = git(fixture.path, "rev-parse", "HEAD");

    const payload = await (await fetch(`${fixture.url}/api/git/commits/${sha}/architecture`)).json();
    expect(payload).toMatchObject({ kind: "CommitArchitectureImpactV1", sha, status: "impact" });
    expect(payload.omitted).toEqual([{ count: 1, reason: "too-large", examplePath: "bulk.json" }]);
    // The unreadable file is not sent as an empty source, and the commit's other
    // changed file is still read — as is the neighbour the hop adds.
    expect(provider.calls[0]!.sources.map(({ path }) => path)).toEqual(["greeting.ts", "caller.ts"]);
  });

  it("reports a commit past the request budget instead of failing it", async () => {
    const provider = recordingProvider(() => snapshotResult());
    const fixture = await openFixture(provider);
    // Eight 500 KB sources: under the per-file bound, over the 3 MiB budget the
    // reading keeps under the host's 4 MiB frame limit.
    for (let index = 0; index < 8; index += 1) {
      await writeFile(join(fixture.path, `budget-${index}.ts`), `export const value${index} = "${"y".repeat(500_000)}";\n`, "utf8");
    }
    git(fixture.path, "add", ...Array.from({ length: 8 }, (_, index) => `budget-${index}.ts`));
    git(fixture.path, "commit", "-m", "feat: add bulky modules");
    const sha = git(fixture.path, "rev-parse", "HEAD");

    const payload = await (await fetch(`${fixture.url}/api/git/commits/${sha}/architecture`)).json();
    expect(payload.status).toBe("impact");
    expect(payload.omitted).toHaveLength(1);
    expect(payload.omitted[0]).toMatchObject({ reason: "request-budget", count: 2 });
    // Six changed files fit the budget and the seventh does not; the hop's two
    // neighbours cost so little that they still fit after them.
    expect(provider.calls[0]!.sources).toHaveLength(8);
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
  /** Params every provider case can start from; only the case at hand varies. */
  const params = (overrides: Partial<Parameters<RustArchHost["architectureImpact"]>[0]> = {}) => ({
    sources: [], trackedPaths: [], changedPaths: [], modelJson: FIXTURE_MODEL, bindings: [], ...overrides,
  });

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
        modelJson: FIXTURE_MODEL,
        bindings: [{ pathGlob: "**/greeting.ts", elementId: "api" }],
      });
      // The wire is snake_case and refuses unknown fields; the contract is
      // camelCase. Both sides are asserted, because a silent mismatch here is
      // an empty diagram a reader would read as "no impact".
      expect(requests[1]!.params).toEqual({
        sources: [{ path: "greeting.ts", source: "export const greeting = 1;\n" }],
        tracked_paths: ["greeting.ts"],
        changed_paths: ["greeting.ts"],
        model_json: FIXTURE_MODEL,
        bindings: [{ path_glob: "**/greeting.ts", element_id: "api" }],
      });
      expect(reading).toEqual({
        elements: [{ id: "api", name: "API", kind: "Container", tags: ["core"], parentId: "system" }],
        relationships: [{ id: "rel", sourceId: "api", targetId: "store", kind: "Imports" }],
        observedEdges: [{ id: "obs", sourceId: "api", targetId: "store", kind: "ResolvedCall" }],
        codeHitIds: ["api"],
        changedHitIds: ["api"],
        skipped: [],
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
      await expect(host.architectureImpact(params()))
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
    for (const result of [without("snapshot"), without("overlay"), without("dsl"), without("skipped"), { ...valid, snapshot: [] }, { ...valid, snapshot: { model: { elements: [], relationships: [] } } }]) {
      const child = fakeHostProcess((request) => ({ version: 1, id: request.id, result }));
      const host = createRustArchHost({ executable: "/native/harness-arch-host", spawnProcess: () => child as never });
      try {
        await expect(host.architectureImpact(params()))
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
      await expect(host.architectureImpact(params({
        sources: [{ path: "bulk.ts", source: "x".repeat(4 * 1024 * 1024) }],
        changedPaths: ["bulk.ts"],
      }))).rejects.toMatchObject({ failure: "limit" });
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
      await expect(host.architectureImpact(params()))
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
      await expect(host.architectureImpact(params({ trackedPaths: ["limit"] }))).rejects.toMatchObject({ failure: "limit" });
      await expect(host.architectureImpact(params({ trackedPaths: ["other"] }))).rejects.toMatchObject({ failure: "call" });
    } finally {
      await host.close();
    }
  });
});
