/**
 * Which declared element a changed path belongs to.
 *
 * The file list a reading publishes names the boundary each file sits in, so a
 * reader answers "which module changed" from the file itself and not only from
 * the diagram. The match has to agree with the host's, or one path would be
 * shown under one element and marked as another — so this mirrors
 * `arch-core/project.rs::simple_glob_match` deliberately, naivety included:
 * a trailing `/**` is a prefix test, a leading `**` followed by a slash is a
 * contains test, a lone `*` a prefix/suffix pair, and anything else an exact
 * comparison.
 */
import type { ArchitectureSourceBinding } from "../contracts/architecture-impact.js";

/**
 * True when `glob` covers `path`, with `arch-core`'s own semantics.
 *
 * The branches are ordered as the host orders them, because they overlap: a
 * directory glob is a prefix test before it can be read as a wildcard pair.
 */
export function simpleGlobMatch(path: string, glob: string): boolean {
  if (glob.endsWith("/**")) return path.startsWith(glob.slice(0, -3));
  if (glob.endsWith("**")) return path.startsWith(glob.slice(0, -2));
  if (glob.startsWith("**/")) return path.includes(glob.slice(3));
  if (glob.includes("*")) {
    const parts = glob.split("*");
    return parts.length === 2 && path.startsWith(parts[0]!) && path.endsWith(parts[1]!);
  }
  return path === glob;
}

/**
 * Every element a binding maps this path onto, in binding order and without
 * repeats. A path can sit in a container and one of its components at once, and
 * the host marks both, so the list reports both rather than picking one.
 */
export function elementsOwningPath(path: string, bindings: readonly ArchitectureSourceBinding[]): string[] {
  const ids: string[] = [];
  for (const binding of bindings) {
    if (!simpleGlobMatch(path, binding.pathGlob)) continue;
    if (!ids.includes(binding.elementId)) ids.push(binding.elementId);
  }
  return ids;
}
