/**
 * DSH bundle entry: the executable half of the `.dsh-plugin/` host shell.
 *
 * DSH loads this module from a profile bundle layer (an unscoped host-plane context), so one
 * row does both jobs the documented manual route does by hand:
 *
 *   1. publish the canonical `better-harness` Skill into the global skills layer, where every
 *      session's catalog read merges it regardless of the active preset; and
 *   2. attach the explicit-only policy from `./index.mjs`, so a model-facing Skill call is
 *      refused and only a user-written `/better-harness` gesture can inject the body, after the
 *      winning definition is verified against the canonical root.
 *
 * The root is self-located from this module's own URL, so no absolute Better Harness path is
 * configured anywhere and reinstalling or relocating the package needs no edits. Passing
 * `config.betterHarnessRoot` still redirects both jobs to another complete root, which is how a
 * deployment keeps a patched out-of-tree copy.
 *
 * Node builtins and package siblings only: DSH may load the package without a resolvable
 * dependency tree of its own.
 */
import { existsSync, realpathSync, watch } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createPlugin, resolveCanonicalPaths } from "./index.mjs";
import { createBetterHarnessProvider, skillPaths } from "./provider.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The package root this entry ships in, canonicalized so isolated-store symlinks cannot trip verification. */
export const PACKAGED_ROOT = realpathSync(resolve(HERE, "..", ".."));

export const name = "better-harness";
export const inject = ["skills", "tools"];

/**
 * Choose the root both jobs bind to.
 *
 * @param config - the row config; `betterHarnessRoot` optionally redirects to another complete root.
 * @returns canonical `{ root, skillDirectory, skillFile }` paths.
 */
export function selectRoot(config = {}) {
  const override = config?.betterHarnessRoot;
  if (override === undefined || override === null || override === "") {
    return skillPaths(PACKAGED_ROOT);
  }
  // Reuse the policy's own validation so an operator mistake fails the same way in both halves.
  const { root } = resolveCanonicalPaths(override);
  try {
    return skillPaths(realpathSync(root));
  } catch {
    throw new Error(
      `dsh-skill-discovery: betterHarnessRoot ${JSON.stringify(root)} cannot be resolved; ` +
        "point it at a complete Better Harness package, or drop the override to use this one.",
    );
  }
}

/**
 * Invalidate the skills catalog when the canonical Skill body changes. The directory is watched
 * rather than the file so an editor or installer that replaces `SKILL.md` (new inode) keeps
 * working, which a file watch silently does not.
 *
 * @param control - the DSH registration control (`signal` and `invalidate`).
 * @param paths - canonical paths from {@link selectRoot}.
 * @param logger - host logger for the unavailable-watcher warning.
 * @returns a disposer that closes the watcher.
 */
export function watchCanonicalSkill(control, paths, logger) {
  let timer;
  let watcher;
  try {
    watcher = watch(paths.skillDirectory, { persistent: false }, (_event, filename) => {
      if (filename !== null && filename !== undefined && filename !== "SKILL.md") return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          control.invalidate();
        } catch {
          /* the registration is already disposed */
        }
      }, 200);
    });
    watcher.on("error", (error) => {
      if (typeof logger?.warn === "function") {
        logger.warn(`dsh-skill-discovery: skill watcher error: ${error?.message ?? error}`);
      }
      try {
        watcher.close();
      } catch {
        /* already closed */
      }
    });
  } catch (error) {
    if (typeof logger?.warn === "function") {
      logger.warn(`dsh-skill-discovery: skill watcher unavailable: ${error?.message ?? error}`);
    }
    return () => {};
  }
  const stop = () => {
    clearTimeout(timer);
    try {
      watcher?.close();
    } catch {
      /* already closed */
    }
  };
  if (control.signal?.aborted) {
    stop();
    return stop;
  }
  control.signal?.addEventListener?.("abort", stop, { once: true });
  return stop;
}

/**
 * Cordis plugin entry.
 *
 * @param ctx - the unscoped host-plane DSH context the bundle row runs in.
 * @param config - row config; see {@link selectRoot}.
 */
export async function apply(ctx, config = {}) {
  const paths = selectRoot(config);
  if (!existsSync(paths.skillFile)) {
    throw new Error(
      `dsh-skill-discovery: ${paths.skillFile} does not exist, so the better-harness Skill cannot be published. ` +
        "Install the complete package, or point this row's betterHarnessRoot at one.",
    );
  }

  ctx.skills.registerProvider((control) => {
    watchCanonicalSkill(control, paths, ctx.logger);
    return createBetterHarnessProvider(paths, { logger: ctx.logger });
  });

  // The explicit-only guard and the `/better-harness` pre-step, reused unmodified.
  await createPlugin()(ctx, { betterHarnessRoot: paths.root });

  if (typeof ctx.logger?.info === "function") {
    ctx.logger.info(`dsh-skill-discovery: published better-harness from ${paths.skillFile} (global skills layer)`);
  }
}

export default { name, inject, apply };
