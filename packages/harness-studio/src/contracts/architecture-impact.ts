/**
 * The architecture impact reading of one commit.
 *
 * Shape matches arch-core's serialized output: declared model + observed
 * code facts + change overlay, carried as text so the client never needs
 * the Rust-side types.
 */

export type ArchitectureImpactStatus = "impact" | "no-impact" | "unavailable";

export interface ArchitectureElement {
  id: string;
  name: string;
  kind: "Person" | "SoftwareSystem" | "Container" | "Component";
  description?: string;
  technology?: string;
  tags: string[];
  parentId?: string;
}

export interface ArchitectureRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  description?: string;
  technology?: string;
  kind: "Contains" | "Imports" | "ResolvedCall" | "DeclaredHttp" | "DeclaredRelationship";
}

export interface ArchitectureOverlay {
  changedSymbols: number;
  impactedSymbols: number;
  impactedFiles: string[];
}

export interface ArchitectureImpact {
  kind: "CommitArchitectureImpactV1";
  sha: string;
  status: ArchitectureImpactStatus;
  /** Declared model elements. */
  elements: ArchitectureElement[];
  /** Declared model relationships. */
  relationships: ArchitectureRelationship[];
  /** Code-fact edges observed across the snapshot. */
  observedEdges: ArchitectureRelationship[];
  /** Element ids touched by code facts. */
  codeHitIds: string[];
  /** Element ids touched by changed code. */
  changedHitIds: string[];
  /** Change summary. */
  overlay: ArchitectureOverlay;
  /** Structurizr DSL for the projection. */
  dsl: string;
  /** Error message when unavailable. */
  error?: string;
}

export interface ArchitectureImpactProvider {
  architectureImpact(params: {
    sources: Array<{ path: string; source: string }>;
    trackedPaths: string[];
    changedPaths: string[];
  }): Promise<ArchitectureImpact>;
}

export function isArchitectureImpact(value: unknown): value is ArchitectureImpact {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.kind === "CommitArchitectureImpactV1"
    && typeof candidate.sha === "string"
    && ["impact", "no-impact", "unavailable"].includes(candidate.status as string)
    && Array.isArray(candidate.elements)
    && Array.isArray(candidate.relationships)
    && typeof candidate.dsl === "string";
}