/**
 * Deterministic architecture model generation for a worktree with no declared
 * model.
 *
 * The Impact pane projects a commit onto a *declared* model. A project that
 * authored none used to see nothing; this generator derives a bounded, grounded
 * candidate from what the worktree already tracks — workspace manifests, package
 * boundaries, source directories — so the pane has a model to project onto. The
 * result is marked `generated`, never presented as an authored fact: it is a
 * starting point a reader refines and, only on their action, saves.
 *
 * It is a pure function of its inputs. The caller supplies the repo name, the
 * tracked path list, and the parsed workspace manifests; this module reads no
 * filesystem of its own, so the same tracked paths always produce the same
 * model. The shape it emits is arch-core's own (`elements` with snake_case
 * `parent_id`, `relationships` with `source_id`/`target_id`), which is exactly
 * what `readModelShape` validates and the native host consumes.
 */
import { posix } from "node:path";
import type { ArchitectureSourceBinding } from "../contracts/architecture-impact.js";
import { isSourceLike } from "./architecture-sources.js";

/** Parsed contents of one workspace manifest and where it lives. */
export interface WorkspaceManifest {
  /** POSIX path of the manifest, relative to the repo root (e.g. `packages/a/package.json`). */
  path: string;
  /** The manifest's declared name, when it has one. */
  name?: string;
}

export interface GenerateModelInput {
  /** A human name for the root system, usually the repo directory or root manifest name. */
  repoName: string;
  /** The worktree's tracked path list, POSIX-separated as git reports it. */
  trackedPaths: readonly string[];
  /** Parsed workspace manifests found in the worktree, root first when present. */
  manifests?: readonly WorkspaceManifest[];
}

export interface GeneratedModel {
  /** arch-core's model shape: `elements` + `relationships`, snake_case fields. */
  modelJson: unknown;
  bindings: ArchitectureSourceBinding[];
  /** How much of the model is grounded in real source rather than layout alone. */
  confidence: "high" | "medium" | "low";
}

/** A generated model is a bounded candidate, not a catalogue of every folder. */
const MAX_ELEMENTS = 200;
/** A directory needs at least this many source files to become its own component. */
const MIN_SOURCE_FILES_PER_COMPONENT = 1;
/** Directories that never describe an architecture boundary. */
const IGNORED_SEGMENTS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", "target",
  "vendor", ".next", ".turbo", ".cache", "tmp", ".tmp", "__pycache__",
]);

/**
 * Derive a bounded, grounded candidate model from the worktree's own structure.
 *
 * Boundaries come from evidence, not from every directory: a `Container` per
 * workspace/package boundary, and a `Component` per source directory that
 * actually holds extractable or source-like files. A folder with no source, and
 * any path the projection is not about, contributes no element — the same
 * "a directory is not a component" discipline the declared model keeps, applied
 * to a candidate a reader still has to confirm.
 */
export function generateArchitectureModel(input: GenerateModelInput): GeneratedModel {
  const rootId = "system";
  const elements: ModelElement[] = [{
    id: rootId,
    name: input.repoName || "This System",
    kind: "SoftwareSystem",
    description: "Generated root system. Confirm or rename before relying on it.",
    technology: null,
    tags: ["system", "generated"],
    parent_id: null,
  }];
  const bindings: ArchitectureSourceBinding[] = [];

  // Container boundaries: each workspace/package manifest is a container. When a
  // repository declares none, the whole repository is a single container so the
  // components below still have a parent.
  const containers = deriveContainers(input.manifests ?? [], input.repoName);
  const usedIds = new Set([rootId]);
  const sourceByDir = groupSourceByDirectory(input.trackedPaths);

  let grounded = 0;
  let proposed = 0;
  for (const container of containers) {
    if (elements.length >= MAX_ELEMENTS) break;
    const containerId = uniqueId(container.idBase, usedIds);
    elements.push({
      id: containerId,
      name: container.name,
      kind: "Container",
      description: "Generated from a workspace boundary. Confirm its kind and name.",
      technology: null,
      tags: ["runtime", "generated"],
      parent_id: rootId,
    });
    bindings.push({ pathGlob: container.prefix === "" ? "**" : `${container.prefix}/**`, elementId: containerId });
    proposed += 1;

    // Component grounding: a direct source directory inside the container that
    // actually holds source becomes a component. Nothing else does.
    for (const dir of componentDirsFor(container.prefix, sourceByDir)) {
      if (elements.length >= MAX_ELEMENTS) break;
      const componentId = uniqueId(`${containerId}-${lastSegment(dir.dir)}`, usedIds);
      elements.push({
        id: componentId,
        name: lastSegment(dir.dir),
        kind: "Component",
        description: "Generated from a source directory. Confirm or merge.",
        technology: null,
        tags: ["generated"],
        parent_id: containerId,
      });
      bindings.push({ pathGlob: `${dir.dir}/**`, elementId: componentId });
      grounded += 1;
    }
  }

  return {
    modelJson: { elements, relationships: [] },
    bindings,
    confidence: confidenceFor(grounded, proposed),
  };
}

interface ModelElement {
  id: string;
  name: string;
  kind: "Person" | "SoftwareSystem" | "Container" | "Component";
  description: string;
  technology: string | null;
  tags: string[];
  parent_id: string | null;
}

interface ContainerCandidate {
  idBase: string;
  name: string;
  /** POSIX directory prefix, no trailing slash (e.g. `packages/harness-studio`). */
  prefix: string;
}

/**
 * One container per workspace manifest, or the whole repository as one when a
 * repository declares no workspaces.
 */
function deriveContainers(manifests: readonly WorkspaceManifest[], repoName: string): ContainerCandidate[] {
  // A root manifest (`package.json` at the top) is the system, not a container;
  // only nested manifests mark independently owned units.
  const nested = manifests
    .map((manifest) => ({ manifest, prefix: posix.dirname(normalize(manifest.path)) }))
    .filter(({ prefix }) => prefix !== "." && prefix !== "");
  if (nested.length === 0) {
    return [{ idBase: slug(repoName) || "app", name: repoName || "Application", prefix: "" }];
  }
  const seen = new Set<string>();
  const containers: ContainerCandidate[] = [];
  for (const { manifest, prefix } of nested.sort((a, b) => a.prefix.localeCompare(b.prefix))) {
    if (seen.has(prefix)) continue;
    seen.add(prefix);
    const name = manifest.name ?? lastSegment(prefix);
    containers.push({ idBase: slug(name) || slug(prefix), name, prefix });
  }
  return containers;
}

/** Source directories directly under a container prefix, with a source count. */
function componentDirsFor(prefix: string, sourceByDir: Map<string, number>): Array<{ dir: string; count: number }> {
  const scope = prefix === "" ? "" : `${prefix}/`;
  const result: Array<{ dir: string; count: number }> = [];
  for (const [dir, count] of sourceByDir) {
    if (count < MIN_SOURCE_FILES_PER_COMPONENT) continue;
    if (prefix !== "" && !dir.startsWith(scope)) continue;
    if (dir === prefix) continue;
    result.push({ dir, count });
  }
  // Stable ordering keeps the model reproducible for a given tracked set.
  return result.sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * Count source-like files per directory that a component could be grounded in.
 *
 * A directory is keyed at a bounded depth below its container so a deep tree
 * does not explode into one component per leaf: the first two segments below the
 * container prefix. Non-source files and ignored segments never contribute.
 */
function groupSourceByDirectory(trackedPaths: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of trackedPaths) {
    const path = normalize(raw);
    if (path === "") continue;
    if (!isSourceLike(path)) continue;
    const segments = path.split("/");
    if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) continue;
    const dir = posix.dirname(path);
    if (dir === "." || dir === "") continue;
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return counts;
}

function confidenceFor(grounded: number, proposedContainers: number): "high" | "medium" | "low" {
  if (grounded >= 3 && proposedContainers >= 1) return "medium";
  if (grounded >= 1) return "low";
  return "low";
}

function normalize(path: string): string {
  return path.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/+$/u, "").trim();
}

function lastSegment(path: string): string {
  const segments = normalize(path).split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

/** A stable, id-safe slug: lower-case, non-alphanumerics collapsed to hyphens. */
function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/^@/u, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

/** An id that is unique within the model, suffixing collisions deterministically. */
function uniqueId(base: string, used: Set<string>): string {
  const root = base || "element";
  if (!used.has(root)) { used.add(root); return root; }
  let n = 2;
  while (used.has(`${root}-${n}`)) n += 1;
  const id = `${root}-${n}`;
  used.add(id);
  return id;
}
