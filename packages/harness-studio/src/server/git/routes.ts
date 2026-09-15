import { GitCommitDetail } from "../../contracts/git-history.js";
import { GitHistoryError, readGitCommitAtRoot, readGitFilePatchAtRoot, readGitLog, readGitRefsAtRoot } from "../git-history.js";
import { readStructuralDiff } from "../structural-diff.js";
import { readCommitArchitectureImpact, unavailableImpact } from "../architecture-impact.js";
import { resolveArchitectureModel, MODEL_PATH, BINDINGS_PATH } from "../architecture-model.js";
import { RustDiffHostError } from "../workspace/rust-diff-provider.js";
import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, respondJson } from "../http-utils.js";
import { listTrackedFilesAtRoot } from "../architecture-impact.js";
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
  // The workspace is a precondition, not a reading, so a non-repository root
  // keeps its ordinary Git answer.
  let workspace: GitStudioWorkspace;
  try {
    workspace = gitWorkspace(state);
  } catch (error) {
    respondGitError(response, error);
    return;
  }
  const provider = options.architectureImpactProvider;
  if (provider === undefined) {
    respondJson(response, 200, unavailableImpact(sha, "Architecture impact host is unavailable in this environment."));
    return;
  }
  try {
    const detail = await cachedGitCommit(workspace, sha);
    respondJson(response, 200, await readCommitArchitectureImpact({
      repoRoot: workspace.gitRoot,
      sha,
      detail,
      provider,
      ...(workspace.architectureImpactCache === undefined ? {} : { cache: workspace.architectureImpactCache }),
    }), { "Cache-Control": "no-store" });
  } catch (error) {
    // This pane's contract has three states and no error state, so a reading
    // that could not be made is `unavailable` carrying its reason. Answering a
    // status the pane cannot render would only crash the reader's window.
    respondJson(response, 200, unavailableImpact(sha, error instanceof Error ? error.message : "Architecture impact could not be read."));
  }
}
/**
 * Persist the model a reading projects onto as the worktree's declared model.
 *
 * This is the one place the pane writes to the user's repository, and only on
 * their action. The guard is deliberate: a model that is already declared is not
 * overwritten unless the request says so, so a save on a generated fallback can
 * never quietly clobber an authored model. The generator is deterministic, so
 * what is written equals what the reading projected onto.
 */
export async function serveGitArchitectureModelSave(
  request: IncomingMessage,
  response: ServerResponse,
  state: HarnessStudioState,
): Promise<void> {
  let workspace: GitStudioWorkspace;
  try {
    workspace = gitWorkspace(state);
  } catch (error) {
    respondGitError(response, error);
    return;
  }
  let overwrite = false;
  try {
    const body = await readJsonBody(request);
    overwrite = body !== null && typeof body === "object" && (body as { overwrite?: unknown }).overwrite === true;
  } catch {
    respondJson(response, 400, { error: "The save request body could not be read.", code: "ARCH_MODEL_BODY" });
    return;
  }

  const trackedPaths = await listTrackedFilesAtRoot(workspace.gitRoot);
  const resolved = await resolveArchitectureModel(workspace.gitRoot, trackedPaths);
  if (resolved.kind !== "model") {
    respondJson(response, 409, { error: `${resolved.path} cannot be read: ${resolved.reason}.`, code: "ARCH_MODEL_UNREADABLE" });
    return;
  }
  // A model that is already declared is authored state; replacing it needs the
  // reader to say so, so a routine save of a generated fallback cannot erase one.
  if (resolved.origin === "declared" && !overwrite) {
    respondJson(response, 409, { error: "A declared model already exists. Pass overwrite to replace it.", code: "ARCH_MODEL_DECLARED" });
    return;
  }

  try {
    const modelFile = join(workspace.gitRoot, MODEL_PATH);
    const bindingsFile = join(workspace.gitRoot, BINDINGS_PATH);
    await mkdir(dirname(modelFile), { recursive: true });
    await writeFile(modelFile, `${JSON.stringify(resolved.model.modelJson, null, 2)}\n`, "utf8");
    await writeFile(
      bindingsFile,
      `${JSON.stringify(resolved.model.bindings.map((binding) => ({ path_glob: binding.pathGlob, element_id: binding.elementId })), null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    respondJson(response, 500, { error: error instanceof Error ? error.message : "The model could not be written.", code: "ARCH_MODEL_WRITE" });
    return;
  }
  // The saved model is now the declared one; drop cached readings so the next
  // request projects onto it rather than the fallback it replaced.
  workspace.architectureImpactCache?.clear();
  respondJson(response, 200, { saved: true, origin: "declared", path: MODEL_PATH }, { "Cache-Control": "no-store" });
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
