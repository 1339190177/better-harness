import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { startHarnessStudioServer } from "../../dist/server/server.js";

/**
 * The Impact surface is the projection's own home: a chooser for the commit it
 * reads, and the diagram it draws. Commits keeps history, so this spec also
 * holds the two apart: a projection inside the history workbench is the state
 * this surface was extracted from, and it must not come back.
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let studio;
let workspace;
let newest;
/** The changed paths the surface asked about, in the order it asked. */
const projected = [];

test.beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "studio-impact-browser-"));
  const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Studio Browser");
  git("config", "user.email", "browser@example.com");
  await mkdir(join(workspace, "store"), { recursive: true });
  await writeFile(join(workspace, "store", "index.ts"), "export function load(): number {\n  return 1;\n}\n", "utf8");
  await writeFile(join(workspace, "store", "caller.ts"), "import { load } from \"./index\";\nexport const read = () => load();\n", "utf8");
  git("add", ".");
  git("commit", "-m", "feat: add the store");
  // The server reads the declared model before it asks anything to project it, so
  // the fixture publishes one even though the projection itself is answered here.
  await mkdir(join(workspace, ".better-harness", "architecture"), { recursive: true });
  await writeFile(join(workspace, ".better-harness", "architecture", "model.json"), JSON.stringify({
    elements: [
      { id: "store", name: "Store", kind: "Container", description: "Where the change lands.", technology: "TypeScript", tags: ["core"], parent_id: null },
      { id: "caller", name: "Caller", kind: "Container", description: null, technology: null, tags: [], parent_id: null },
    ],
    relationships: [{ id: "caller-reads-store", source_id: "caller", target_id: "store", description: "reads", technology: null, kind: "DeclaredRelationship" }],
  }), "utf8");
  await writeFile(join(workspace, ".better-harness", "architecture", "bindings.json"), JSON.stringify([
    { path_glob: "store/index.ts", element_id: "store" },
    { path_glob: "store/caller.ts", element_id: "caller" },
  ]), "utf8");
  await writeFile(join(workspace, "store", "index.ts"), "export function load(): number {\n  return 2;\n}\n", "utf8");
  git("add", "store/index.ts");
  git("commit", "-m", "feat: read two");
  newest = git("rev-parse", "--short", "HEAD");

  studio = await startHarnessStudioServer({
    appDir: join(packageRoot, "dist", "app"),
    port: 0,
    // A browser run has no native host staged. The surface reads a projection, so
    // the fixture answers one and the spec asserts what the reader sees of it.
    architectureImpactProvider: {
      async architectureImpact(params) {
        projected.push(params.changedPaths.join(","));
        return {
          elements: [
            { id: "store", name: "Store", kind: "Container", description: "Where the change lands.", technology: "TypeScript", tags: ["core"] },
            { id: "caller", name: "Caller", kind: "Container", tags: [] },
          ],
          relationships: [{ id: "caller-reads-store", sourceId: "caller", targetId: "store", description: "reads", kind: "DeclaredRelationship" }],
          observedEdges: [],
          codeHitIds: ["store"],
          changedHitIds: ["store"],
          impactedHitIds: ["caller"],
          overlay: { changedSymbols: 2, impactedSymbols: 1, impactedFiles: ["store/index.ts"] },
          dsl: "workspace \"Impact fixture\" {}\n",
          skipped: [],
        };
      },
    },
    workspaceDirectoryPicker: async () => workspace,
    workspaceSessionProvider: { discover: async () => ({ label: "impact-fixture", sessions: [] }) },
  });
  const opened = await fetch(`${studio.url}/api/workspace/open`, { method: "POST" });
  if (!opened.ok) throw new Error(`Could not open the impact fixture: ${await opened.text()}`);
});

test.afterAll(async () => {
  await studio?.close();
  await rm(workspace, { recursive: true, force: true });
});

test("projects the chosen commit without borrowing the history workbench", async ({ page }) => {
  await page.goto(`${studio.url}/#/impact`);
  await expect(page.locator(".impact-view")).toBeVisible();
  // The chooser opens on the newest commit, so the surface never lands empty.
  await expect(page.locator(".impact-commit[aria-current='true']")).toContainText("feat: read two");
  await expect(page.locator(".arch-header")).toContainText(`${newest} · 2 elements · 1 edges`);
  await expect(page.locator(".arch-summary")).toContainText("2 changed symbols, 1 impacted");

  // Choosing another commit re-reads it: the header names the commit it read.
  const previous = await page.locator(".arch-header").innerText();
  await page.locator(".impact-commit").nth(1).click();
  await expect(page.locator(".impact-commit[aria-current='true']")).toContainText("feat: add the store");
  await expect(page.locator(".arch-header")).not.toHaveText(previous);
  expect(projected).toHaveLength(2);

  // Search narrows the chooser.
  await page.getByLabel("Filter subject, hash, or author").fill("read two");
  await expect(page.locator(".impact-commit")).toHaveCount(1);
  await page.getByLabel("Filter subject, hash, or author").fill("");

  // The wait is on the render, not on a duration: the element card only exists
  // after the projection has been drawn.
  await expect(page.locator(".arch-elements .arch-box").first()).toBeVisible();
  await page.locator(".arch-elements .arch-box").first().click({ force: true });
  await expect(page.locator(".arch-popup")).toBeVisible();
  await expect(page.locator(".arch-popup")).toContainText("Store");
  await page.keyboard.press("Escape");
  await expect(page.locator(".arch-popup")).toHaveCount(0);

  // Zoom is a view state, and Fit is how a reader gets back to the whole picture.
  const level = page.locator(".arch-zoom-level");
  const fitted = await level.innerText();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(level).not.toHaveText(fitted);
  await page.getByRole("button", { name: "Fit" }).click();
  await expect(level).toHaveText(fitted);

  // The history workbench no longer carries a projection of its own.
  await page.goto(`${studio.url}/#/commits`);
  await expect(page.locator(".git-history-workbench")).toBeVisible();
  await expect(page.locator(".arch-toggle")).toHaveCount(0);
  await expect(page.locator(".git-detail-pane .arch-pane")).toHaveCount(0);
});

test("stacks the chooser over the projection when narrow", async ({ page }) => {
  // The suite's own viewport is the narrow one this contract is about.
  await page.goto(`${studio.url}/#/impact`);
  await expect(page.locator(".impact-view")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector(".impact-view")).gridTemplateRows.split(" ").length > 1)).toBe(true);
});
