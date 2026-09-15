import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseHarnessRunRequestV1 } from "@qoder-ai/harness/protocol";
import type { HarnessStudioState, HarnessStudioServerOptions } from "./studio-types.js";
import { effectiveAcpAgentProfiles } from "./acp-agent-catalog.js";
import { acpExecutorFactory, ensureAcpRun, abortAcpRun } from "./acp-runs.js";
import { streamHarnessRun } from "./run-stream.js";
import { resolveArchitectureModel, MODEL_PATH, BINDINGS_PATH } from "./architecture-model.js";
import { listTrackedFilesAtRoot } from "./architecture-impact.js";
import { isSourceLike } from "./architecture-sources.js";
import { readJsonBody, respondJson, sameOriginRequest } from "./http-utils.js";

/** The agents this surface offers; reuse the shared catalogue unless narrowed. */
export const architectureAcpProfiles = (options: HarnessStudioServerOptions) =>
  options.memoryAcpAgents ?? effectiveAcpAgentProfiles(options);

/** Bound the evidence pack so a large monorepo stays a prompt, not a dump. */
const MAX_EVIDENCE_DIRS = 120;
const MAX_MANIFESTS = 60;

const SOURCE = `language 0.3
skill architecture-model-bootstrap {
  description "Refine the provided architecture model candidate into a confirmed model and write it to the worktree. Keep arch-core's shape (elements with snake_case parent_id, relationships with source_id/target_id). Ground every element in real paths; never invent a binding to a path that does not exist. Write model.json and bindings.json into the working directory only."
}
workflow architecture-session { session architect }
harness architecture-bootstrap {
  workflow architecture-session
  agent architect { use skill architecture-model-bootstrap }
}
runtime acp { adapter "@harness/adapter-acp" }
deployment architecture-bootstrap-acp { harness architecture-bootstrap runtime acp }
`;

/** The directories that hold source, so the agent grounds names in real layout. */
function sourceDirectories(trackedPaths: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const path of trackedPaths) {
    if (!isSourceLike(path)) continue;
    const slash = path.lastIndexOf("/");
    if (slash > 0) dirs.add(path.slice(0, slash));
  }
  return [...dirs].sort((a, b) => a.localeCompare(b)).slice(0, MAX_EVIDENCE_DIRS);
}

/**
 * The prompt that turns the generated candidate into a confirmed model.
 *
 * Pure: the caller supplies the candidate model, the tracked paths, and the
 * target file paths, and this builds the instruction plus the evidence pack the
 * agent refines. The agent reads its evidence here rather than from the
 * filesystem, because its write fence is the architecture directory alone.
 */
export function architectureBootstrapPrompt(input: {
  candidate: unknown;
  bindings: ReadonlyArray<{ pathGlob: string; elementId: string }>;
  trackedPaths: readonly string[];
  modelPath: string;
  bindingsPath: string;
}): string {
  const manifests = input.trackedPaths
    .filter((path) => path.endsWith("package.json") || path.endsWith("Cargo.toml") || path.endsWith("go.mod") || path.endsWith("pyproject.toml"))
    .slice(0, MAX_MANIFESTS);
  return [
    "Refine this generated architecture model into a confirmed one for the Better Harness Impact pane.",
    "Rename, describe, re-kind (Container vs Component), merge, and split the candidate elements to match the project's real structure, and propose grounded relationships. Follow the architecture-model-bootstrap skill's grounding rules: keep arch-core's shape, keep every element bound to a real path, and never invent a binding to a path that does not exist. Keep proposed external systems and people clearly labelled in their descriptions.",
    `When done, write the refined model as JSON to \`${input.modelPath}\` and the bindings array to \`${input.bindingsPath}\` in the working directory. Do not write anywhere else.`,
    JSON.stringify({
      candidateModel: input.candidate,
      candidateBindings: input.bindings.map((binding) => ({ path_glob: binding.pathGlob, element_id: binding.elementId })),
      manifests,
      sourceDirectories: sourceDirectories(input.trackedPaths),
    }),
  ].join("\n\n");
}

/**
 * Stream an agent session that generates the architecture model into the
 * worktree, fenced to the architecture directory.
 *
 * The agent's write access is exactly `.better-harness/architecture/`: its cwd
 * and allow-root are that directory, so it can create `model.json` and
 * `bindings.json` there and nothing else. The evidence it needs to name and
 * ground the model travels in the prompt, not through repository read access.
 */
export async function streamArchitectureAcp(
  request: IncomingMessage,
  response: ServerResponse,
  state: HarnessStudioState,
  options: HarnessStudioServerOptions,
  raw: unknown,
  repoRoot: string,
): Promise<void> {
  const input = parseHarnessRunRequestV1(raw);
  const selection = JSON.parse(input.prompt) as { agentId?: string };
  const profile = architectureAcpProfiles(options).find((value) => value.id === selection.agentId && value.agent);
  if (!profile?.agent) throw new Error("Select an available ACP Agent.");
  if (state.acpRuns.has(input.runId)) throw new Error("Architecture session already exists.");

  const trackedPaths = await listTrackedFilesAtRoot(repoRoot);
  const resolved = await resolveArchitectureModel(repoRoot, trackedPaths);
  if (resolved.kind !== "model") throw new Error(`${resolved.path} cannot be read: ${resolved.reason}.`);

  // The write fence is the architecture directory: the agent's cwd and only
  // allow-root. It is created first so the fence resolves a real directory.
  const architectureDir = join(repoRoot, ".better-harness", "architecture");
  await mkdir(architectureDir, { recursive: true });

  const buildPrompt = (userRequest?: string): string => {
    const base = architectureBootstrapPrompt({
      candidate: resolved.model.modelJson,
      bindings: resolved.model.bindings,
      trackedPaths,
      // Relative to the agent's cwd (the architecture directory itself).
      modelPath: "model.json",
      bindingsPath: "bindings.json",
    });
    return userRequest ? `${base}\n\nUser request:\n${userRequest}` : base;
  };

  let prompt = buildPrompt();
  const transformed = parseHarnessRunRequestV1({ ...input, prompt });
  const control = ensureAcpRun(state, input.runId);
  control.setInitialPrompt = (value) => {
    if (typeof value !== "string" || !value.trim() || value.length > 8192) throw new Error("Enter a request of at most 8192 characters.");
    prompt = parseHarnessRunRequestV1({ ...input, prompt: buildPrompt(value) }).prompt;
  };
  try {
    await streamHarnessRun(request, response, {
      input: transformed, source: SOURCE, harnessId: "architecture-bootstrap", runtimeId: "acp", cwd: architectureDir,
      executorFactory: acpExecutorFactory(profile.agent, state, {
        prepare: true, conversation: true, initialPrompt: () => prompt, cwd: architectureDir, allowRoots: [architectureDir], agentId: profile.id,
        ...(options.acpHostExecutable === undefined ? {} : { executable: options.acpHostExecutable }),
        ...(options.acpHostTransport === undefined ? {} : { transport: options.acpHostTransport }),
      }),
      runAbortSignal: () => control.abortController.signal,
      onClientDisconnect: () => abortAcpRun(state, input.runId),
    });
  } finally {
    abortAcpRun(state, input.runId);
    state.acpRuns.delete(input.runId);
  }
}

/** The declared model paths, exported so a route can report them to the pane. */
export const ARCHITECTURE_MODEL_PATH = MODEL_PATH;
export const ARCHITECTURE_BINDINGS_PATH = BINDINGS_PATH;

/**
 * Route the architecture agent surface: list agents, and stream a session that
 * writes the model into the worktree.
 *
 * Returns `true` when it owned the request. A missing workspace or Git root is a
 * plain precondition failure, not a stream: the pane only offers the entry when
 * a repository is open.
 */
export async function architectureAcpRoute(
  request: IncomingMessage,
  response: ServerResponse,
  state: HarnessStudioState,
  options: HarnessStudioServerOptions,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname !== "/api/git/architecture/agents" && url.pathname !== "/api/git/architecture/acp/stream") return false;
  const headers = { "Cache-Control": "no-store" };
  if (!sameOriginRequest(request) || request.headers["sec-fetch-site"] === "cross-site") {
    respondJson(response, 403, { error: "Same-origin request required" }, headers);
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/git/architecture/agents") {
    const agents = architectureAcpProfiles(options).map((profile) => ({
      id: profile.id, label: profile.label, available: !!profile.agent,
      ...(profile.unavailableReason === undefined ? {} : { unavailableReason: profile.unavailableReason }),
    }));
    respondJson(response, 200, { available: agents.some((agent) => agent.available), agents }, headers);
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/git/architecture/acp/stream") {
    const repoRoot = state.workspace?.gitRoot;
    if (repoRoot === undefined) {
      respondJson(response, 404, { error: "The open workspace is not a Git repository." }, headers);
      return true;
    }
    try {
      const body = await readJsonBody(request, 4 * 1024 * 1024 + 4096);
      await streamArchitectureAcp(request, response, state, options, body, repoRoot);
    } catch (error) {
      if (!response.destroyed && !response.writableEnded && !response.headersSent) {
        respondJson(response, 400, { error: error instanceof Error ? error.message : "Architecture agent session could not start." }, headers);
      }
    }
    return true;
  }
  respondJson(response, 405, { error: "Method not allowed" }, headers);
  return true;
}
