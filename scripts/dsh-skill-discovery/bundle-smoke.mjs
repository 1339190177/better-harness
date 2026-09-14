#!/usr/bin/env node

/**
 * Credential-free owner smoke for the DeepSeek Harness host shell.
 *
 * Walks the shipped chain offline: the `package.json` declaration, the shell's single patch
 * row, that row's module target, the provider it registers, and the canonical verification the
 * published Skill definition must pass. It uses no network, no LLM, and no DSH install; the
 * real-DSH-owner case (real `SkillRegistry`, `tool-skill` pre-step, and `ToolRuntime.guard`) is
 * `npm run test:dsh-native`, and the live profile mount is evidenced in
 * `docs/specs/2026-09-11-dsh-host-shell-bundle-entry.md`.
 *
 * Run: `npm run test:dsh-bundle`
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import { createBetterHarnessProvider, parseSkillFrontmatter, skillPaths } from "./provider.mjs";
import { PACKAGED_ROOT, apply, selectRoot, watchCanonicalSkill } from "./bundle.mjs";
import { verifyCanonicalSkill } from "./index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = realpathSync(path.resolve(HERE, "..", ".."));
const SHELL_ROOT = ".dsh-plugin";
const ROW_ID = "better-harness";

function section(label) {
  process.stdout.write(`\n# ${label}\n`);
}

function pass(label) {
  process.stdout.write(`  ok  ${label}\n`);
}

const manifest = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8"));

// 1. Packaging contract: DSH reconciles on the declaration, so it must ship.
section("declaration");
const declaredPatch = manifest?.dsh?.bundle?.patch;
assert.ok(
  typeof declaredPatch === "string" && declaredPatch.length > 0,
  "package.json must declare dsh.bundle.patch so DSH reconciles the package as a profile layer",
);
const patchPath = path.resolve(REPOSITORY_ROOT, declaredPatch);
assert.ok(existsSync(patchPath), `dsh.bundle.patch points at a missing file: ${declaredPatch}`);
assert.ok(
  realpathSync(patchPath).startsWith(`${REPOSITORY_ROOT}${path.sep}`),
  `dsh.bundle.patch must stay inside the package, got ${patchPath}`,
);
assert.ok(manifest.files.includes(`${SHELL_ROOT}/`), `files must include ${SHELL_ROOT}/ so the shell ships`);
pass(`dsh.bundle.patch -> ${declaredPatch}, whitelisted in files`);

// 2. The shell is one row, thin, and names no absolute path.
section("shell");
const stack = parseYaml(readFileSync(patchPath, "utf8"));
assert.ok(Array.isArray(stack) && stack.length === 1, "the shell must contribute exactly one patch operation");
assert.ok(Array.isArray(stack[0]?.insert) && stack[0].insert.length === 1, "the shell must insert exactly one row");
const row = stack[0].insert[0];
assert.equal(row.id, ROW_ID, `the shell row id must be ${ROW_ID}`);
assert.equal(row.disabled, undefined, "the shell row must not ship disabled");
assert.equal(row.config, undefined, "the shipped shell must not configure an absolute Better Harness path");
// DSH resolves a relative row name against the patch file's own directory.
const entryPath = path.resolve(path.dirname(patchPath), row.name);
assert.ok(existsSync(entryPath), `the shell row names a missing module: ${row.name}`);
assert.ok(
  realpathSync(entryPath).startsWith(`${REPOSITORY_ROOT}${path.sep}`),
  `the shell row must resolve inside the package, got ${entryPath}`,
);
pass(`one row (${row.id}) resolves to ${path.relative(REPOSITORY_ROOT, entryPath)}`);

// 3. Thin stays thin: Node builtins and package siblings only.
section("thin imports");
for (const module of [entryPath, path.join(HERE, "provider.mjs"), path.join(HERE, "index.mjs")]) {
  const source = readFileSync(module, "utf8");
  // Match only actual import/require statements, not occurrences in comments or strings.
  const importRe = /^\s*import\s+(?:.*\s+from\s+)?["']([^"']+)["']|^\s*import\s*\(?\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']/gm;
  for (const match of source.matchAll(importRe)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier === undefined) continue;
    assert.ok(
      specifier.startsWith(".") || specifier.startsWith("node:"),
      `${path.relative(REPOSITORY_ROOT, module)} must not import bare specifier "${specifier}"`,
    );
  }
  pass(`${path.basename(module)} imports only node: builtins and siblings`);
}

// 4. Applying the entry publishes a definition the canonical verification accepts.
section("discovery + explicit-only policy");
const providers = [];
const guards = [];
const hooks = {};
const warnings = [];
const stubContext = {
  skills: {
    registerProvider(factory) {
      providers.push(factory({ signal: new AbortController().signal, invalidate() {} }));
      return () => {};
    },
    async get(name, options = {}) {
      for (const provider of providers) {
        const candidate = (await provider.list(options)).find((entry) => entry.name === name);
        if (candidate !== undefined) return provider.get(candidate, options);
      }
      return undefined;
    },
  },
  tools: {
    guard(hook) {
      guards.push(hook);
      return () => {};
    },
  },
  on(event, handler) {
    hooks[event] = handler;
    return () => {};
  },
  logger: { info() {}, warn(message) { warnings.push(String(message)); } },
};

const signal = new AbortController().signal;
await apply(stubContext, {});
assert.equal(providers.length, 1, "the shell must register exactly one Skill provider");
assert.equal(guards.length, 1, "the shell must attach the model-invocation guard");
assert.equal(typeof hooks["agent/pre-step"], "function", "the shell must attach the /better-harness pre-step");
assert.deepEqual(warnings, [], `discovery must be warning-free, got: ${warnings.join(" | ")}`);
pass("provider + guard + pre-step registered, no warnings");

const paths = selectRoot({});
assert.equal(paths.root, PACKAGED_ROOT, "the entry must self-locate the packaged root");
assert.equal(paths.skillFile, path.join(REPOSITORY_ROOT, "skills", ROW_ID, "SKILL.md"));
const candidate = (await providers[0].list({ signal }))[0];
assert.equal(candidate.source, "custom", "the canonical Skill must be published as a custom source");
assert.equal(candidate.provider, ROW_ID);
assert.equal(candidate.name, ROW_ID);
assert.ok(Number.isFinite(candidate.rank), "a candidate must carry a finite precedence rank");
assert.equal(candidate.path, paths.skillFile);
assert.deepEqual(candidate.resourceBase, { kind: "directory", path: paths.skillDirectory });
const definition = await stubContext.skills.get(ROW_ID, { signal });
assert.ok(typeof definition?.content === "string" && definition.content.includes("# Better Harness"));
assert.equal(definition.invocation.userInvocable, true);
const verification = await verifyCanonicalSkill({ betterHarnessRoot: PACKAGED_ROOT, skill: definition });
assert.equal(verification.verified, true, `canonical verification failed: ${verification.reasons.join(", ")}`);
assert.equal(verification.paths.root, PACKAGED_ROOT);
pass(`verifyCanonicalSkill passes with no reasons from the self-located root (${PACKAGED_ROOT})`);

assert.equal(
  typeof guards[0]({ name: "skill", arguments: { name: ROW_ID } }),
  "string",
  "a model-facing skill(better-harness) call must be refused",
);
assert.equal(guards[0]({ name: "bash", arguments: {} }), undefined, "unrelated tools must pass the guard");
pass("model-facing invocation refused; other tools unaffected");

let advanced = 0;
await hooks["agent/pre-step"](
  {
    agent: { session: { header: { cwd: REPOSITORY_ROOT } } },
    messages: [{ source: { kind: "user" }, content: [{ type: "text", text: "run /better-harness now" }] }],
    signal,
  },
  () => {
    advanced += 1;
    return undefined;
  },
);
assert.equal(advanced, 1, "a user-written /better-harness gesture must reach the step");
pass("explicit /better-harness gesture reaches the step");

// 5. Misconfiguration fails loud, and a broken tree fails closed but explainable.
section("failure modes");
await assert.rejects(
  () => apply(stubContext, { betterHarnessRoot: path.join(REPOSITORY_ROOT, "scripts") }),
  /cannot be published|absolute path/i,
  "a root without the canonical Skill must fail at apply time",
);
pass("an override root without the canonical Skill fails loud at apply");

await assert.rejects(
  () => apply(stubContext, { betterHarnessRoot: "skills" }),
  /absolute/i,
  "a relative betterHarnessRoot must be rejected by the policy validation",
);
pass("a relative betterHarnessRoot is rejected");

const broken = skillPaths(path.join(REPOSITORY_ROOT, "scripts", "dsh-skill-discovery"));
const brokenWarnings = [];
const brokenProvider = createBetterHarnessProvider(broken, {
  logger: { warn: (message) => brokenWarnings.push(String(message)) },
});
assert.deepEqual(await brokenProvider.list({ signal }), [], "a missing canonical Skill must yield an empty catalog");
assert.equal(brokenWarnings.length, 1, "the empty catalog must be explained by exactly one warning");
assert.match(brokenWarnings[0], /better-harness/);
pass("fail-closed discovery stays silent in the catalog but loud in the log");

const folded = parseSkillFrontmatter("---\nname: better-harness\ndescription: >\n  folded text\n---\nbody\n");
assert.deepEqual(folded.unsupported, ["description"], "a block scalar must be reported as unsupported");
const unterminated = parseSkillFrontmatter("---\nname: better-harness\ndescription: d\n");
assert.equal(unterminated, undefined, "unterminated frontmatter must return undefined, not hang");
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "dsh-smoke-unsupported-"));
try {
  const tmpSkillDir = path.join(tmpRoot, "skills", "better-harness");
  mkdirSync(tmpSkillDir, { recursive: true });
  writeFileSync(path.join(tmpSkillDir, "SKILL.md"), "---\nname: better-harness\ndescription: >\n  folded\n---\nbody\n");
  const dropWarnings = [];
  const dropProvider = createBetterHarnessProvider(skillPaths(tmpRoot), {
    logger: { warn: (message) => dropWarnings.push(String(message)) },
  });
  assert.deepEqual(await dropProvider.list({ signal }), [], "unsupported frontmatter must yield an empty catalog");
  assert.equal(dropWarnings.length, 1, "the drop must be explained by exactly one warning");
  assert.match(dropWarnings[0], /does not parse/);
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}
const shippedProvider = createBetterHarnessProvider(paths, {
  logger: { warn() {} },
});
assert.ok((await shippedProvider.list({ signal })).length === 1, "the shipped single-line frontmatter still parses");
pass("frontmatter this provider cannot parse is reported, never truncated silently");

const watched = watchCanonicalSkill(
  { signal: new AbortController().signal, invalidate() {} },
  paths,
  { warn() {} },
);
assert.equal(typeof watched, "function", "the watcher must return a disposer");
watched();
pass("skill watcher starts and disposes");

process.stdout.write("\nDSH host shell smoke: ok\n");
