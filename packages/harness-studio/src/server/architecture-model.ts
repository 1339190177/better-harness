/**
 * Declared architecture model discovery for one worktree.
 *
 * The commit pane projects a change onto a *declared* model, so it has to find
 * one. Discovery stays bounded and explicit: it reads the conventions below and
 * reports what it could not read, because an unreadable or absent model must
 * never be presented as a projection with nothing in it.
 *
 * ```text
 * model:    .better-harness/architecture/model.json
 * bindings: .better-harness/architecture/bindings.json
 * ```
 *
 * The model is the arch-core shape (`elements` + `relationships`), which is what
 * the native host consumes. A Structurizr `.dsl` or workspace JSON is reported as
 * an unreadable declared model rather than guessed at: v1 has no DSL reader, and
 * a partial guess would mark the wrong boundaries.
 */
import { readFile } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import type { ArchitectureSourceBinding } from "../contracts/architecture-impact.js";
import { generateArchitectureModel, type WorkspaceManifest } from "./architecture-model-generator.js";

const MODEL_PATH = ".better-harness/architecture/model.json";
const BINDINGS_PATH = ".better-harness/architecture/bindings.json";
/** A declared model is configuration, not a dataset. */
const MAX_MODEL_BYTES = 1024 * 1024;
const DSL_PATTERN = /\.dsl$/u;
const WORKSPACE_PATTERN = /(^|\/)(workspace|.*\.structurizr)\.json$/u;
/** How many manifests generation reads: a boundary source, not a dataset. */
const MAX_MANIFESTS = 200;

export interface DeclaredModel {
  /** arch-core's `ArchitectureModel`: elements plus declared relationships. */
  modelJson: unknown;
  bindings: ArchitectureSourceBinding[];
}

export type ModelDiscovery =
  | { kind: "model"; model: DeclaredModel }
  | { kind: "unreadable"; path: string; reason: string }
  | { kind: "absent"; looked: string[] };

/** How a resolved model came to be, carried onto the reading a reader sees. */
export type ModelOrigin = "declared" | "generated";

/**
 * The model a reading projects onto, and where it came from.
 *
 * A `declared` model is authored on disk; a `generated` one is derived from the
 * worktree when none is declared, and carries a confidence so the pane can mark
 * it as a candidate rather than an authored fact. An unreadable declared model
 * stays `unreadable`: a broken authored model is never replaced by a guess.
 */
export type ResolvedModel =
  | { kind: "model"; origin: ModelOrigin; model: DeclaredModel; confidence?: "high" | "medium" | "low" }
  | { kind: "unreadable"; path: string; reason: string };

/**
 * Find the declared model this worktree publishes.
 *
 * `trackedPaths` is the worktree's tracked path list, used instead of a
 * filesystem walk so discovery is bounded by what git already knows.
 */
export async function discoverDeclaredModel(repoRoot: string, trackedPaths: readonly string[]): Promise<ModelDiscovery> {
  const declared = await readModelFile(repoRoot, MODEL_PATH);
  if (declared.kind === "unreadable") return declared;
  if (declared.kind === "model") {
    return { kind: "model", model: { modelJson: declared.modelJson, bindings: await readBindings(repoRoot) } };
  }

  // A model in another dialect is a declared model this pane cannot read, which
  // is a different answer from "this project declares none".
  const other = trackedPaths.find((path) => DSL_PATTERN.test(path) || WORKSPACE_PATTERN.test(path));
  if (other !== undefined) {
    return {
      kind: "unreadable",
      path: other,
      reason: DSL_PATTERN.test(other)
        ? "a Structurizr DSL model is not readable yet; publish .better-harness/architecture/model.json instead"
        : "a Structurizr workspace JSON is not readable yet; publish .better-harness/architecture/model.json instead",
    };
  }
  return { kind: "absent", looked: [MODEL_PATH, BINDINGS_PATH] };
}

async function readModelFile(repoRoot: string, path: string): Promise<{ kind: "missing" } | { kind: "model"; modelJson: unknown } | { kind: "unreadable"; path: string; reason: string }> {
  let text: string;
  try {
    text = await readFile(join(repoRoot, path), { encoding: "utf8", flag: "r" }).then((value) => {
      if (Buffer.byteLength(value, "utf8") > MAX_MODEL_BYTES) throw new Error("the model file is over 1 MiB");
      return value;
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable", path, reason: error instanceof Error ? error.message : "the model file could not be read" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { kind: "unreadable", path, reason: `the model file is not JSON: ${error instanceof Error ? error.message : "invalid JSON"}` };
  }
  const shape = readModelShape(parsed);
  if (shape !== undefined) return { kind: "unreadable", path, reason: shape };
  return { kind: "model", modelJson: parsed };
}

/** `undefined` when the document is an arch-core model, else why it is not. */
function readModelShape(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "the model must be a JSON object";
  const candidate = parsed as { elements?: unknown; relationships?: unknown };
  if (!Array.isArray(candidate.elements)) return "the model needs an `elements` array";
  if (!Array.isArray(candidate.relationships)) return "the model needs a `relationships` array";
  for (const element of candidate.elements) {
    if (typeof element !== "object" || element === null) return "every element must be an object";
    const { id, name, kind } = element as { id?: unknown; name?: unknown; kind?: unknown };
    if (typeof id !== "string" || id === "") return "every element needs a non-empty `id`";
    if (typeof name !== "string" || name === "") return `element ${id} needs a non-empty \`name\``;
    if (!["Person", "SoftwareSystem", "Container", "Component"].includes(String(kind))) {
      return `element ${id} needs a \`kind\` of Person, SoftwareSystem, Container or Component`;
    }
  }
  return undefined;
}

/** Bindings are optional: a model without them still projects, it just marks nothing. */
async function readBindings(repoRoot: string): Promise<ArchitectureSourceBinding[]> {
  let text: string;
  try {
    text = await readFile(join(repoRoot, BINDINGS_PATH), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const { path_glob: snakePath, element_id: snakeElement, pathGlob, elementId } = entry as Record<string, unknown>;
      const glob = typeof snakePath === "string" ? snakePath : typeof pathGlob === "string" ? pathGlob : undefined;
      const element = typeof snakeElement === "string" ? snakeElement : typeof elementId === "string" ? elementId : undefined;
      return glob === undefined || element === undefined ? [] : [{ pathGlob: glob, elementId: element }];
    });
  } catch {
    return [];
  }
}

/**
 * Resolve the model a reading projects onto: the declared one when readable,
 * otherwise a model generated from the worktree.
 *
 * Declared wins whenever it is present and valid. An unreadable declared model
 * is surfaced as-is, never replaced by a generated one — a broken authored model
 * is a defect to fix, not a reason to guess. Only a genuinely absent model falls
 * back to generation, and the fallback is marked `generated` with a confidence
 * so the pane presents it as a candidate.
 */
export async function resolveArchitectureModel(repoRoot: string, trackedPaths: readonly string[]): Promise<ResolvedModel> {
  const declared = await discoverDeclaredModel(repoRoot, trackedPaths);
  if (declared.kind === "model") return { kind: "model", origin: "declared", model: declared.model };
  if (declared.kind === "unreadable") return declared;

  const manifests = await readWorkspaceManifests(repoRoot, trackedPaths);
  const generated = generateArchitectureModel({
    repoName: rootSystemName(repoRoot, manifests),
    trackedPaths,
    manifests,
  });
  return {
    kind: "model",
    origin: "generated",
    model: { modelJson: generated.modelJson, bindings: generated.bindings },
    confidence: generated.confidence,
  };
}

/**
 * Read the parsed `package.json` manifests the worktree tracks, bounded so a
 * monorepo's manifest set stays a boundary source and not an unbounded read.
 */
async function readWorkspaceManifests(repoRoot: string, trackedPaths: readonly string[]): Promise<WorkspaceManifest[]> {
  const manifestPaths = trackedPaths
    .filter((path) => basename(path) === "package.json")
    .slice(0, MAX_MANIFESTS);
  const manifests: WorkspaceManifest[] = [];
  for (const path of manifestPaths) {
    let name: string | undefined;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(repoRoot, path), "utf8"));
      if (parsed !== null && typeof parsed === "object" && typeof (parsed as { name?: unknown }).name === "string") {
        name = (parsed as { name: string }).name;
      }
    } catch {
      // A manifest that will not read or parse contributes no name; its path is
      // still a boundary the generator can use.
    }
    manifests.push(name === undefined ? { path } : { path, name });
  }
  return manifests;
}

/** The name for the generated root system: the root manifest name, else the repo directory. */
function rootSystemName(repoRoot: string, manifests: readonly WorkspaceManifest[]): string {
  const root = manifests.find((manifest) => posix.dirname(manifest.path.replace(/\\/gu, "/")) === ".");
  return root?.name ?? basename(repoRoot) ?? "This System";
}
