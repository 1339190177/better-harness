/**
 * The structural reading of one commit file change.
 *
 * The shape is ours, not difftastic's: a rendered line carries its own text, so
 * the client never converts byte columns into UTF-16 offsets and never needs a
 * second copy of either revision.
 */

export type StructuralDiffStatus = "changed" | "created" | "deleted" | "unchanged";

export interface StructuralDiffSegment {
  /** The run's text, exactly as it appears on that side. */
  text: string;
  /** Whether the engine considers this run changed on this side. */
  novel: boolean;
  /** difftastic's highlight kind, for example `keyword` or `string`. */
  highlight: string;
}

export interface StructuralDiffSide {
  /** 1-based line number in that revision. */
  lineNumber: number;
  segments: StructuralDiffSegment[];
}

export interface StructuralDiffLine {
  /** Absent when the line exists only in the newer revision. */
  lhs: StructuralDiffSide | null;
  /** Absent when the line exists only in the older revision. */
  rhs: StructuralDiffSide | null;
}

export interface StructuralDiffResult {
  /** The language the engine detected, for example `TypeScript TSX`, or `Text`. */
  language: string;
  status: StructuralDiffStatus;
  lines: StructuralDiffLine[];
}

export interface StructuralDiff extends StructuralDiffResult {
  kind: "StructuralDiffV1";
  sha: string;
  path: string;
}

/**
 * The capability Studio asks for. Implemented by the native host provider and
 * substituted in tests, so the route never owns process management.
 */
export interface StructuralDiffProvider {
  structuralDiff(params: {
    path: string;
    before: string;
    after: string;
  }): Promise<unknown>;
}

export function isStructuralDiff(value: unknown): value is StructuralDiff {
  if (!isRecord(value) || value.kind !== "StructuralDiffV1") return false;
  if (typeof value.sha !== "string" || typeof value.path !== "string") return false;
  return isStructuralDiffResult(value);
}

export function isStructuralDiffResult(value: unknown): value is StructuralDiffResult {
  if (!isRecord(value)) return false;
  return typeof value.language === "string"
    && isStatus(value.status)
    && Array.isArray(value.lines)
    && value.lines.every(isLine);
}

function isStatus(value: unknown): value is StructuralDiffStatus {
  return value === "changed" || value === "created" || value === "deleted" || value === "unchanged";
}

function isLine(value: unknown): value is StructuralDiffLine {
  if (!isRecord(value)) return false;
  return isSide(value.lhs) && isSide(value.rhs);
}

function isSide(value: unknown): value is StructuralDiffSide | null {
  if (value === null) return true;
  if (!isRecord(value) || !Number.isInteger(value.lineNumber) || Number(value.lineNumber) < 1) return false;
  return Array.isArray(value.segments) && value.segments.every(isSegment);
}

function isSegment(value: unknown): value is StructuralDiffSegment {
  return isRecord(value)
    && typeof value.text === "string"
    && typeof value.novel === "boolean"
    && typeof value.highlight === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
