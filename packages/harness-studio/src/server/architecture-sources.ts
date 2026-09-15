/**
 * Which changed files a projection is about.
 *
 * The host reads code facts, and a file that carries none of them is not part of
 * the reading: naming a document as "not read" claims a gap in something the
 * diagram was never about, and reading it spends a request budget the code half
 * of the commit needs. A commit that moved code in a language v1 does not
 * extract is a different matter — the projection really is incomplete there —
 * so those files are still sent and still reported.
 *
 * The scope is therefore a list, not a guess: the extensions the host extracts,
 * plus the source languages v1 does not. A language belongs in that second list
 * the day a repository in it is read; an extension nobody listed carries no
 * symbols this projection could hold, and naming it as unread would be the noise
 * this module exists to keep out.
 */

/** The extensions `arch-core` parses into symbols. */
export const EXTRACTABLE = /\.(?:[cm]?[jt]sx?)$/u;

/**
 * Source languages v1 does not extract: named to a reader, never left out
 * silently, so "0 impacted symbols" is never the only thing said about a commit
 * that moved Go, Python or Rust code.
 */
const SOURCE_LANGUAGE = new Set([
  "go", "rs", "py", "pyi", "rb", "java", "kt", "kts", "swift", "cs", "php",
  "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "m", "mm", "scala", "clj", "cljs",
  "ex", "exs", "erl", "hs", "ml", "fs", "dart", "lua", "pl", "pm", "r", "jl",
  "zig", "nim", "v", "sol", "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "sql", "vue", "svelte", "astro", "elm",
]);

/** The extension of a path, lower-cased, or an empty string for none. */
function extension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  // A leading dot marks a hidden file, not an extension: `.babelrc` has none.
  const dot = name.indexOf(".", name.startsWith(".") ? 1 : 0);
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** True when the host parses this path into symbols. */
export function isExtractable(path: string): boolean {
  return EXTRACTABLE.test(path);
}

/**
 * True when a projection could hold symbols for this path: either the host
 * extracts it, or it is a source language the host does not extract yet.
 */
export function isSourceLike(path: string): boolean {
  if (isExtractable(path)) return true;
  const extensionName = extension(path);
  return extensionName !== "" && SOURCE_LANGUAGE.has(extensionName);
}
