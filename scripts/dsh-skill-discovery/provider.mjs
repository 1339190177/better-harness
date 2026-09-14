/**
 * DSH Skill provider for the canonical Better Harness root.
 *
 * Emits the one candidate shape `verifyCanonicalSkill` in `./index.mjs` pins: `source`
 * `custom`, an absolute `SKILL.md` path, a directory `resourceBase` whose two parents are
 * the Better Harness root, a finite precedence rank, and user invocability. Discovery reads
 * the canonical Skill body from the package tree, so the shell never copies Skill content and
 * `skills/` stays the single owner of the workflow.
 *
 * Node builtins only: DSH loads this module in its host plane, where the package may be
 * installed without a resolvable dependency tree of its own.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

const SKILL_NAME = "better-harness";

/**
 * Mirrors the rank DSH's `skill-filesystem` provider assigns to `customSkillDirs` roots, so a
 * bundle-registered canonical Skill sits exactly where the documented manual route would put
 * it. DSH exports `BUNDLED_SKILL_RANK` but not this one, so the value is restated here and
 * pinned by `test/skills-docs/dsh-host-shell.test.mjs`.
 */
export const DSH_CUSTOM_SKILL_RANK = 300;

const UNSUPPORTED_SCALAR = new Set(["|", ">", "|-", "|+", ">-", ">+"]);

/**
 * YAML values that are not plain or quoted scalars. The hand-rolled parser sees
 * these as raw text, but native DSH parses them as non-string types and drops
 * the candidate. Reject them explicitly so this provider does not publish
 * literal YAML syntax in the catalog.
 */
const NON_STRING_YAML = new Set(["null", "true", "false", "~"]);
const NON_STRING_YAML_PREFIXES = ["[", "{"];

/**
 * Parse the `SKILL.md` frontmatter subset the canonical Skill uses: plain and single-quoted
 * `key: value` scalars between `---` fences. Indented continuation and nested lines are not
 * treated as top-level keys. A value that opens a block scalar is reported as unsupported
 * rather than silently truncated, because a provider that mis-reads its own input would
 * otherwise drop the Skill with no trace. An empty value stays empty; the `name` and
 * `description` guards reject it with their own reason.
 *
 * @param raw - full `SKILL.md` text.
 * @returns `{ data, body, unsupported }`, or `undefined` when the file is not frontmatter-shaped.
 */
export function parseSkillFrontmatter(raw) {
  const firstEnd = raw.indexOf("\n");
  if (firstEnd < 0 || raw.slice(0, firstEnd).replace(/\r$/, "") !== "---") return undefined;
  const data = {};
  const unsupported = [];
  let lineStart = firstEnd + 1;
  let bodyStart = -1;
  while (lineStart <= raw.length) {
    const next = raw.indexOf("\n", lineStart);
    const lineEnd = next < 0 ? raw.length : next;
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/, "");
    if (line === "---") {
      bodyStart = next < 0 ? raw.length : next + 1;
      break;
    }
    if (/^\s/.test(line) && line.trim().length > 0) {
      // An indented continuation after a top-level key that already received a non-empty
      // inline value means the frontmatter uses multi-line folding this parser does not
      // support. Flag the preceding key so the Skill is dropped with a warning rather than
      // published truncated. A key with an empty value (`metadata:`) opens a nested map,
      // whose indented children are skipped rather than flagged.
      const lastKey = Object.keys(data).pop();
      if (lastKey !== undefined && data[lastKey] !== "" && !unsupported.includes(lastKey)) {
        unsupported.push(lastKey);
      }
    } else {
      const colon = line.indexOf(":");
      if (colon > 0) {
        const key = line.slice(0, colon).trim();
        let value = line.slice(colon + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        } else if (UNSUPPORTED_SCALAR.has(value)) {
          unsupported.push(key);
        } else if (NON_STRING_YAML.has(value) || NON_STRING_YAML_PREFIXES.some((p) => value.startsWith(p))) {
          // YAML null, boolean, sequence, or mapping literal — not a string scalar.
          unsupported.push(key);
        }
        if (key.length > 0) data[key] = value;
      }
    }
    lineStart = next < 0 ? raw.length + 1 : next + 1;
  }
  if (bodyStart < 0) return undefined;
  return { data, body: raw.slice(bodyStart), unsupported };
}

const TRUTHY_BOOLEANS = new Set(["true", "yes", "on"]);
const FALSY_BOOLEANS = new Set(["false", "no", "off"]);

const INVOCATION_KEYS = ["disable-model-invocation", "user-invocable"];
const LEGACY_INVOCATION_KEYS = ["disableModelInvocation", "modelInvocable", "userInvocable"];

/** Sentinel distinguishing "key present but unparseable" from "key absent". */
const INVALID_BOOLEAN = Symbol("INVALID_BOOLEAN");

/**
 * Parse a DSH boolean value matching the vocabulary in `invocationBoolean`
 * (`scripts/agent-customize/providers/dsh.mjs`): native booleans, `1`/`0`,
 * and case-insensitive `true/false/yes/no/on/off`. Returns `undefined` only
 * when the key is absent (`!Object.hasOwn`). An explicitly present empty value
 * (`user-invocable:`) is treated as invalid, matching DSH's native rejection.
 */
function parseDshBoolean(value, present) {
  if (!present) return undefined;
  if (value === null || value === "") return INVALID_BOOLEAN;
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (TRUTHY_BOOLEANS.has(normalized)) return true;
    if (FALSY_BOOLEANS.has(normalized)) return false;
  }
  return INVALID_BOOLEAN;
}

/**
 * Derive the invocation policy the way DSH's filesystem provider does, from the
 * `disable-model-invocation` and `user-invocable` keys, defaulting to both enabled.
 * Returns `{ invocation, invalidKeys }` where `invalidKeys` lists any keys whose
 * values could not be parsed as DSH booleans or that use legacy camelCase names.
 */
function parseInvocation(data) {
  const invalidKeys = [];
  for (const key of LEGACY_INVOCATION_KEYS) {
    if (Object.hasOwn(data, key)) invalidKeys.push(key);
  }
  const disabled = parseDshBoolean(data["disable-model-invocation"], Object.hasOwn(data, "disable-model-invocation"));
  const user = parseDshBoolean(data["user-invocable"], Object.hasOwn(data, "user-invocable"));
  if (disabled === INVALID_BOOLEAN) invalidKeys.push("disable-model-invocation");
  if (user === INVALID_BOOLEAN) invalidKeys.push("user-invocable");
  return {
    invocation: {
      modelInvocable: disabled !== true,
      userInvocable: user !== false,
    },
    invalidKeys,
  };
}

/**
 * Resolve the canonical paths for one root. Kept separate from `resolveCanonicalPaths` in
 * `./index.mjs`, which validates an operator-supplied override; this function only normalizes
 * paths the shell already owns.
 */
export function skillPaths(betterHarnessRoot, { pathApi = path } = {}) {
  const root = pathApi.resolve(betterHarnessRoot);
  const skillDirectory = pathApi.join(root, "skills", SKILL_NAME);
  return { root, skillDirectory, skillFile: pathApi.join(skillDirectory, "SKILL.md") };
}

async function loadCanonical(paths, signal, warn) {
  let raw;
  try {
    raw = await readFile(paths.skillFile, { encoding: "utf8", signal });
  } catch (error) {
    if (error?.code === "ABORT_ERR" || error?.name === "AbortError" || signal?.aborted) return undefined;
    warn(`cannot read ${paths.skillFile}: ${error?.message ?? error}`);
    return undefined;
  }
  const parsed = parseSkillFrontmatter(raw);
  if (parsed === undefined) {
    warn(`${paths.skillFile} has no parsable YAML frontmatter; the Skill is not published`);
    return undefined;
  }
  const { data, body, unsupported } = parsed;
  if (data.name !== SKILL_NAME) {
    warn(`${paths.skillFile} declares name ${JSON.stringify(data.name)}, expected ${JSON.stringify(SKILL_NAME)}`);
    return undefined;
  }
  if (typeof data.description !== "string" || data.description.length === 0) {
    warn(`${paths.skillFile} declares no description; the Skill is not published`);
    return undefined;
  }
  if (unsupported.length > 0) {
    warn(
      `${paths.skillFile} uses frontmatter this provider does not parse (${unsupported.join(", ")}); ` +
        "the Skill is not published. Configure skill-filesystem.customSkillDirs for that shape.",
    );
    return undefined;
  }
  const { invocation, invalidKeys } = parseInvocation(data);
  if (invalidKeys.length > 0) {
    warn(
      `${paths.skillFile} has invalid invocation frontmatter (${invalidKeys.join(", ")}); ` +
        "the Skill is not published. Use DSH boolean values (true/false/yes/no/on/off/1/0).",
    );
    return undefined;
  }
  const whenToUse = typeof data.whenToUse === "string" && data.whenToUse.length > 0 ? data.whenToUse : undefined;
  return { name: data.name, description: data.description, whenToUse, invocation, content: body.trim() };
}

function toEntry(loaded, paths, { content = false, rank = DSH_CUSTOM_SKILL_RANK } = {}) {
  return {
    name: loaded.name,
    description: loaded.description,
    ...(loaded.whenToUse !== undefined ? { whenToUse: loaded.whenToUse } : {}),
    invocation: loaded.invocation,
    source: "custom",
    provider: SKILL_NAME,
    path: paths.skillFile,
    resourceBase: { kind: "directory", path: paths.skillDirectory },
    ...(content ? { content: loaded.content } : { rank }),
  };
}

/**
 * Build the provider instance for `ctx.skills.registerProvider`.
 *
 * @param paths - canonical `{ root, skillDirectory, skillFile }` paths.
 * @param options - `logger` receives the fail-closed warnings; `rank` overrides the
 *   documented custom rank for a host whose precedence table moves.
 * @returns a DSH Skill provider named after the canonical Skill.
 */
export function createBetterHarnessProvider(paths, { logger, rank = DSH_CUSTOM_SKILL_RANK } = {}) {
  const rankValue = Number.isFinite(rank) ? rank : DSH_CUSTOM_SKILL_RANK;
  const warn = (message) => {
    if (typeof logger?.warn === "function") logger.warn(`dsh-skill-discovery: ${message}`);
  };
  return {
    name: SKILL_NAME,
    async list(options) {
      const loaded = await loadCanonical(paths, options?.signal, warn);
      if (loaded === undefined) return [];
      return [toEntry(loaded, paths, { rank: rankValue })];
    },
    async get(candidate, options) {
      const loaded = await loadCanonical(paths, options?.signal, warn);
      if (loaded === undefined || loaded.name !== candidate?.name) return undefined;
      return toEntry(loaded, paths, { content: true });
    },
  };
}

export default { createBetterHarnessProvider, parseSkillFrontmatter, skillPaths, DSH_CUSTOM_SKILL_RANK };
