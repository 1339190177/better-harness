/**
 * One import hop around a commit's changed files.
 *
 * `arch-core` builds its symbol graph from the files it is handed, so a caller
 * the commit did not itself change is invisible: "impacted" reads 0 for almost
 * every commit. Handing it the changed files *plus* their immediate neighbours
 * makes the reverse edges real, without parsing the whole repository.
 *
 * The neighbourhood is bounded and deterministic. Candidates are the tracked,
 * parseable files in a changed file's own directory and in the one above it —
 * where a relative import can reach it — best candidates first, and the bound
 * reports what it left out rather than silently narrowing the radius.
 */
import { posix } from "node:path";
import { isExtractable } from "./architecture-sources.js";

/** Bounded so one hop cannot cost more than the reading it explains. */
export const MAX_HOP_FILES = 200;

export interface ImportHop {
  /** Best candidates first, already deduplicated. */
  candidates: string[];
  /** Candidates the bound left out, so the reader knows the hop is partial. */
  truncated: number;
  /** The first candidate the bound dropped, named in the notice. */
  firstDropped: string;
}

export function selectImportHop(
  trackedPaths: readonly string[],
  changedPaths: readonly string[],
  alreadySent: ReadonlySet<string>,
): ImportHop {
  const byDirectory = new Map<string, string[]>();
  for (const path of trackedPaths) {
    // Only what the host extracts: a neighbour it could only report as unread
    // would cost the reading without ever being able to answer it.
    if (!isExtractable(path)) continue;
    const directory = posix.dirname(path);
    const bucket = byDirectory.get(directory);
    if (bucket === undefined) byDirectory.set(directory, [path]);
    else bucket.push(path);
  }
  for (const bucket of byDirectory.values()) bucket.sort();

  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const changed of [...changedPaths].sort()) {
    const directory = posix.dirname(changed);
    const parent = posix.dirname(directory);
    // A relative specifier resolves inside the changed file's own directory or
    // the one above it, so those two hold every file that can import it.
    const roots = parent === "." || parent === directory ? [directory] : [directory, parent];
    for (const root of roots) {
      for (const path of byDirectory.get(root) ?? []) {
        if (path === changed || seen.has(path) || alreadySent.has(path)) continue;
        seen.add(path);
        candidates.push(path);
      }
    }
  }
  return {
    candidates: candidates.slice(0, MAX_HOP_FILES),
    truncated: Math.max(0, candidates.length - MAX_HOP_FILES),
    firstDropped: candidates[MAX_HOP_FILES] ?? "",
  };
}
