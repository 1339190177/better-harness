import { GitCommitDetail } from "../../contracts/git-history.js";
import { GitHistoryError, readGitCommitAtRoot, readGitFilePatchAtRoot, readGitLog, readGitRefsAtRoot } from "../git-history.js";
import { readStructuralDiff } from "../structural-diff.js";
import { readCommitArchitectureImpact } from "../architecture-impact.js";
import { RustDiffHostError } from "../workspace/rust-diff-provider.js";
import { open } from "node:fs/promises";
import { ServerResponse } from "node:http";
import { respondJson } from "../http-utils.js";
import { HarnessStudioServerOptions, HarnessStudioState, StudioWorkspace } from "../studio-types.js";

type GitStudioWorkspace = StudioWorkspace & { gitRoot: string };

function gitWorkspace(state: HarnessStudioState): GitStudioWorkspace {
  const workspace = state.workspace;
  if (workspace?.gitRoot === undefined) {
    throw new GitHistoryError("The open workspace is not a Git repository.", 404, "NOT_GIT_REPOSITORY");
  }
  return workspace as GitStudioWorkspace;
}
export async function serveGitRefs(response: ServerResponse, state: HarnessStudioState): Promise<void> {
  try {
    const workspace = gitWorkspace(state);
    const refs = await readGitRefsAtRoot(workspace.gitRoot);
    workspace.gitRefs = refs;
    respondJson(response, 200, refs, { "Cache-Control": "no-store" });
  } catch (error) {
    respondGitError(response, error);
  }
}
export async function serveGitLog(response: ServerResponse, state: HarnessStudioState, url: URL): Promise<void> {
  try {
    const limitText = url.searchParams.get("limit");
    const workspace = gitWorkspace(state);
    const refs = workspace.gitRefs ?? await readGitRefsAtRoot(workspace.gitRoot);
    workspace.gitRefs = refs;
    respondJson(response, 200, await readGitLog(workspace.gitRoot, {
      refs: url.searchParams.getAll("ref"),
      search: url.searchParams.get("search") ?? undefined,
      limit: limitText === null ? undefined : Number(limitText),
      cursor: url.searchParams.get("cursor") ?? undefined,
    }, refs), { "Cache-Control": "no-store" });
  } catch (error) {
    respondGitError(response, error);
  }
}
export async function serveGitCommit(response: ServerResponse, state: HarnessStudioState, sha: string): Promise<void> {
  try {
    const workspace = gitWorkspace(state);
    respondJson(response, 200, await cachedGitCommit(workspace, sha), { "Cache-Control": "no-store" });
  } catch (error) {
    respondGitError(response, error);
  }
}
export async function serveGitFilePatch(
  response: ServerResponse,
  state: HarnessStudioState,
  sha: string,
  path: string | null,
): Promise<void> {
  try {
    if (path === null) throw new GitHistoryError("File path is required.", 400, "INVALID_PATH");
    const workspace = gitWorkspace(state);
    const detail = await cachedGitCommit(workspace, sha);
    respondJson(response, 200, await readGitFilePatchAtRoot(workspace.gitRoot, sha, path, detail), { "Cache-Control": "no-store" });
  } catch (error) {
    respondGitError(response, error);
  }
}
export async function serveGitStructuralDiff(
  response: ServerResponse,
  state: HarnessStudioState,
  options: HarnessStudioServerOptions,
  sha: string,
  path: string | null,
): Promise<void> {
  try {
    if (path === null) throw new GitHistoryError("File path is required.", 400, "INVALID_PATH");
    const provider = options.structuralDiffProvider;
    // The browser CLI has no staged host. Saying so beats returning an empty
    // diff, which a reader would have to mistake for "nothing changed".
    if (provider === undefined) {
      throw new GitHistoryError("Structural diff is unavailable in this environment.", 503, "DIFF_HOST_UNAVAILABLE");
    }
    const workspace = gitWorkspace(state);
    const detail = await cachedGitCommit(workspace, sha);
    respondJson(response, 200, await readStructuralDiff({
      repoRoot: workspace.gitRoot,
      sha,
      path,
      detail,
      provider,
      ...(workspace.structuralDiffCache === undefined ? {} : { cache: workspace.structuralDiffCache }),
    }), { "Cache-Control": "no-store" });
  } catch (error) {
    respondGitError(response, error);
  }
}
export async function serveGitArchitectureImpact(
  response: ServerResponse,
  state: HarnessStudioState,
  options: HarnessStudioServerOptions,
  sha: string,
): Promise<void> {
  const provider = options.architectureImpactProvider;
  if (provider === undefined) {
    respondJson(response, 200, {
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
      error: "Architecture impact host is unavailable in this environment.",
    });
    return;
  }
  try {
    const workspace = gitWorkspace(state);
    const detail = await cachedGitCommit(workspace, sha);
    respondJson(response, 200, await readCommitArchitectureImpact({
      repoRoot: workspace.gitRoot,
      sha,
      detail,
      provider,
    }), { "Cache-Control": "no-store" });
  } catch (error) {
    respondGitError(response, error);
  }
}
async function cachedGitCommit(workspace: GitStudioWorkspace, sha: string): Promise<GitCommitDetail> {
  const cached = workspace.gitCommitCache?.get(sha);
  if (cached !== undefined) return cached;
  const detail = await readGitCommitAtRoot(workspace.gitRoot, sha);
  if (workspace.gitCommitCache !== undefined) {
    workspace.gitCommitCache.set(sha, detail);
    if (workspace.gitCommitCache.size > 64) {
      const oldest = workspace.gitCommitCache.keys().next().value as string | undefined;
      if (oldest !== undefined) workspace.gitCommitCache.delete(oldest);
    }
  }
  return detail;
}
function respondGitError(response: ServerResponse, error: unknown): void {
  if (error instanceof RustDiffHostError) {
    respondJson(response, RUST_DIFF_STATUS[error.failure], { error: error.message, code: RUST_DIFF_CODE[error.failure] });
    return;
  }
  if (error instanceof GitHistoryError) {
    respondJson(response, error.status, { error: error.message, code: error.code });
    return;
  }
  respondJson(response, 500, { error: "Git history is unavailable.", code: "GIT_HISTORY_FAILED" });
}

/** A refused or failed structural diff keeps its own status and code. */
const RUST_DIFF_STATUS: Record<RustDiffHostError["failure"], number> = {
  unavailable: 503,
  timeout: 504,
  limit: 413,
  protocol: 502,
  call: 502,
};
const RUST_DIFF_CODE: Record<RustDiffHostError["failure"], string> = {
  unavailable: "DIFF_HOST_UNAVAILABLE",
  timeout: "STRUCTURAL_DIFF_TIMEOUT",
  limit: "STRUCTURAL_DIFF_TOO_LARGE",
  protocol: "DIFF_HOST_TRANSPORT",
  call: "STRUCTURAL_DIFF_FAILED",
};
