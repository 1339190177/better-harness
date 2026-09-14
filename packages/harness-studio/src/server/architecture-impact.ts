/**
 * Server-side architecture impact computation for one commit.
 *
 * Reads changed files from git, sends them to the arch host, and returns
 * a `CommitArchitectureImpactV1` result.
 */
import type { GitCommitDetail } from "../contracts/git-history.js";
import {
  isArchitectureImpact,
  type ArchitectureImpact,
  type ArchitectureImpactProvider,
} from "../contracts/architecture-impact.js";
import { GitHistoryError, readGitRevisionFile } from "./git-history.js";

/** Per-file read bound — matches the arch host's own limit. */
const MAX_REVISION_BYTES = 512 * 1024;
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
  const key = sha;
  const cached = cache?.get(key);
  if (cached !== undefined) return cached;

  // Collect changed file sources
  const sources: Array<{ path: string; source: string }> = [];
  for (const file of detail.files) {
    if (file.binary || sources.length >= MAX_FILE_COUNT) break;
    // Only read added and modified files
    if (file.status === "added" || file.status === "modified" || file.status === "copied" || file.status === "renamed" || file.status === "type-changed") {
      const after = (await readGitRevisionFile(repoRoot, sha, file.path, MAX_REVISION_BYTES)) ?? "";
      sources.push({ path: file.path, source: after });
    }
  }

  // Collect tracked paths for import resolution
  const trackedPaths = await listTrackedFilesAtRoot(repoRoot);

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