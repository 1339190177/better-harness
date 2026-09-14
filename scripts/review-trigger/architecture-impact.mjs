/**
 * Offline `architecture-impact` source for the review-trigger Stop hook.
 *
 * Decides only from changed paths matched against declared model bindings
 * plus the existing change-level thresholds. Performs no source parsing,
 * launches no application, and stays deterministic and cross-platform.
 *
 * The finding envelope carries `nextStep` that points to the Studio pane
 * for detailed exploration.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ARCH_MODEL_GLOBS = [
  "**/workspace.dsl",
  "**/*.structurizr.dsl",
  ".better-harness/architecture/model.dsl",
  ".better-harness/architecture/bindings.json",
];

export const DEFAULT_CHANGE_THRESHOLDS = {
  changedFiles: { warn: 8, high: 16, critical: 30 },
  changedLines: { warn: 250, high: 700, critical: 1500 },
};

/**
 * @param {object} options
 * @param {string} options.cwd - Repository root.
 * @param {Array<{path:string, added?:number, deleted?:number}>} options.changedFiles
 * @param {object} [options.config] - Optional threshold overrides.
 * @returns {Promise<Array>} Finding rows matching the review-trigger envelope.
 */
export async function collectArchitectureFindings(options) {
  const { cwd, changedFiles, config } = options;
  const findings = [];

  // Discover declared model
  const modelFile = await findArchModel(cwd);
  if (!modelFile) {
    return findings; // No model → no architecture to check
  }

  // Load bindings
  const bindingsDir = path.dirname(modelFile);
  const bindingsPath = path.join(bindingsDir, "bindings.json");
  let bindings = [];
  if (existsSync(bindingsPath)) {
    try {
      const raw = await readFile(bindingsPath, "utf8");
      bindings = JSON.parse(raw);
    } catch {
      // Ignore malformed bindings
    }
  }

  if (bindings.length === 0 && changedFiles.length === 0) {
    return findings;
  }

  // Check if any changed file crosses a binding boundary
  const changedPaths = changedFiles.map((f) => f.path);
  const crossedBindings = [];

  for (const binding of bindings) {
    const glob = binding.path_glob;
    if (!glob) continue;
    for (const filePath of changedPaths) {
      if (simpleGlobMatch(filePath, glob)) {
        crossedBindings.push({
          elementId: binding.element_id,
          file: filePath,
        });
      }
    }
  }

  // Aggregate change metrics
  const totalFiles = changedFiles.length;
  const totalLines = changedFiles.reduce(
    (sum, f) => sum + (f.added ?? 0) + (f.deleted ?? 0),
    0,
  );
  const threshold = config?.thresholds ?? DEFAULT_CHANGE_THRESHOLDS;

  const crossingCount = crossedBindings.length;
  const hasLargeChange =
    totalFiles >= threshold.changedFiles.warn ||
    totalLines >= threshold.changedLines.warn;

  // Emit finding when a declared boundary is crossed or change is large in a modeled area
  if (crossingCount > 0 && hasLargeChange) {
    const severity =
      totalFiles >= threshold.changedFiles.critical || totalLines >= threshold.changedLines.critical
        ? "warning"
        : "advisory";
    const elementIds = [...new Set(crossedBindings.map((b) => b.elementId))];

    findings.push({
      id: "architecture-impact.boundary-crossing",
      category: "architecture-impact",
      severity,
      source: "architecture-impact",
      file: modelFile,
      evidence: `${crossingCount} changed file(s) cross ${elementIds.length} declared architecture boundary element(s)`,
      metrics: {
        changedFiles: totalFiles,
        changedLines: totalLines,
        crossedBindings: crossingCount,
        affectedElements: elementIds.length,
      },
      nextStep: `Open the commit view in Studio and click "Architecture" in the detail pane to visualize the impact projection.`,
    });
  } else if (hasLargeChange && bindings.length > 0) {
    findings.push({
      id: "architecture-impact.large-change-without-model-activity",
      category: "architecture-impact",
      severity: "advisory",
      source: "architecture-impact",
      file: modelFile,
      evidence: `Large change (${totalFiles} files, ${totalLines} lines) but no declared architecture boundary was crossed`,
      metrics: {
        changedFiles: totalFiles,
        changedLines: totalLines,
        crossedBindings: 0,
        affectedElements: 0,
      },
      nextStep: "Review the changed files and consider if the architecture model needs updating.",
    });
  }

  return findings;
}

async function findArchModel(cwd) {
  for (const glob of ARCH_MODEL_GLOBS) {
    if (glob.startsWith(".better-harness/")) {
      const candidate = path.join(cwd, glob);
      if (existsSync(candidate)) return candidate;
      continue;
    }
    // For **/ patterns, do a simple find
    try {
      const { execFile } = await import("node:child_process");
      const result = await new Promise((resolve) => {
        execFile(
          "find",
          [cwd, "-maxdepth", "3", "-name", path.basename(glob), "-type", "f"],
          { timeout: 5000, maxBuffer: 4096 },
          (err, stdout) => {
            if (err) resolve(null);
            else {
              const lines = stdout.trim().split("\n").filter(Boolean);
              resolve(lines[0] ?? null);
            }
          },
        );
      });
      if (result) return result;
    } catch {
      // Ignore find failures
    }
  }
  return null;
}

function simpleGlobMatch(filePath, glob) {
  if (glob.endsWith("/**")) {
    const prefix = glob.slice(0, -3);
    return filePath.startsWith(prefix);
  }
  if (glob.endsWith("**")) {
    const prefix = glob.slice(0, -2);
    return filePath.startsWith(prefix);
  }
  if (glob.startsWith("**/")) {
    const suffix = glob.slice(3);
    return filePath.includes(suffix);
  }
  if (glob.includes("*")) {
    const parts = glob.split("*");
    if (parts.length === 2) {
      return filePath.startsWith(parts[0]) && filePath.endsWith(parts[1]);
    }
    return false;
  }
  return filePath === glob || filePath.startsWith(glob);
}