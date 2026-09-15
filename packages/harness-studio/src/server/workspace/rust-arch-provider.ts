import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  ArchitectureElement,
  ArchitectureImpactProvider,
  ArchitectureImpactReading,
  ArchitectureRelationship,
} from "../../contracts/architecture-impact.js";
import {
  createSupervisedRustHost,
  RustHostError,
  type RustHostFailure,
  type SupervisedRustHost,
} from "./rust-host-transport.js";

export const ARCH_HOST_PROTOCOL_VERSION = "arch-rust-1.0.0+jsonl-v1";

/** Which failure a caller is looking at, so a route can report the reason. */
export type RustArchFailure = RustHostFailure;

export { RustHostError as RustArchHostError };

export interface RustArchHostOptions {
  readonly executable: string;
  readonly transport?: "stdio" | "nsxpc";
  readonly timeoutMs?: number;
  readonly spawnProcess?: (executable: string) => ChildProcessWithoutNullStreams;
}

export interface RustArchHost extends ArchitectureImpactProvider {
  readonly processId: number | undefined;
  readonly bridgeProcessId: number | undefined;
  describe(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

const ELEMENT_KINDS = new Set(["Person", "SoftwareSystem", "Container", "Component"]);
const RELATIONSHIP_KINDS = new Set(["Contains", "Imports", "ResolvedCall", "DeclaredHttp", "DeclaredRelationship"]);

/**
 * The arch host's own reading of the snapshot.
 *
 * Fact extraction is the heaviest native call in commit browsing (every changed
 * file is parsed, then graph-resolved), so the host carries the same per-request
 * deadline and kill-on-miss supervision as the diff host: a pathological file
 * must not take the Studio server with it. NSXPC never silently falls back to
 * stdio.
 */
export function createRustArchHost(options: RustArchHostOptions): RustArchHost {
  const host: SupervisedRustHost = createSupervisedRustHost({
    ...options,
    label: "Arch host",
    protocolVersion: ARCH_HOST_PROTOCOL_VERSION,
    // Every bounded refusal this host declares is `limit/...`; the rest are
    // malformed requests.
    classifyRefusal: (code) => (typeof code === "string" && code.startsWith("limit/") ? "limit" : "call"),
  });
  return {
    get processId() { return host.processId; },
    get bridgeProcessId() { return host.bridgeProcessId; },
    describe: () => host.describe(),
    async architectureImpact(params): Promise<ArchitectureImpactReading> {
      // The wire contract is snake_case and refuses unknown fields, so the
      // translation lives here rather than leaking into the caller's types.
      const result = await host.call("arch.snapshot", {
        sources: params.sources.map((entry) => ({ path: entry.path, source: entry.source })),
        tracked_paths: [...params.trackedPaths],
        changed_paths: [...params.changedPaths],
        model_json: params.modelJson,
        bindings: params.bindings.map((binding) => ({ path_glob: binding.pathGlob, element_id: binding.elementId })),
      });
      return readSnapshot(result);
    },
    close: () => host.close(),
  };
}

/**
 * Map `arch.snapshot`'s result onto the Studio contract, refusing any other
 * shape.
 *
 * The host's required fields stay required here. A missing container is a
 * protocol fault, never an empty reading: reporting "no impact" for a reply the
 * provider could not read is the one answer a reader must never be given.
 */
function readSnapshot(result: Record<string, unknown>): ArchitectureImpactReading {
  const snapshot = record(result.snapshot) ?? fail("snapshot");
  const model = record(snapshot.model) ?? fail("snapshot.model");
  const overlay = record(result.overlay) ?? fail("overlay");
  return {
    elements: arrayOf(model.elements, "elements").map(readElement),
    relationships: arrayOf(model.relationships, "relationships").map(readRelationship),
    observedEdges: arrayOf(snapshot.observed_edges, "observedEdges").map(readRelationship),
    codeHitIds: arrayOf(snapshot.code_hit_ids, "codeHitIds").map((value) => text(value, "codeHitId")),
    changedHitIds: arrayOf(snapshot.changed_hit_ids, "changedHitIds").map((value) => text(value, "changedHitId")),
    impactedHitIds: arrayOf(result.impactedHitIds, "impactedHitIds").map((value) => text(value, "impactedHitId")),
    skipped: arrayOf(result.skipped, "skipped").map((value) => {
      const entry = record(value) ?? fail("skipped entry");
      return {
        path: text(entry.path, "skipped.path"),
        diagnostics: arrayOf(entry.diagnostics, "skipped.diagnostics").map((message) => text(message, "skipped.diagnostic")),
      };
    }),
    overlay: {
      changedSymbols: count(overlay.changedSymbols, "changedSymbols"),
      impactedSymbols: count(overlay.impactedSymbols, "impactedSymbols"),
      impactedFiles: arrayOf(overlay.impactedFiles, "impactedFiles").map((value) => text(value, "impactedFile")),
    },
    dsl: text(result.dsl, "dsl"),
  };
}

function readElement(value: unknown): ArchitectureElement {
  const element = record(value) ?? fail("element");
  const kind = text(element.kind, "element.kind");
  if (!ELEMENT_KINDS.has(kind)) fail(`element.kind ${kind}`);
  return {
    id: text(element.id, "element.id"),
    name: text(element.name, "element.name"),
    kind: kind as ArchitectureElement["kind"],
    tags: arrayOf(element.tags, "element.tags").map((tag) => text(tag, "element.tag")),
    ...(typeof element.description === "string" ? { description: element.description } : {}),
    ...(typeof element.technology === "string" ? { technology: element.technology } : {}),
    // The wire speaks snake_case; the contract, like every other Studio
    // contract, speaks camelCase.
    ...(typeof element.parent_id === "string" ? { parentId: element.parent_id } : {}),
  };
}

function readRelationship(value: unknown): ArchitectureRelationship {
  const relationship = record(value) ?? fail("relationship");
  const kind = text(relationship.kind, "relationship.kind");
  if (!RELATIONSHIP_KINDS.has(kind)) fail(`relationship.kind ${kind}`);
  return {
    id: text(relationship.id, "relationship.id"),
    sourceId: text(relationship.source_id, "relationship.sourceId"),
    targetId: text(relationship.target_id, "relationship.targetId"),
    kind: kind as ArchitectureRelationship["kind"],
    ...(typeof relationship.description === "string" ? { description: relationship.description } : {}),
    ...(typeof relationship.technology === "string" ? { technology: relationship.technology } : {}),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** A host that answers in another shape is a protocol fault, never an empty reading. */
function fail(what: string): never {
  throw new RustHostError(`Arch host returned no ${what}.`, "protocol");
}

/** Every array the wire contract declares is required; its absence is a fault. */
function arrayOf(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) fail(field);
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") fail(field);
  return value;
}

function count(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) fail(field);
  return value as number;
}
