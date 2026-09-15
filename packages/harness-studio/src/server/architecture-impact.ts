/**
 * Server-side architecture impact computation for one commit.
 *
 * Reads changed files from git, sends them to the arch host, and returns
 * a `CommitArchitectureImpactV1` result.
 */
import { createHash } from "node:crypto";
import type { GitCommitDetail } from "../contracts/git-history.js";
import type { ArchitectureImpact, ArchitectureImpactProvider } from "../contracts/architecture-impact.js";
import { discoverDeclaredModel } from "./architecture-model.js";
import { selectImportHop } from "./architecture-hop.js";
import { GitHistoryError, readGitRevisionFile } from "./git-history.js";

/**
 * Per-file read bound, in bytes, and the arch host's own `MAX_FILE_BYTES`.
 * Reading more than the host accepts would only move the refusal from here —
 * where it can name the file — to a host that refuses the whole request.
 */
const MAX_REVISION_BYTES = 512_000;
/** How many files the arch host accepts per request. */
const MAX_FILE_COUNT = 800;
/**
 * Total source bytes this reading sends, under the host's 4 MiB request frame.
 * A commit past it reports the files it left out rather than failing whole.
 */
const MAX_SOURCES_BYTES = 3 * 1024 * 1024;
/** Changed-file states whose content exists at the revision and can be parsed. */
const READABLE_STATUSES = new Set(["added", "modified", "copied", "renamed", "type-changed"]);
/** Cached results per workspace. */
const MAX_CACHED_RESULTS = 32;

export interface ArchitectureImpactRequest {
  repoRoot: string;
  sha: string;
  detail: GitCommitDetail;
  provider: ArchitectureImpactProvider;
  cache?: Map<string, ArchitectureImpact>;
}

/**
 * Assemble one architecture impact from a commit's changed files.
 */
export async function readCommitArchitectureImpact(
  request: ArchitectureImpactRequest,
): Promise<ArchitectureImpact> {
  const { repoRoot, sha, detail, provider, cache } = request;

  // Collect tracked paths for import resolution, and find the declared model.
  // Both are worktree state, so both are part of the cache key: the paths a
  // worktree tracks decide which imports resolve, and the model decides what the
  // projection marks at all.
  const trackedPaths = await listTrackedFilesAtRoot(repoRoot);
  const discovery = await discoverDeclaredModel(repoRoot, trackedPaths);
  if (discovery.kind !== "model") {
    return unavailableImpact(sha, discovery.kind === "absent"
      ? `No declared architecture model was found. Add ${discovery.looked[0]} to project this commit onto one.`
      : `${discovery.path} cannot be read: ${discovery.reason}.`);
  }
  const { modelJson, bindings } = discovery.model;
  const key = `${sha}:${pathDigest(trackedPaths)}:${digest(JSON.stringify(modelJson))}:${digest(JSON.stringify(bindings))}`;
  const cached = cache?.get(key);
  if (cached !== undefined) return cached;

  // Collect changed file sources. A file this reading cannot include is left out
  // and reported, never read as empty and never allowed to void the whole commit:
  // one large lockfile must not cost a reader the reading of every other file.
  const sources: Array<{ path: string; source: string }> = [];
  const tooLarge: string[] = [];
  const overBudget: string[] = [];
  let budget = MAX_SOURCES_BYTES;
  for (const file of detail.files) {
    if (!READABLE_STATUSES.has(file.status)) continue;
    if (sources.length >= MAX_FILE_COUNT) { overBudget.push(file.path); continue; }
    const read = await readChangedSource(repoRoot, sha, file.path);
    if ("omitted" in read) { tooLarge.push(file.path); continue; }
    const bytes = Buffer.byteLength(read.source, "utf8");
    if (bytes > budget) { overBudget.push(file.path); continue; }
    budget -= bytes;
    sources.push({ path: file.path, source: read.source });
  }

  const changedPaths = detail.files
    .filter((f) => f.status !== "deleted")
    .map((f) => f.path);

  // One import hop: the parseable files around the change are sent as context,
  // because a caller the commit did not touch is otherwise invisible and
  // "impacted" reads 0 for every commit. They are never changed paths, and the
  // hop reports its own bound instead of quietly narrowing the radius. A path
  // already considered is not reconsidered here: a file too large to read stays
  // too large, and counting it twice would inflate what the notice reports.
  const considered = new Set([...sources.map(({ path }) => path), ...tooLarge, ...overBudget]);
  const hop = selectImportHop(trackedPaths, changedPaths, considered);
  for (const path of hop.candidates) {
    if (sources.length >= MAX_FILE_COUNT) { overBudget.push(path); continue; }
    const read = await readChangedSource(repoRoot, sha, path);
    if ("omitted" in read) { tooLarge.push(path); continue; }
    const bytes = Buffer.byteLength(read.source, "utf8");
    if (bytes > budget) { overBudget.push(path); continue; }
    budget -= bytes;
    sources.push({ path, source: read.source });
  }

  const raw = await provider.architectureImpact({
    sources,
    trackedPaths,
    changedPaths,
    modelJson,
    bindings,
  });

  const result: ArchitectureImpact = {
    kind: "CommitArchitectureImpactV1",
    sha,
    status: raw.overlay.changedSymbols > 0 ? "impact" : "no-impact",
    elements: raw.elements,
    relationships: raw.relationships,
    observedEdges: raw.observedEdges,
    codeHitIds: raw.codeHitIds,
    changedHitIds: raw.changedHitIds,
    overlay: raw.overlay,
    dsl: raw.dsl,
    omitted: [
      ...(tooLarge.length === 0 ? [] : [{ count: tooLarge.length, reason: "too-large" as const, examplePath: tooLarge[0]! }]),
      ...(overBudget.length === 0 ? [] : [{ count: overBudget.length, reason: "request-budget" as const, examplePath: overBudget[0]! }]),
      ...(hop.truncated === 0 ? [] : [{ count: hop.truncated, reason: "import-hop" as const, examplePath: hop.firstDropped }]),
      ...(raw.skipped.length === 0 ? [] : [{ count: raw.skipped.length, reason: "unsupported-language" as const, examplePath: raw.skipped[0]!.path }]),
    ],
  };

  if (cache !== undefined) {
    cache.set(key, result);
    while (cache.size > MAX_CACHED_RESULTS) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  return result;
}

/** A reading this environment cannot make, carrying the reason it could not. */
export function unavailableImpact(sha: string, message: string): ArchitectureImpact {
  return {
    kind: "CommitArchitectureImpactV1",
    sha,
    status: "unavailable",
    elements: [],
    relationships: [],
    observedEdges: [],
    codeHitIds: [],
    changedHitIds: [],
    overlay: { changedSymbols: 0, impactedSymbols: 0, impactedFiles: [] },
    dsl: "",
    omitted: [],
    error: message,
  };
}

/**
 * One changed file's content at the revision, or the reason it was left out.
 *
 * `readGitRevisionFile` refuses an over-limit file rather than reading it as
 * empty, and that refusal is kept and surfaced: an omitted file is a fact about
 * the reading, and the reader is told which file it was.
 */
async function readChangedSource(repoRoot: string, sha: string, path: string): Promise<{ source: string } | { omitted: true }> {
  try {
    return { source: (await readGitRevisionFile(repoRoot, sha, path, MAX_REVISION_BYTES)) ?? "" };
  } catch (error) {
    if (error instanceof GitHistoryError && error.code === "STRUCTURAL_DIFF_TOO_LARGE") return { omitted: true };
    throw error;
  }
}

/** A short digest of a value's serialized form, for the cache key. */
function digest(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
}

/** A short digest of the tracked path set, for the cache key. */
function pathDigest(trackedPaths: readonly string[]): string {
  return digest(trackedPaths.join("\n"));
}

async function listTrackedFilesAtRoot(repoRoot: string): Promise<string[]> {
  try {
    // Reuse the git-history module's track listing if available
    // For now, use git ls-files
    const { execFile } = await import("node:child_process");
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        ["-C", repoRoot, "ls-files", "--cached", "--others", "--exclude-standard"],
        { maxBuffer: 4 * 1024 * 1024, timeout: 30_000 },
        (error, stdout) => {
          if (error) resolve([]);
          else resolve(stdout.trim().split("\n").filter(Boolean));
        },
      );
    });
  } catch {
    return [];
  }
}