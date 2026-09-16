import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { isArchitectureImpact, type ArchitectureImpactProvider, type ArchitectureImpactReading } from "../src/contracts/architecture-impact.js";
import { elementsOwningPath, simpleGlobMatch } from "../src/server/architecture-bindings.js";
import { MAX_HOP_FILES, selectImportHop } from "../src/server/architecture-hop.js";
import { isExtractable, isSourceLike } from "../src/server/architecture-sources.js";
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

/**
 * Rewrite the worktree's bindings. A reading resolves them per request, so a test
 * can hand the same commit a different projection without touching the commits.
 */
async function writeBindings(root: string, bindings: unknown): Promise<void> {
  await writeFile(join(root, ".better-harness", "architecture", "bindings.json"), JSON.stringify(bindings), "utf8");
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
    impactedHitIds: [],
    overlay: { changedSymbols, impactedSymbols: 1, impactedFiles: ["greeting.ts"] },
  };
}

/** A provider's reading, in the contract's own shape rather than the host's. */
function readingStub(overrides: Partial<ArchitectureImpactReading> = {}): ArchitectureImpactReading {
  return {
    elements: [], relationships: [], observedEdges: [], codeHitIds: [], changedHitIds: [], impactedHitIds: [],
    overlay: { changedSymbols: 2, impactedSymbols: 1, impactedFiles: [] },
    dsl: "workspace \"Architecture Impact\" {}\n",
    skipped: [],
    ...overrides,
  };
}

/** One provider call, recorded so a test can assert what the host was handed. */
interface ProviderCall {
  trackedPaths: string[];
  changedPaths: string[];
  sources: Array<{ path: string }>;
  modelJson: unknown;
  bindings: Array<{ pathGlob: string; elementId: string }>;
}

function recordingProvider(result: (call: ProviderCall) => unknown): ArchitectureImpactProvider & { calls: ProviderCall[] } {
  const calls: ProviderCall[] = [];
  return {
    calls,
    async architectureImpact(params) {
      const call: ProviderCall = {
        trackedPaths: [...params.trackedPaths],
        changedPaths: [...params.changedPaths],
        sources: params.sources.map(({ path }) => ({ path })),
        modelJson: params.modelJson,
        bindings: [...params.bindings],
      };
      calls.push(call);
      // A provider always answers with the files it could not extract, so a stub
      // has to as well or it is not answering the question that was asked.
      return { skipped: [], ...(result(call) as Partial<ArchitectureImpactReading>) } as ArchitectureImpactReading;
    },
  };
}

/** The paths a stub host could not extract, from the sources it was handed. */
function unreadByHost(sources: Array<{ path: string }>): Array<{ path: string; diagnostics: string[] }> {
  return sources
    .filter(({ path }) => !isExtractable(path))
    .map(({ path }) => ({ path, diagnostics: [`unsupported language for ${path}`] }));
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

describe("source scope", () => {
  it("keeps documents, data, markup, styles and assets out of the reading", () => {
    for (const path of ["docs/notes.md", "package.json", "index.html", "app.css", "logo.svg", "Cargo.lock", "Makefile", ".babelrc"]) {
      expect(isSourceLike(path), path).toBe(false);
    }
  });

  it("keeps code in a language the host does not extract in it", () => {
    for (const path of ["probe.go", "src/app.py", "lib.rs", "script.sh", "App.vue"]) {
      expect(isSourceLike(path), path).toBe(true);
      expect(isExtractable(path), path).toBe(false);
    }
    expect(isSourceLike("store/index.ts")).toBe(true);
    expect(isExtractable("store/index.ts")).toBe(true);
  });
});

describe("binding globs", () => {
  it("matches the shapes arch-core matches, and no more", () => {
    // One path per branch of the host's matcher, so a pane that names an element
    // and a diagram that marks one cannot disagree about the same path.
    expect(simpleGlobMatch("packages/api/src/handler.ts", "packages/api/**")).toBe(true);
    expect(simpleGlobMatch("greeting.ts", "**/greeting.ts")).toBe(true);
    expect(simpleGlobMatch("src/deep/greeting.ts", "**/greeting.ts")).toBe(true);
    expect(simpleGlobMatch("src/deep/hello.ts", "**/greeting.ts")).toBe(false);
    expect(simpleGlobMatch("store.ts", "store.ts")).toBe(true);
    expect(simpleGlobMatch("store/index.ts", "store.ts")).toBe(false);
    expect(simpleGlobMatch("anything/at/all.ts", "**")).toBe(true);
    // A directory glob is a prefix test in the host, not a path-segment one, and
    // the pane repeats that rather than being the stricter of the two.
    expect(simpleGlobMatch("packages/apifoo/src/handler.ts", "packages/api/**")).toBe(true);
  });

  it("names every element a path sits in, once, in binding order", () => {
    const bindings = [
      { pathGlob: "**/store.ts", elementId: "store" },
      { pathGlob: "**", elementId: "repo" },
      { pathGlob: "**/store.ts", elementId: "store" },
    ];
    expect(elementsOwningPath("store.ts", bindings)).toEqual(["store", "repo"]);
    expect(elementsOwningPath("docs/notes.md", bindings)).toEqual(["repo"]);
    expect(elementsOwningPath("docs/notes.md", [])).toEqual([]);
  });
});

describe("impact contract", () => {
  const reading = {
    kind: "CommitArchitectureImpactV1",
    sha: "a".repeat(40),
    status: "no-impact",
    elements: [], relationships: [], impactedHitIds: [], dsl: "", files: [], omitted: [],
  };

  it("refuses a file list that is not the contract", () => {
    // A row without a path, or with a standing nobody defined, would render as a
    // blank line a reader would take for a file named "".
    expect(isArchitectureImpact(reading)).toBe(true);
    expect(isArchitectureImpact({ ...reading, files: undefined })).toBe(false);
    expect(isArchitectureImpact({ ...reading, files: [{ path: "", state: "not-source", elementIds: [] }] })).toBe(false);
    expect(isArchitectureImpact({ ...reading, files: [{ path: "a.ts", state: "somewhere", elementIds: [] }] })).toBe(false);
    expect(isArchitectureImpact({ ...reading, files: [{ path: "a.ts", state: "unparsed" }] })).toBe(false);
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
    // No change was read at all, so there is no file list either: the pane shows
    // nothing where a commit is concerned rather than an empty commit.
    expect(payload.files).toEqual([]);
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

  it("projects onto a model generated from the worktree when none is declared", async () => {
    const provider = recordingProvider(() => snapshotResult());
    const fixture = await openFixture(provider, { declaredModel: false });

    const payload = await (await fetch(`${fixture.url}/api/git/commits/${fixture.sha}/architecture`)).json();
    // An absent declared model is no longer a dead end: the pane projects onto a
    // model derived from the worktree, marked `generated` so a reader can tell it
    // from an authored one rather than reading it as a declared fact.
    expect(payload).toMatchObject({ kind: "CommitArchitectureImpactV1", status: "impact" });
    expect(payload.modelSource).toMatchObject({ origin: "generated" });
    expect(provider.calls).toHaveLength(1);
    // The generated model reaches the host in arch-core's own shape, and every
    // element it holds is tagged `generated` rather than presented as declared.
    const modelJson = provider.calls[0]!.modelJson as { elements: Array<{ kind: string; tags: string[] }> };
    expect(modelJson.elements[0]).toMatchObject({ kind: "SoftwareSystem" });
    expect(modelJson.elements.every((element) => element.tags.includes("generated"))).toBe(true);
  });

  it("marks a declared reading as declared, not generated", async () => {
    const provider = recordingProvider(() => snapshotResult());
    const fixture = await openFixture(provider);

    const payload = await (await fetch(`${fixture.url}/api/git/commits/${fixture.sha}/architecture`)).json();
    expect(payload.modelSource).toEqual({ origin: "declared" });
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

  it("names the elements the radius reached, apart from the ones it changed", async () => {
    // The pane marks the two states differently, so the reading has to carry them
    // separately: one element changed, another was reached by the change.
    const provider = recordingProvider(() => readingStub({ changedHitIds: ["api"], impactedHitIds: ["store"] }));
    const fixture = await openFixture(provider);

    const payload = await (await fetch(`${fixture.url}/api/git/commits/${fixture.sha}/architecture`)).json();
    expect(payload.changedHitIds).toEqual(["api"]);
    expect(payload.impactedHitIds).toEqual(["store"]);
  });

  it("saves a generated model as the declared one, and then reads it as declared", async () => {
    const provider = recordingProvider(() => snapshotResult());
    const fixture = await openFixture(provider, { declaredModel: false });

    const before = await (await fetch(`${fixture.url}/api/git/commits/${fixture.sha}/architecture`)).json();
    expect(before.modelSource).toMatchObject({ origin: "generated" });

    const save = await fetch(`${fixture.url}/api/git/architecture/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(save.status).toBe(200);
    expect(await save.json()).toMatchObject({ saved: true, origin: "declared" });

    // The file is now on disk, in the arch-core shape the discovery validates,
    // and the next reading projects onto it as a declared model.
    const written: unknown = JSON.parse(await readFile(join(fixture.path, ".better-harness", "architecture", "model.json"), "utf8"));
    expect(Array.isArray((written as { elements?: unknown }).elements)).toBe(true);
    const after = await (await fetch(`${fixture.url}/api/git/commits/${fixture.sha}/architecture`)).json();
    expect(after.modelSource).toEqual({ origin: "declared" });
  });

  it("refuses to overwrite a declared model unless the save confirms it", async () => {
    const fixture = await openFixture(recordingProvider(() => snapshotResult()));

    const blocked = await fetch(`${fixture.url}/api/git/architecture/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).code).toBe("ARCH_MODEL_DECLARED");

    const forced = await fetch(`${fixture.url}/api/git/architecture/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overwrite: true }),
    });
    expect(forced.status).toBe(200);
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
    await writeFile(join(fixture.path, "bulk.ts"), `export const bulk = "${"x".repeat(520_000)}";\n`, "utf8");
    await writeFile(join(fixture.path, "greeting.ts"), "export const greeting = \"third\";\n", "utf8");
    // Stage only this commit's files: the declared model is worktree state and
    // belongs to no commit under test.
    git(fixture.path, "add", "bulk.ts", "greeting.ts");
    git(fixture.path, "commit", "-m", "feat: add bulk beside a change");
    const sha = git(fixture.path, "rev-parse", "HEAD");

    const payload = await (await fetch(`${fixture.url}/api/git/commits/${sha}/architecture`)).json();
    expect(payload).toMatchObject({ kind: "CommitArchitectureImpactV1", sha, status: "impact" });
    expect(payload.omitted).toEqual([{ count: 1, reason: "too-large", examplePath: "bulk.ts" }]);
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

  it("keeps documents out of the reading instead of naming them unread", async () => {
    // The host reports whatever it was handed and could not extract, so a document
    // that reaches it comes back as an omission: the reading has to keep its own
    // scope rather than pass prose through to the notice.
    const provider = recordingProvider((call) => ({ ...(snapshotResult() as object), skipped: unreadByHost(call.sources) }));
    const fixture = await openFixture(provider);
    await mkdir(join(fixture.path, "docs", "specs"), { recursive: true });
    await writeFile(join(fixture.path, "docs", "specs", "notes.md"), "# Notes\n", "utf8");
    await writeFile(join(fixture.path, "Cargo.lock"), "version = 4\n", "utf8");
    await writeFile(join(fixture.path, "greeting.ts"), "export const greeting = \"documented\";\n", "utf8");
    git(fixture.path, "add", "docs/specs/notes.md", "Cargo.lock", "greeting.ts");
    git(fixture.path, "commit", "-m", "feat: document the greeting");
    const sha = git(fixture.path, "rev-parse", "HEAD");

    const payload = await (await fetch(`${fixture.url}/api/git/commits/${sha}/architecture`)).json();
    expect(payload.omitted).toEqual([]);
    // Nothing that carries no symbols is read or sent: the budget belongs to the
    // code half of the commit.
    expect(provider.calls[0]!.sources.map(({ path }) => path)).toEqual(["greeting.ts", "caller.ts"]);
  });

  it("names the code it could not read, apart from a file the parser rejected", async () => {
    const provider = recordingProvider(() => ({
      ...(snapshotResult() as object),
      // A host that answers about a document is not the authority on what the
      // reading is about, and "could not parse" is not "cannot read this
      // language": the two are different promises to the reader.
      skipped: [
        { path: "tools/archprobe/probe.go", diagnostics: ["unsupported language for tools/archprobe/probe.go"] },
        { path: "store/broken.ts", diagnostics: ["line 1: Unexpected token"] },
        { path: "docs/specs/notes.md", diagnostics: ["unsupported language for docs/specs/notes.md"] },
      ],
    }));
    const fixture = await openFixture(provider);
    await mkdir(join(fixture.path, "tools", "archprobe"), { recursive: true });
    await mkdir(join(fixture.path, "store"), { recursive: true });
    await mkdir(join(fixture.path, "docs", "specs"), { recursive: true });
    await writeFile(join(fixture.path, "tools", "archprobe", "probe.go"), "package main\n", "utf8");
    await writeFile(join(fixture.path, "store", "broken.ts"), "export const = ;\n", "utf8");
    await writeFile(join(fixture.path, "docs", "specs", "notes.md"), "# Notes\n", "utf8");
    git(fixture.path, "add", "tools/archprobe/probe.go", "store/broken.ts", "docs/specs/notes.md");
    git(fixture.path, "commit", "-m", "feat: probe the store from Go");
    const sha = git(fixture.path, "rev-parse", "HEAD");

    const payload = await (await fetch(`${fixture.url}/api/git/commits/${sha}/architecture`)).json();
    expect(payload.omitted).toEqual([
      { count: 1, reason: "unsupported-language", examplePath: "tools/archprobe/probe.go" },
      { count: 1, reason: "unparsed", examplePath: "store/broken.ts" },
    ]);
    // Code the host cannot read is still sent: that notice is what tells a reader
    // the projection is incomplete there.
    const sent = provider.calls[0]!.sources.map(({ path }) => path);
    expect(sent).toContain("tools/archprobe/probe.go");
    expect(sent).toContain("store/broken.ts");
    expect(sent).not.toContain("docs/specs/notes.md");
  });

  it("lists the commit's files with the standing the reading gave each", async () => {
    const provider = recordingProvider((call) => ({
      ...(snapshotResult() as object),
      skipped: [
        ...unreadByHost(call.sources),
        { path: "store/broken.ts", diagnostics: ["line 3: Unexpected token"] },
      ],
    }));
    const fixture = await openFixture(provider);
    await writeBindings(fixture.path, [
      { path_glob: "**/store.ts", element_id: "store" },
      { path_glob: "**", element_id: "api" },
    ]);
    await mkdir(join(fixture.path, "store"), { recursive: true });
    await mkdir(join(fixture.path, "assets"), { recursive: true });
    await writeFile(join(fixture.path, "store", "store.ts"), "export const store = 1;\n", "utf8");
    await writeFile(join(fixture.path, "store", "broken.ts"), "export const = ;\n", "utf8");
    await writeFile(join(fixture.path, "worker.go"), "package main\n", "utf8");
    await writeFile(join(fixture.path, "assets", "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), "utf8");
    await writeFile(join(fixture.path, "bulk.ts"), `export const bulk = "${"x".repeat(520_000)}";\n`, "utf8");
    await rm(join(fixture.path, "caller.ts"));
    // Stage this commit's files only: the declared model is worktree state and
    // belongs to no commit under test. A staged deletion is this change too.
    git(fixture.path, "add", "store/store.ts", "store/broken.ts", "worker.go", "assets/icon.png", "bulk.ts", "caller.ts");
    git(fixture.path, "commit", "-m", "feat: mix the change");
    const sha = git(fixture.path, "rev-parse", "HEAD");

    const payload = await (await fetch(`${fixture.url}/api/git/commits/${sha}/architecture`)).json();
    const files = payload.files as Array<{ path: string; state: string; status: string; binary: boolean }>;
    const standing = new Map(files.map((file) => [file.path, file.state]));
    // Six, not the nine the request carried: the hop's neighbours are context, and
    // a reader asking what this commit changed is not asking about them.
    expect(files).toHaveLength(6);
    expect(standing.get("store/store.ts")).toBe("in-projection");
    expect(standing.get("store/broken.ts")).toBe("unparsed");
    expect(standing.get("worker.go")).toBe("unsupported-language");
    expect(standing.get("assets/icon.png")).toBe("not-source");
    expect(standing.get("bulk.ts")).toBe("too-large");
    expect(standing.get("caller.ts")).toBe("deleted");
    // The row carries the change kind, so the list reads like git does.
    expect(files.find((file) => file.path === "caller.ts")).toMatchObject({ status: "deleted" });
    expect(typeof files[0]!.binary).toBe("boolean");
  });

  it("maps a changed file onto every element its bindings name", async () => {
    const provider = recordingProvider(() => snapshotResult());
    const fixture = await openFixture(provider);
    await writeBindings(fixture.path, [
      { path_glob: "**/store.ts", element_id: "store" },
      { path_glob: "**", element_id: "api" },
    ]);
    await mkdir(join(fixture.path, "store"), { recursive: true });
    await writeFile(join(fixture.path, "store", "store.ts"), "export const store = 1;\n", "utf8");
    git(fixture.path, "add", "store/store.ts");
    git(fixture.path, "commit", "-m", "feat: move the store");
    const sha = git(fixture.path, "rev-parse", "HEAD");

    const payload = await (await fetch(`${fixture.url}/api/git/commits/${sha}/architecture`)).json();
    const files = payload.files as Array<{ path: string; elementIds: string[] }>;
    expect(files).toHaveLength(1);
    // The container and the component above it both hold the path, and the host
    // marks both, so the row names both rather than picking one.
    expect(files[0]).toMatchObject({ path: "store/store.ts", elementIds: ["store", "api"] });
  });

  it("names a commit whose only change is an asset", async () => {
    // The reading this pane used to answer with silence: a commit that changed
    // one asset, no symbols, and no sentence about what it did change.
    const provider = recordingProvider(() => snapshotResult(0));
    const fixture = await openFixture(provider);
    await mkdir(join(fixture.path, "assets"), { recursive: true });
    await writeFile(join(fixture.path, "assets", "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), "utf8");
    git(fixture.path, "add", "assets/icon.png");
    git(fixture.path, "commit", "-m", "feat: add the plugin logo");
    const sha = git(fixture.path, "rev-parse", "HEAD");

    const payload = await (await fetch(`${fixture.url}/api/git/commits/${sha}/architecture`)).json();
    expect(payload.status).toBe("no-impact");
    // Never an omission: the projection was not about an asset, so naming it unread
    // would claim a gap in something it was never reading. The list names it instead.
    expect(payload.omitted).toEqual([]);
    expect(payload.files).toMatchObject([
      { path: "assets/icon.png", status: "added", state: "not-source", elementIds: [] },
    ]);
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
        impactedHitIds: [],
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
    for (const result of [without("snapshot"), without("overlay"), without("dsl"), without("skipped"), without("impactedHitIds"), { ...valid, snapshot: [] }, { ...valid, snapshot: { model: { elements: [], relationships: [] } } }]) {
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
