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
  /** Paths the change reached without landing in them; a changed file is not one
   * of them, so a marked element means a radius rather than the change itself. */
  impactedFiles: string[];
}

/**
 * Changed files a reading could not include, and why.
 *
 * A projection is only honest if it says what it did not look at, so an omitted
 * file is reported rather than read as empty or allowed to void the reading.
 * What a projection is not about — a document, data, markup, an asset — is a
 * different matter: it holds no symbols, so it is no part of the reading.
 */
export interface ArchitectureOmission {
  count: number;
  /** Over the host's per-file bound, past this reading's request budget, past
   * the one-hop neighbourhood, in a source language the host does not extract,
   * or in the extracted language set but rejected by the parser. */
  reason: "too-large" | "request-budget" | "import-hop" | "unsupported-language" | "unparsed";
  /** One path from the group, so a reader can act on it. */
  examplePath: string;
}

/**
 * What a host must produce. The server owns `kind`, `sha`, `status` and
 * `omitted`: the commit under review, whether the change reached the model, and
 * which files were left out are facts about the request, not claims a provider
 * gets to make about its own output.
 */
export type ArchitectureImpactReading = Omit<ArchitectureImpact, "kind" | "sha" | "status" | "error" | "omitted"> & {
  /** Source files the host could not extract facts from, which the reading reports. */
  skipped: Array<{ path: string; diagnostics: string[] }>;
};

/**
 * Where the projected model came from.
 *
 * A `declared` model is authored on disk; a `generated` one is derived from the
 * worktree when none is declared, and carries a confidence so the pane can mark
 * it as a candidate a reader confirms rather than an authored fact.
 */
export interface ArchitectureModelSource {
  origin: "declared" | "generated";
  confidence?: "high" | "medium" | "low";
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
  /**
   * Element ids the change reached without landing in them: the radius, which a
   * reader needs on the diagram and not only as a count. Never repeats a changed
   * element, so the two states stay distinguishable.
   */
  impactedHitIds: string[];
  /** Change summary. */
  overlay: ArchitectureOverlay;
  /** Structurizr DSL for the projection. */
  dsl: string;
  /** Changed files this reading left out, grouped by reason. Empty when none. */
  omitted: ArchitectureOmission[];
  /** Where the projected model came from. Absent on an `unavailable` reading. */
  modelSource?: ArchitectureModelSource;
  /** Error message when unavailable. */
  error?: string;
}

/** A path glob bound to one declared element id. */
export interface ArchitectureSourceBinding {
  pathGlob: string;
  elementId: string;
}

export interface ArchitectureImpactProvider {
  architectureImpact(params: {
    sources: Array<{ path: string; source: string }>;
    trackedPaths: string[];
    changedPaths: string[];
    /** The worktree's declared model, in arch-core's own shape. */
    modelJson: unknown;
    /** Which declared element each path glob belongs to. */
    bindings: ArchitectureSourceBinding[];
  }): Promise<ArchitectureImpactReading>;
}

export function isArchitectureImpact(value: unknown): value is ArchitectureImpact {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.kind === "CommitArchitectureImpactV1"
    && typeof candidate.sha === "string"
    && ["impact", "no-impact", "unavailable"].includes(candidate.status as string)
    && Array.isArray(candidate.elements)
    && Array.isArray(candidate.relationships)
    && Array.isArray(candidate.impactedHitIds)
    && typeof candidate.dsl === "string"
    && Array.isArray(candidate.omitted);
}