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
import { join } from "node:path";
import type { ArchitectureSourceBinding } from "../contracts/architecture-impact.js";

const MODEL_PATH = ".better-harness/architecture/model.json";
const BINDINGS_PATH = ".better-harness/architecture/bindings.json";
/** A declared model is configuration, not a dataset. */
const MAX_MODEL_BYTES = 1024 * 1024;
const DSL_PATTERN = /\.dsl$/u;
const WORKSPACE_PATTERN = /(^|\/)(workspace|.*\.structurizr)\.json$/u;

export interface DeclaredModel {
  /** arch-core's `ArchitectureModel`: elements plus declared relationships. */
  modelJson: unknown;
  bindings: ArchitectureSourceBinding[];
}

export type ModelDiscovery =
  | { kind: "model"; model: DeclaredModel }
  | { kind: "unreadable"; path: string; reason: string }
  | { kind: "absent"; looked: string[] };

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
