import type { GitCommitDetail } from "../contracts/git-history.js";
import {
  isStructuralDiffResult,
  type StructuralDiff,
  type StructuralDiffProvider,
} from "../contracts/structural-diff.js";
import { GitHistoryError, readGitRevisionFile } from "./git-history.js";

/**
 * Per-revision read bound. It matches the native host's own bound, so a file
 * that would be refused there is refused before git materializes it here.
 */
const MAX_REVISION_BYTES = 2 * 1024 * 1024;

/** How many structural results one workspace remembers. */
const MAX_CACHED_RESULTS = 64;

export interface StructuralDiffRequest {
  repoRoot: string;
  sha: string;
  path: string;
  detail: GitCommitDetail;
  provider: StructuralDiffProvider;
  cache?: Map<string, StructuralDiff>;
}

/**
 * Assemble one structural diff from the two revisions git holds.
 *
 * The engine is asked about text, never about paths it opens itself: the older
 * and newer sides are read here so the same allow-list, rename handling and
 * size bound that govern the textual patch govern this too.
 */
export async function readStructuralDiff(request: StructuralDiffRequest): Promise<StructuralDiff> {
  const { repoRoot, sha, path, detail, provider, cache } = request;
  const key = `${sha}\u0000${path}`;
  const cached = cache?.get(key);
  if (cached !== undefined) return cached;

  const file = detail.files.find((candidate) => candidate.path === path);
  if (file === undefined) {
    throw new GitHistoryError("File is not part of this commit.", 404, "FILE_NOT_FOUND");
  }
  if (file.binary) {
    throw new GitHistoryError("Binary files have no structural diff.", 415, "BINARY_FILE");
  }

  const parent = detail.commit.parents[0];
  // An added file has no older side and a deleted file has no newer side; the
  // engine reads an empty revision as such rather than as an empty file.
  const before = file.status === "added" || parent === undefined
    ? ""
    : await readGitRevisionFile(repoRoot, parent, file.previousPath ?? path, MAX_REVISION_BYTES) ?? "";
  const after = file.status === "deleted"
    ? ""
    : await readGitRevisionFile(repoRoot, sha, path, MAX_REVISION_BYTES) ?? "";

  const result = await provider.structuralDiff({ path, before, after });
  if (!isStructuralDiffResult(result)) {
    throw new GitHistoryError("The structural diff result is malformed.", 502, "STRUCTURAL_DIFF_FAILED");
  }

  const payload: StructuralDiff = { kind: "StructuralDiffV1", sha, path, ...result };
  if (cache !== undefined) remember(cache, key, payload);
  return payload;
}

/** Bounded, insertion-ordered: the oldest entry leaves first. */
function remember(cache: Map<string, StructuralDiff>, key: string, value: StructuralDiff): void {
  cache.set(key, value);
  while (cache.size > MAX_CACHED_RESULTS) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    cache.delete(oldest);
  }
}
