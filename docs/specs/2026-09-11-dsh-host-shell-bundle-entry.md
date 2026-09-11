# Ship a DeepSeek Harness host shell so one plugin add registers Better Harness

## Traceability

- Spec ID: dsh-host-shell-bundle-entry
- Status: Implemented

## Intent

DSH is the only host in the [Host Adapter Matrix](../adapters/README.md) whose verified
install/discovery route requires the user to hand-edit host configuration. Today the route
documented in the matrix points `skill-filesystem.customSkillDirs` at an absolute
`<BETTER_HARNESS_ROOT>/skills` directory and loads `scripts/dsh-skill-discovery/index.mjs`
as a local Cordis policy row with the same absolute root. That works, but it is manual
two-row wiring, it breaks when the package moves, it is per-preset rather than global, and a
later user row that restates `customSkillDirs` silently removes Better Harness. Every other
host ships a thin metadata root in the package (`.claude-plugin/`, `.qoder-plugin/`,
`.cursor-plugin/`, `.codex-plugin/`, `.github/plugin/`, `.kimi-plugin/`, `qwen-extension.json`,
and the `pi` manifest) so the host's own install command discovers it.

DSH already has the matching mechanism: a profile dependency whose `package.json` declares
`dsh.bundle.patch` is reconciled into `dsh.profile.bundles` automatically, so
`dsh plugin --profile <name> add @qoder-ai/better-harness` is enough. This spec adds the
missing eighth shell so Better Harness uses that mechanism, and makes the shell self-locate
its own package root so no absolute path is configured anywhere.

Outcome: an operator installs the published package with one host command and gets the same
guarantees the manual route gives today (global discovery of the canonical Skill, explicit-only
invocation, canonical verification before injection), with no preset edit, no hand-written
Cordis row, and no path to update when the root moves.

## Acceptance Scenarios

- AC-1: `package.json` declares `dsh.bundle.patch` pointing at a shipped patch file, so DSH's
  profile reconcile activates the package as a bundle layer with no user-authored Cordis row.
- AC-2: The shell resolves to exactly one plugin row, and that row's module loads in the DSH
  host plane and registers the `better-harness` Skill into the global skills layer, independent
  of the active preset.
- AC-3: The Skill root is self-located from the entry module's own URL. No absolute
  Better Harness path appears in any shipped configuration, and moving or reinstalling the
  package requires no path edits.
- AC-4: The winning definition still passes the existing canonical verification unchanged:
  `custom` source, absolute `SKILL.md` path, directory `resourceBase`, two-parent root
  invariant, required `scripts/`, `references/`, `models/`, `templates/` resources, and
  user invocability.
- AC-5: The explicit-only policy attaches from the same entry by reusing
  `scripts/dsh-skill-discovery/index.mjs` unmodified, so model-facing
  `skill({ name: "better-harness" })` calls stay rejected and only a user-written
  `/better-harness` gesture passes.
- AC-6: The shell stays thin and removal stays symmetric. The shell owns only install/discovery
  metadata plus a pointer to a capability-owned module; the entry imports Node builtins and
  package siblings only; dropping the package from the profile disposes the provider and the
  policy together.
- AC-7: Packaging contracts hold: the shell ships in the public npm package, is registered in
  the package verifier's required-entry list, stays excluded from the Qoder runtime bundle, and
  `npm run pack:verify` passes.
- AC-8: Deterministic tests plus a credential-free owner smoke pass, and the matrix, glossary,
  ADR root count, and installation guide state the new route and its evidence level honestly.

## Non-goals

- No plugin-lifecycle profile (`scripts/host-support/profiles/dsh.mjs`) and no
  `harness prepare --platform dsh` install surface. Better Harness install/status/verify
  dispositions are a separate slice, and this change does not register one slice to make
  another look complete.
- No change to the session-analysis DSH adapter or its strict replay contract. A bundle entry
  does not make DSH session evidence readable: the producer-drift gap that rejects populated
  `.jsonl.zstd` artifacts is tracked separately, and its status is unchanged by this spec.
- No promotion of DSH to the README Quickstart list or public install list. The capability
  level stays "verified install/discovery" until report-loop evidence exists.
- No removal of the documented manual `customSkillDirs` route. It remains the fallback for a
  profile that cannot carry bundle layers, and remains the only route for DSH `minimal`, which
  mounts no Skill loader.
- No new Skill frontmatter semantics, and no change to `skills/better-harness/SKILL.md`.
- No claim that an out-of-tree copy of the package is required. The shell is qualified against
  the package tree it ships in.

## Plan and Tasks

Discovery mechanism first, then the two files DSH needs, then the registration points a host
shell is required to line up with.

1. `scripts/dsh-skill-discovery/provider.mjs` (new): a dependency-free Skill provider that
   reads the canonical `skills/better-harness/SKILL.md` from an injected root and emits the one
   candidate shape the canonical verification pins (`source: "custom"`, absolute `path`,
   directory `resourceBase`, `rank` at the host's custom-directory rank, `invocation` derived
   from `disable-model-invocation` / `user-invocable`). Parse failure or a non-canonical
   frontmatter yields an empty catalog and one loud warning, so a Skill that disappears is
   diagnosable instead of silent.
2. `scripts/dsh-skill-discovery/bundle.mjs` (new): the DSH bundle entry. It self-locates the
   package root from `import.meta.url` through `realpath` (so pnpm isolated-store symlinks
   cannot trip the `symbolic-link-not-supported` reason), registers the provider through
   `ctx.skills.registerProvider` in the host plane, invalidates the catalog when `SKILL.md`
   changes, and delegates the policy to `createPlugin()` from `index.mjs` with the same root.
   `index.mjs` is not modified: it carries the audited `DSH_NATIVE_SOURCE_SHA` and its own
   contract test.
3. `.dsh-plugin/cordis.patch.yml` (new): the shell. One `insert` row whose `id` is
   `better-harness` and whose `name` points at the entry module. Comments record why the row is
   global and how removal behaves.
4. `package.json`: declare `dsh.bundle.patch`, add `.dsh-plugin/` to the `files` whitelist, and
   add the owner smoke script.
5. `scripts/npm-package/verify-pack.mjs`: treat `.dsh-plugin/cordis.patch.yml` as a required
   package entry and keep `.dsh-plugin/` out of the generated Qoder runtime bundle, matching how
   the other metadata roots are handled.
6. Tests: `test/skills-docs/dsh-host-shell.test.mjs` (vitest, no DSH install needed) asserts the
   declaration/whitelist/row-target chain, the thin-import rule, provider candidate fields,
   fail-closed behavior, and that the produced definition passes the real
   `verifyCanonicalSkill`. Plus `scripts/dsh-skill-discovery/bundle-smoke.mjs`, a credential-free
   plain-Node owner smoke that repeats the same chain against the shipped package tree. And the
   existing real-owner smoke `scripts/dsh-skill-discovery/native-smoke.mjs` gains a host-shell
   case that mounts the entry against the pinned DSH owners with no `skill-filesystem` row and no
   `customSkillDirs`, so the shell is proven on the same owners the manual route is.
7. Register the root where a host shell must be registered: `plugin-manifests` public-path list,
   and the `docs/glossary.md`, `docs/docs/concepts/glossary.md`, `docs/community.md`,
   `docs/ARCHITECTURE.md`, and `docs/adrs/directory-structure.md` root enumerations and count.
8. Docs: matrix DSH row and notes (shell exists; the manual route is now the fallback), and the
   DSH section of `docs/docs/installation.mdx`.

Decision rationale. DSH's `bundledSkillDir` and user skill roots were rejected because the
canonical verification requires `source: "custom"`, which only the custom-directories root
produces, and because `customSkillDirs` is whole-row config a later layer replaces. A profile
bundle layer plus `registerProvider` is the only shape that is simultaneously global,
clobber-resistant, and self-locating. `config.betterHarnessRoot` stays accepted on the row so a
deployment can still point one install at a different root, which is what the out-of-tree
patched-copy workflow needs.

## Test and Review Evidence

AC-1 and AC-2, on the real host (DSH `0.1.2-rc.1`, throwaway `DSH_HOME`):

- `dsh plugin --profile bh add link:<better-harness checkout>` printed
  `+ @qoder-ai/better-harness` and the created profile manifest then lists
  `@qoder-ai/better-harness` second in `dsh.profile.bundles`, while the profile's own
  `cordis.patch.yml` is still the untouched initialized template `[]`. No hand-authored row was
  involved; the declaration alone activated the layer.
- `dsh --profile bh --dump-config` shows the layer section for
  `@qoder-ai/better-harness` containing `- id: better-harness` whose module resolves to
  `file:///…/node_modules/@qoder-ai/better-harness/scripts/dsh-skill-discovery/bundle.mjs`.
  DSH's own loader accepted the shell and resolved its relative row name inside the installed
  layout, which is what AC-3 needs at load time.

AC-2, AC-3, AC-4, and AC-5, on the pinned owners: `npm run test:dsh-native` at DSH
`0.1.1-rc.2` adds a `hostShell` result of
`verified bundle layer, no customSkillDirs and no configured root` alongside the existing
`discovery: verified`, `explicitInvocation: injected before model request derivation`, and
`modelInvocation: rejected`. The new case mounts only `SkillRegistry`, `tool-skill`, and
`ToolRuntime` plus the entry, asserts `PACKAGED_ROOT` equals the checkout root, and requires
`verifyCanonicalSkill` to return zero reasons for the winning definition.

AC-3 through AC-6, offline chain: `npm run test:dsh-bundle` walks declaration, shell, thin
imports, discovery, policy, and failure modes to `DSH host shell smoke: ok`, including the
loud-failure cases (a root without the canonical Skill, a relative override, and a frontmatter
shape this provider does not parse).

AC-7: `npm run pack:verify` reported
`pack verification passed: npm 728 entries, runtime zip 989 entries` with
`package/.dsh-plugin/cordis.patch.yml` in the required-entry list and `.dsh-plugin/` kept out of
the runtime bundle.

AC-8: the vitest suite passes with the new `test/skills-docs/dsh-host-shell.test.mjs` and the
extended public-host-manifest list. The repository's own Markdown validator caught a defect in
the first draft of the matrix note (an inline code span split across lines surfaced as
`Markdown contains an unterminated code span` in
`test/plugins/antigravity-plugin-artifact.test.mjs`); the wording was fixed in this change and
that file is green again.

Evidence boundaries:

- On a host whose npm is newer than the `packageManager` pin, `npm run test:dsh-*` fails inside
  the nested owner install with `EALLOWSCRIPTS` before any assertion runs. This reproduces
  identically on the untouched sibling step `test:dsh-configured-assets-native`, so it is an
  environment artifact rather than a change here; the smokes were executed directly as
  `node scripts/dsh-skill-discovery/<file>.mjs`, which is the same entry point.
- An interactive boot in the throwaway home was not observed end to end, because that home has
  no model credentials. Host-side load evidence is the `--dump-config` resolution plus the pinned
  real-owner smoke, not a completed report.
- Discovery success is not report-loop success. The session-analysis adapter still rejects
  drifted DSH artifacts, so `eligibleSessions` can remain zero with this shell fully working.

Risk notes: a profile that already carries an out-of-tree wrapper row must drop it in the same
change that adds this bundle. DSH documents a second skill provider with the same name in one
layer as an error, but a host probe on DSH `0.1.2-rc.1` that mounted this entry together with
another provider named `better-harness` surfaced no boot failure and answered the catalog with
the *other* provider's candidate in both mount orders. Double mounting is therefore unreliable
rather than checked, and the shipped docs say so in those terms. A global provider makes the
canonical Skill visible in every session on the profile,
which is intended but is a wider surface than the per-preset manual route. Session evidence
remains blocked by the adapter drift gap called out in Non-goals; passing discovery must not be
read as a working report loop.
