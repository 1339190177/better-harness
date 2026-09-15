/**
 * Server-side architecture impact computation for one commit.
 *
 * Reads changed files from git, sends them to the arch host, and returns
 * a `CommitArchitectureImpactV1` result.
 */
import { createHash } from "node:crypto";
import type { GitCommitDetail } from "../contracts/git-history.js";
import type { ArchitectureImpact, ArchitectureImpactProvider } from "../contracts/architecture-impact.js";
import { GitHistoryError, readGitRevisionFile } from "./git-history.js";

/**
 * Per-file read bound, in bytes, and the arch host's own `MAX_FILE_BYTES`.
 * Reading more than the host accepts would only move the refusal from here —
 * where it can name the file — to a host that refuses the whole request.
 */
const MAX_REVISION_BYTES = 512_000;
/** How many files the arch host accepts per request. */
const MAX_FILE_COUNT = 800;
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

  // Collect tracked paths for import resolution. This is also part of the cache
  // key: the paths a worktree tracks change which imports resolve, so a reading
  // is only valid for the worktree it was made in.
  const trackedPaths = await listTrackedFilesAtRoot(repoRoot);
  const key = `${sha}:${pathDigest(trackedPaths)}`;
  const cached = cache?.get(key);
  if (cached !== undefined) return cached;

  // Collect changed file sources
  const sources: Array<{ path: string; source: string }> = [];
  for (const file of detail.files) {
    if (file.binary || sources.length >= MAX_FILE_COUNT) break;
    // Only read added and modified files
    if (file.status === "added" || file.status === "modified" || file.status === "copied" || file.status === "renamed" || file.status === "type-changed") {
      const after = await readChangedSource(repoRoot, sha, file.path);
      sources.push({ path: file.path, source: after });
    }
  }

  const changedPaths = detail.files
    .filter((f) => f.status !== "deleted")
    .map((f) => f.path);

  const raw = await provider.architectureImpact({
    sources,
    trackedPaths,
    changedPaths,
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

/**
 * One changed file's content at the revision, or an empty source for a file git
 * cannot show.
 *
 * `readGitRevisionFile` refuses an over-limit file rather than reading it as
 * empty, and that refusal is kept: its generic wording names a structural diff,
 * so it is restated here with the file that caused it.
 */
async function readChangedSource(repoRoot: string, sha: string, path: string): Promise<string> {
  try {
    return (await readGitRevisionFile(repoRoot, sha, path, MAX_REVISION_BYTES)) ?? "";
  } catch (error) {
    if (error instanceof GitHistoryError && error.code === "STRUCTURAL_DIFF_TOO_LARGE") {
      throw new GitHistoryError(`${path} is too large for an architecture reading.`, 413, "ARCHITECTURE_SOURCE_TOO_LARGE");
    }
    throw error;
  }
}

/** A short digest of the tracked path set, for the cache key. */
function pathDigest(trackedPaths: readonly string[]): string {
  return createHash("sha1").update(trackedPaths.join("\n")).digest("hex").slice(0, 16);
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