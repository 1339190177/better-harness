import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";
import { test } from "vitest";

import { PACKAGED_ROOT, apply, selectRoot, watchCanonicalSkill } from "../../scripts/dsh-skill-discovery/bundle.mjs";
import { DSH_CUSTOM_SKILL_RANK, createBetterHarnessProvider, parseSkillFrontmatter, skillPaths } from "../../scripts/dsh-skill-discovery/provider.mjs";
import { verifyCanonicalSkill } from "../../scripts/dsh-skill-discovery/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = realpathSync(path.resolve(HERE, "../.."));
const SHELL_ROOT = ".dsh-plugin";
const ROW_ID = "better-harness";

function manifest() {
  return JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8"));
}

function shellRow() {
  const declared = manifest()?.dsh?.bundle?.patch;
  assert.ok(typeof declared === "string" && declared.length > 0, "package.json must declare dsh.bundle.patch");
  const patchPath = path.resolve(REPOSITORY_ROOT, declared);
  const stack = parseYaml(readFileSync(patchPath, "utf8"));
  assert.ok(Array.isArray(stack) && stack.length === 1, "the shell must contribute exactly one patch operation");
  assert.ok(Array.isArray(stack[0]?.insert) && stack[0].insert.length === 1, "the shell must insert exactly one row");
  return { patchPath, row: stack[0].insert[0] };
}

function stubContext() {
  const state = { providers: [], guards: [], hooks: {}, warnings: [], disposers: [] };
  const context = {
    skills: {
      registerProvider(factory) {
        const control = new AbortController();
        state.providers.push(factory({ signal: control.signal, invalidate() {} }));
        const dispose = () => control.abort();
        state.disposers.push(dispose);
        return dispose;
      },
      async get(name, options = {}) {
        for (const provider of state.providers) {
          const candidate = (await provider.list(options)).find((entry) => entry.name === name);
          if (candidate !== undefined) return provider.get(candidate, options);
        }
        return undefined;
      },
    },
    tools: {
      guard(hook) {
        state.guards.push(hook);
        return () => {};
      },
    },
    on(event, handler) {
      state.hooks[event] = handler;
      return () => {};
    },
    logger: { info() {}, warn(message) { state.warnings.push(String(message)); } },
  };
  return { context, state };
}

test("the DSH shell is declared, shipped, and carries no absolute path", () => {
  const packageJson = manifest();
  assert.ok(packageJson.files.includes(`${SHELL_ROOT}/`), `files must include ${SHELL_ROOT}/`);
  const { patchPath, row } = shellRow();
  assert.ok(existsSync(patchPath), "the declared patch file must exist");
  assert.equal(row.id, ROW_ID);
  assert.equal(row.disabled, undefined, "the shell row must not ship disabled");
  assert.equal(row.config, undefined, "the shell must not configure an absolute Better Harness root");
  // DSH resolves a relative row name against the patch file's own directory.
  const target = path.resolve(path.dirname(patchPath), row.name);
  assert.ok(existsSync(target), `the shell row must name a shipped module, got ${row.name}`);
  assert.ok(
    realpathSync(target).startsWith(`${REPOSITORY_ROOT}${path.sep}`),
    "the shell row must resolve inside the package",
  );
});

test("the shell entry stays thin: node builtins and package siblings only", () => {
  const { patchPath, row } = shellRow();
  const entry = path.resolve(path.dirname(patchPath), row.name);
  const modules = [entry, path.join(path.dirname(entry), "provider.mjs"), path.join(path.dirname(entry), "index.mjs")];
  for (const modulePath of modules) {
    const source = readFileSync(modulePath, "utf8");
    // Match only actual import/require statements, not occurrences in comments or strings.
    // Covers: import ... from "spec", import "spec", require("spec")
    const importRe = /^\s*import\s+(?:.*\s+from\s+)?["']([^"']+)["']|^\s*import\s*\(?\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']/gm;
    for (const match of source.matchAll(importRe)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (specifier === undefined) continue;
      assert.ok(
        specifier.startsWith(".") || specifier.startsWith("node:"),
        `${path.basename(modulePath)} must not import the bare specifier "${specifier}"`,
      );
    }
  }
});

test("the entry self-locates the packaged root and publishes one canonical candidate", async () => {
  assert.equal(PACKAGED_ROOT, REPOSITORY_ROOT, "the entry must resolve its own package root");
  const paths = selectRoot({});
  assert.deepEqual(paths, skillPaths(REPOSITORY_ROOT));
  assert.equal(paths.skillFile, path.join(REPOSITORY_ROOT, "skills", ROW_ID, "SKILL.md"));

  const { context, state } = stubContext();
  await apply(context, {});
  assert.equal(state.providers.length, 1);
  assert.deepEqual(state.warnings, [], "discovery must be warning-free on the shipped tree");

  const [candidate] = await state.providers[0].list({});
  assert.equal(candidate.name, ROW_ID);
  assert.equal(candidate.source, "custom", "only the custom source satisfies the canonical verification");
  assert.equal(candidate.provider, ROW_ID);
  assert.equal(candidate.path, paths.skillFile);
  assert.deepEqual(candidate.resourceBase, { kind: "directory", path: paths.skillDirectory });
  assert.equal(path.dirname(path.dirname(candidate.resourceBase.path)), REPOSITORY_ROOT, "two-parent root invariant");
  assert.equal(candidate.rank, DSH_CUSTOM_SKILL_RANK, "the emitted rank must be the pinned custom rank");
  assert.equal(DSH_CUSTOM_SKILL_RANK, 300, "the restated constant must mirror DSH's customSkillDirs rank");
  assert.equal(candidate.invocation.userInvocable, true);

  const definition = await context.skills.get(ROW_ID, {});
  assert.match(definition.content, /# Better Harness/);
  assert.equal(definition.rank, undefined, "a loaded definition carries the body, not the precedence rank");
});

test("the published definition passes the shipped canonical verification", async () => {
  const { context } = stubContext();
  await apply(context, {});
  const definition = await context.skills.get(ROW_ID, {});
  assert.ok(definition, "the Skill must be discoverable");
  const verification = await verifyCanonicalSkill({ betterHarnessRoot: PACKAGED_ROOT, skill: definition });
  assert.equal(verification.verified, true, verification.reasons.join(", "));
  assert.equal(verification.paths.root, PACKAGED_ROOT);
});

test("the same entry attaches the explicit-only policy without editing the owner", async () => {
  const { context, state } = stubContext();
  await apply(context, {});
  assert.equal(state.guards.length, 1, "the model-invocation guard must attach");
  assert.equal(typeof state.hooks["agent/pre-step"], "function", "the /better-harness pre-step must attach");
  assert.equal(
    typeof state.guards[0]({ name: "skill", arguments: { name: ROW_ID } }),
    "string",
    "a model-facing skill(better-harness) call must be refused",
  );
  assert.equal(state.guards[0]({ name: "bash", arguments: {} }), undefined, "unrelated tools must pass");

  let advanced = 0;
  await state.hooks["agent/pre-step"](
    {
      agent: { session: { header: { cwd: REPOSITORY_ROOT } } },
      messages: [{ source: { kind: "user" }, content: [{ type: "text", text: "run /better-harness now" }] }],
      signal: new AbortController().signal,
    },
    () => {
      advanced += 1;
      return undefined;
    },
  );
  assert.equal(advanced, 1, "a user-written gesture must reach the step");
});

test("discovery fails closed but explainable, and misconfiguration fails loud", async () => {
  const warnings = [];
  const broken = createBetterHarnessProvider(skillPaths(path.join(REPOSITORY_ROOT, "scripts", "dsh-skill-discovery")), {
    logger: { warn: (message) => warnings.push(String(message)) },
  });
  assert.deepEqual(await broken.list({}), [], "a missing canonical Skill must yield an empty catalog");
  assert.equal(warnings.length, 1, "the empty catalog must be explained by exactly one warning");

  const { context } = stubContext();
  await assert.rejects(
    () => apply(context, { betterHarnessRoot: path.join(REPOSITORY_ROOT, "scripts") }),
    /cannot be published/i,
    "an override root without the canonical Skill must reject at apply time",
  );
  await assert.rejects(
    () => apply(context, { betterHarnessRoot: "skills" }),
    /absolute/i,
    "a relative override must be rejected by the policy validation",
  );
});

test("unsupported frontmatter is reported rather than silently truncated", async () => {
  const folded = parseSkillFrontmatter("---\nname: better-harness\ndescription: >\n  folded\n---\nbody\n");
  assert.deepEqual(folded.unsupported, ["description"], "a block scalar must be flagged unsupported");
  const nested = parseSkillFrontmatter("---\nname: better-harness\ndescription: d\nmetadata:\n  owner: platform\n---\nbody\n");
  assert.deepEqual(nested.unsupported, [], "a nested map is skipped, not misread as a top-level key");
  assert.equal(nested.data.name, "better-harness");
  const empty = parseSkillFrontmatter("---\nname: better-harness\ndescription: d\nwhenToUse:\n---\nbody\n");
  assert.deepEqual(empty.unsupported, [], "an empty optional value must not block publishing");
  const continuation = parseSkillFrontmatter("---\nname: better-harness\ndescription: first line\n  continued here\n---\nbody\n");
  assert.deepEqual(continuation.unsupported, ["description"], "a plain scalar with indented continuation must be flagged");
  const yamlNull = parseSkillFrontmatter("---\nname: better-harness\ndescription: null\n---\nbody\n");
  assert.deepEqual(yamlNull.unsupported, ["description"], "YAML null description must be flagged as non-string");
  const yamlArray = parseSkillFrontmatter("---\nname: better-harness\ndescription: [x]\n---\nbody\n");
  assert.deepEqual(yamlArray.unsupported, ["description"], "YAML array description must be flagged as non-string");
  const yamlMap = parseSkillFrontmatter("---\nname: better-harness\ndescription: {x: y}\n---\nbody\n");
  assert.deepEqual(yamlMap.unsupported, ["description"], "YAML mapping description must be flagged as non-string");
  const unterminated = parseSkillFrontmatter("---\nname: better-harness\ndescription: d\n");
  assert.equal(unterminated, undefined, "unterminated frontmatter must return undefined, not hang");

  // Invalid boolean values must cause the provider to drop the Skill with a warning.
  const invalidBoolRoot = mkdtempSync(path.join(os.tmpdir(), "dsh-invalid-bool-"));
  try {
    const invalidSkillDir = path.join(invalidBoolRoot, "skills", "better-harness");
    mkdirSync(invalidSkillDir, { recursive: true });
    writeFileSync(path.join(invalidSkillDir, "SKILL.md"), "---\nname: better-harness\ndescription: d\nuser-invocable: maybe\n---\nbody\n");
    const boolWarnings = [];
    const boolProvider = createBetterHarnessProvider(skillPaths(invalidBoolRoot), {
      logger: { warn: (message) => boolWarnings.push(String(message)) },
    });
    assert.deepEqual(await boolProvider.list({}), [], "invalid boolean frontmatter must yield an empty catalog");
    assert.equal(boolWarnings.length, 1);
    assert.match(boolWarnings[0], /invalid invocation frontmatter/);
  } finally {
    rmSync(invalidBoolRoot, { recursive: true, force: true });
  }

  // Explicitly empty boolean values must be rejected as invalid.
  const emptyBoolRoot = mkdtempSync(path.join(os.tmpdir(), "dsh-empty-bool-"));
  try {
    const emptySkillDir = path.join(emptyBoolRoot, "skills", "better-harness");
    mkdirSync(emptySkillDir, { recursive: true });
    writeFileSync(path.join(emptySkillDir, "SKILL.md"), "---\nname: better-harness\ndescription: d\nuser-invocable:\n---\nbody\n");
    const emptyWarnings = [];
    const emptyProvider = createBetterHarnessProvider(skillPaths(emptyBoolRoot), {
      logger: { warn: (message) => emptyWarnings.push(String(message)) },
    });
    assert.deepEqual(await emptyProvider.list({}), [], "explicitly empty boolean must yield an empty catalog");
    assert.equal(emptyWarnings.length, 1);
    assert.match(emptyWarnings[0], /invalid invocation frontmatter/);
  } finally {
    rmSync(emptyBoolRoot, { recursive: true, force: true });
  }

  // Legacy camelCase invocation keys must also be rejected.
  const legacyRoot = mkdtempSync(path.join(os.tmpdir(), "dsh-legacy-bool-"));
  try {
    const legacySkillDir = path.join(legacyRoot, "skills", "better-harness");
    mkdirSync(legacySkillDir, { recursive: true });
    writeFileSync(path.join(legacySkillDir, "SKILL.md"), "---\nname: better-harness\ndescription: d\nuserInvocable: false\n---\nbody\n");
    const legacyWarnings = [];
    const legacyProvider = createBetterHarnessProvider(skillPaths(legacyRoot), {
      logger: { warn: (message) => legacyWarnings.push(String(message)) },
    });
    assert.deepEqual(await legacyProvider.list({}), [], "legacy camelCase invocation keys must yield an empty catalog");
    assert.equal(legacyWarnings.length, 1);
    // Legacy keys with YAML boolean values are caught by the non-string YAML guard
    // (which fires before the invocation check), but the Skill is still dropped.
    assert.ok(
      /does not parse|invalid invocation frontmatter/.test(legacyWarnings[0]),
      "the warning must explain why the Skill was dropped",
    );
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true });
  }

  const warnings = [];
  const provider = createBetterHarnessProvider(skillPaths(REPOSITORY_ROOT), {
    logger: { warn: (message) => warnings.push(String(message)) },
  });
  assert.equal((await provider.list({})).length, 1, "the shipped single-line frontmatter still publishes");
  assert.equal(parseSkillFrontmatter('---\nname: "better-harness"\ndescription: \'x\'\n---\n').data.description, "x");
  assert.equal(parseSkillFrontmatter("no fence\n"), undefined);
  assert.deepEqual(warnings, []);

  // The warn-and-drop branch: a provider over a root with unsupported frontmatter must
  // yield an empty catalog and explain why.
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "dsh-unsupported-"));
  try {
    const tmpSkillDir = path.join(tmpRoot, "skills", "better-harness");
    mkdirSync(tmpSkillDir, { recursive: true });
    writeFileSync(path.join(tmpSkillDir, "SKILL.md"), "---\nname: better-harness\ndescription: >\n  folded\n---\nbody\n");
    const dropWarnings = [];
    const dropProvider = createBetterHarnessProvider(skillPaths(tmpRoot), {
      logger: { warn: (message) => dropWarnings.push(String(message)) },
    });
    assert.deepEqual(await dropProvider.list({}), [], "unsupported frontmatter must yield an empty catalog");
    assert.equal(dropWarnings.length, 1, "the drop must be explained by exactly one warning");
    assert.match(dropWarnings[0], /does not parse/, "the warning must name the parsing limitation");
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("an unresolvable override root is explained, not surfaced as a raw filesystem error", async () => {
  const { context } = stubContext();
  await assert.rejects(
    () => apply(context, { betterHarnessRoot: path.join(REPOSITORY_ROOT, "does-not-exist") }),
    /cannot be resolved/,
    "a missing override root must report the actionable override message",
  );
});

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

test("the Skill watcher arms, fires on change, and disposes without leaking", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-watch-"));
  const skillDir = path.join(dir, "skills", "better-harness");
  try {
    mkdirSync(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, "SKILL.md");
    writeFileSync(skillFile, "---\nname: better-harness\ndescription: d\n---\nbody\n");

    let invalidated = 0;
    const lifecycle = new AbortController();
    const dispose = watchCanonicalSkill(
      { signal: lifecycle.signal, invalidate: () => { invalidated += 1; } },
      { root: dir, skillDirectory: skillDir, skillFile },
      { warn() {} },
    );
    assert.equal(typeof dispose, "function");

    // Positive path: a real change must trigger invalidation within the deadline.
    writeFileSync(skillFile, "---\nname: better-harness\ndescription: changed\n---\nbody\n");
    const fired = await waitFor(() => invalidated >= 1, 3000);
    assert.ok(fired, "a canonical Skill change must invalidate the catalog within the deadline");

    // Negative path: after abort + dispose, no further invalidation.
    // Wait longer than the debounce window (200 ms) so any stale timer would
    // have fired if disposal failed.
    const before = invalidated;
    lifecycle.abort();
    dispose();
    writeFileSync(skillFile, "---\nname: better-harness\ndescription: again\n---\nbody\n");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(invalidated, before, "an aborted registration must not invalidate the catalog");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
