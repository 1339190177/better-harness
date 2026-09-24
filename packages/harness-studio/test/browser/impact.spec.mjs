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
/** The changed path in a language the host cannot extract, long enough to matter. */
const unread = "tools/archprobe/AnalysisProbeTargetWithARemarkablyLongUnbrokenName.go";
/** A changed document, which the projection is not about. */
const documentPath = "docs/specs/2026-09-14-commit-architecture-impact.md";
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
  // The same commit moves code this projection cannot extract and a document it is
  // not about, so the surface has both kinds of file in front of it.
  await mkdir(join(workspace, "tools", "archprobe"), { recursive: true });
  await mkdir(join(workspace, "docs", "specs"), { recursive: true });
  await writeFile(join(workspace, unread), "package main\n", "utf8");
  await writeFile(join(workspace, documentPath), "# Impact\n", "utf8");
  git("add", "store/index.ts", unread, documentPath);
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
          // What the host answers: the Go file it was handed and could not read,
          // and a document it was never handed at all. The first is a named gap
          // in the projection, the second is not part of the reading.
          skipped: [
            { path: unread, diagnostics: [`unsupported language for ${unread}`] },
            { path: documentPath, diagnostics: [`unsupported language for ${documentPath}`] },
          ],
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
  // after the projection has been drawn. The diagram is Skia's once the runtime
  // arrives, and a canvas has no nodes to click — so the pointer is placed over
  // the element's own label, which is DOM text laid out where the node was drawn.
  await expect(page.locator(".arch-kit-canvas")).toBeVisible();
  const storeLabel = page.locator(".arch-kit-label.arch-kit-leaf-name", { hasText: "Store" });
  await expect(storeLabel).toBeVisible();
  const storeBox = await storeLabel.boundingBox();
  await page.mouse.click(storeBox.x + storeBox.width / 2, storeBox.y + storeBox.height / 2);
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

/**
 * The canvas is a faster renderer, not a required one: a browser that cannot
 * load the Skia runtime still reads the same diagram, drawn as SVG.
 */
test("draws the diagram as SVG when the Skia runtime cannot load", async ({ page }) => {
  await page.route("**/canvaskit.wasm", (route) => route.abort());
  await page.goto(`${studio.url}/#/impact`);
  await expect(page.locator(".arch-canvas")).toBeVisible();
  await expect(page.locator(".arch-kit-canvas")).toHaveCount(0);

  await expect(page.locator(".arch-elements .arch-box").first()).toBeVisible();
  await expect(page.locator(".arch-elements .arch-box")).toHaveCount(2);
  await page.locator(".arch-elements .arch-box").first().click({ force: true });
  await expect(page.locator(".arch-popup")).toBeVisible();
  await expect(page.locator(".arch-popup")).toContainText("Store");

  // The viewport still works: zoom reads out and Fit restores the whole picture.
  const level = page.locator(".arch-zoom-level");
  const fitted = await level.innerText();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(level).not.toHaveText(fitted);
  await page.getByRole("button", { name: "Fit" }).click();
  await expect(level).toHaveText(fitted);
});

test("stacks the chooser over the projection when narrow", async ({ page }) => {
  // The suite's own viewport is the narrow one this contract is about.
  await page.goto(`${studio.url}/#/impact`);
  await expect(page.locator(".impact-view")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector(".impact-view")).gridTemplateRows.split(" ").length > 1)).toBe(true);
});

/**
 * A window can be wide or narrow, and a docked sidebar decides what the surface
 * actually gets. Neither may leave the projection starved or the diagram
 * shrunk past reading: the chooser yields width first, the columns partition the
 * surface exactly, and the fit stops at a legible scale rather than shrinking
 * into a thumbnail.
 */
test("keeps the projection readable at every width the surface can take", async ({ page }) => {
  const measured = [];
  for (const width of [1600, 1280, 1100, 900, 760, 600, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${studio.url}/#/impact`);
    await expect(page.locator(".arch-canvas")).toBeVisible();
    measured.push(await page.evaluate(() => {
      const width = (selector) => Math.round(document.querySelector(selector)?.getBoundingClientRect().width ?? -1);
      const level = document.querySelector(".arch-zoom-level")?.textContent ?? "";
      return {
        surface: width(".impact-view"),
        picker: width(".impact-picker"),
        projection: width(".impact-projection"),
        pane: width(".arch-pane"),
        zoom: Number.parseInt(level, 10),
        pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
      };
    }));
  }

  for (const row of measured) {
    expect(row.pageOverflow, `page overflow at ${row.surface}px`).toBe(false);
    // The chooser yields width before the projection does: side by side the two
    // columns are the whole surface, and stacked each takes all of it — the
    // surface is never left with dead width beside a starved pane.
    if (row.picker === row.surface) expect(row.projection, `stacked at ${row.surface}px`).toBe(row.surface);
    else expect(row.picker + row.projection, `columns at ${row.surface}px`).toBe(row.surface);
    expect(row.pane, `projection at ${row.surface}px`).toBe(row.projection);
    // A fit below this is a thumbnail; the pane pans a legible picture instead.
    expect(row.zoom, `zoom at ${row.surface}px`).toBeGreaterThanOrEqual(50);
  }
});

/**
 * The generation pane is a reading of its own rather than a strip inside the
 * projection: it opens as a column beside the diagram, is resized by the shell's
 * own divider, and hands the surface — and focus — back when it closes.
 */
test("docks the AI model pane beside the projection and returns focus when it closes", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`${studio.url}/#/impact`);
  await expect(page.locator(".arch-canvas")).toBeVisible();

  const trigger = page.getByRole("button", { name: "Generate with AI" });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");

  const pane = page.locator("#impact-agent-panel .arch-agent-panel");
  await expect(pane).toBeVisible();
  const [paneBox, projectionBox] = await Promise.all([
    pane.boundingBox(),
    page.locator(".impact-projection").boundingBox(),
  ]);
  // Beside, not over: the pane's column starts where the projection's ends.
  expect(paneBox.x).toBeGreaterThanOrEqual(projectionBox.x + projectionBox.width - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // The divider it shares with the projection is keyboard operable, and growing the
  // pane is the arrow that points at the edge it is docked to.
  const sash = page.getByRole("separator", { name: "Resize the AI model pane" });
  await expect(sash).toBeVisible();
  const docked = Math.round(paneBox.width);
  await sash.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => Math.round((await pane.boundingBox()).width)).toBeGreaterThan(docked);

  await page.getByRole("button", { name: "Close AI generation" }).click();
  await expect(page.locator("#impact-agent-panel")).toHaveCount(0);
  // The chooser comes back, and the reader is where they left off.
  await expect(page.locator(".impact-picker")).toBeVisible();
  await expect(trigger).toBeFocused();
});

/**
 * The generation pane competes with the readings the surface already had, so it
 * only exists at widths that can hold it: the chooser yields, then the diagram,
 * and neither leaves the pane a sliver or the surface overflowing.
 */
test("keeps the generation pane readable at every width the surface can take", async ({ page }) => {
  const measured = [];
  for (const width of [1600, 1100, 900, 760, 600, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${studio.url}/#/impact`);
    await expect(page.locator(".impact-view")).toBeVisible();
    // A fragment navigation does not reload the app, so the pane opened at the
    // first width stays open for the rest: every width is measured with it open.
    // Its state is read by attribute: a role locator loses the trigger at the
    // widths where the projection it sits in steps aside.
    const trigger = page.locator(".arch-btn[aria-expanded]");
    if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
    await expect(page.locator("#impact-agent-panel .arch-agent-panel")).toBeVisible();
    measured.push(await page.evaluate(() => {
      const box = (selector) => {
        const element = document.querySelector(selector);
        const rect = element?.getBoundingClientRect();
        return { width: Math.round(rect?.width ?? -1), shown: element !== null && element.getClientRects().length > 0 };
      };
      return {
        surface: box(".impact-view").width,
        picker: box(".impact-picker"),
        projection: box(".impact-projection"),
        sash: box(".impact-view > .studio-pane-sash"),
        pane: box(".arch-agent-panel"),
        pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
      };
    }));
  }

  for (const row of measured) {
    expect(row.pageOverflow, `page overflow at ${row.surface}px`).toBe(false);
    // The pane is never a sliver, and it never grows past the surface it docks in.
    expect(row.pane.width, `pane at ${row.surface}px`).toBeGreaterThanOrEqual(280);
    expect(row.pane.width, `pane at ${row.surface}px`).toBeLessThanOrEqual(row.surface);
    // The diagram yields to the pane: it is withdrawn only where the pane holds the
    // whole surface, never left beside it as a sliver.
    if (!row.projection.shown) expect(row.pane.width, `pane holds ${row.surface}px`).toBe(row.surface);
    // The visible columns partition the surface exactly, so none is starved and none overlaps.
    const columns = (row.picker.shown ? row.picker.width : 0) + (row.projection.shown ? row.projection.width : 0)
      + (row.sash.shown ? row.sash.width : 0) + row.pane.width;
    expect(columns, `columns at ${row.surface}px`).toBe(row.surface);
  }

  // The widest surface holds all three readings; the narrowest holds the one the
  // run writes for, because its model is what the commit projects onto next.
  expect(measured[0].picker.shown, "chooser at the widest surface").toBe(true);
  expect(measured[0].projection.shown, "diagram at the widest surface").toBe(true);
  const narrowest = measured.at(-1);
  expect(narrowest.projection.shown).toBe(false);
  expect(narrowest.pane.width).toBe(narrowest.surface);

  // Closing there brings the diagram back — and the reader with it, rather than
  // dropping focus on a pane that no longer exists.
  await page.getByRole("button", { name: "Close AI generation" }).click();
  await expect(page.locator(".arch-canvas")).toBeVisible();
  await expect(page.locator(".arch-btn[aria-expanded]")).toBeFocused();
});

/**
 * The notice is the one place a reading admits what it could not read, and it
 * prints a path the surface does not control: a document is not part of the
 * reading at all, and a path that does not fit is clipped inside the pane it sits
 * in — with the whole of it in the tooltip — rather than widening the surface it
 * is the caveat to.
 */
test("names the code it could not read, never the documents, inside the pane it has", async ({ page }) => {
  const measured = [];
  for (const width of [1280, 900, 600]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${studio.url}/#/impact`);
    await expect(page.locator(".arch-canvas")).toBeVisible();
    await expect(page.locator(".arch-omitted")).toHaveCount(1);
    measured.push(await page.evaluate(() => {
      const box = (selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { right: Math.round(rect.right), width: Math.round(rect.width), height: Math.round(rect.height) };
      };
      const notice = document.querySelector(".arch-omitted");
      const level = document.querySelector(".arch-zoom-level")?.textContent ?? "";
      return {
        width: window.innerWidth,
        pane: box(".arch-pane"),
        notice: box(".arch-omitted"),
        // Clipped means the path is cut off in the pane rather than fitted into it.
        clipped: notice.scrollWidth > notice.clientWidth,
        // One line means the notice never grows into the canvas's height either.
        oneLine: notice.scrollHeight <= notice.clientHeight + 1,
        text: notice.textContent,
        title: notice.getAttribute("title"),
        zoom: Number.parseInt(level, 10),
        pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
      };
    }));
  }

  const [widest] = measured;
  expect(widest.text).toContain(unread);
  expect(widest.text).not.toContain(".md");
  expect(widest.title).toContain(unread);
  expect(widest.title).toContain("a language the host does not extract");

  for (const row of measured) {
    expect(row.pageOverflow, `page overflow at ${row.width}px`).toBe(false);
    expect(row.notice.right, `notice inside its pane at ${row.width}px`).toBeLessThanOrEqual(row.pane.right + 1);
    expect(row.notice.width, `notice width at ${row.width}px`).toBeLessThanOrEqual(row.pane.width);
    expect(row.oneLine, `notice on one line at ${row.width}px`).toBe(true);
    // The toolbar wrapping round a long notice may not eat the diagram.
    expect(row.zoom, `zoom at ${row.width}px`).toBeGreaterThanOrEqual(50);
  }
  // In the narrowest pane the path cannot fit, and it is the notice that gives way.
  expect(measured.at(-1).clipped).toBe(true);
});

/**
 * A reading that marks nothing is not the same as a commit that changed nothing:
 * the pane names the files the commit did change, the standing the reading gave
 * each, and the element a binding maps it onto — so "which module changed" is
 * answerable from the list and not only from the diagram.
 */
test("lists the commit's changed files with the standing each had in the reading", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${studio.url}/#/impact`);
  await expect(page.locator(".arch-canvas")).toBeVisible();

  await expect(page.locator(".arch-file")).toHaveCount(3);
  await expect(page.locator(".arch-files-count")).toContainText("3 files · 1 in projection");

  // Code the projection holds names the element it belongs to.
  const held = page.locator(".arch-file", { hasText: "store/index.ts" });
  await expect(held).toContainText("in projection");
  await expect(held).toContainText("Store");
  await expect(held).toHaveAttribute("data-standing", "projected");

  // A document is not a gap in the reading: it is out of the projection's scope,
  // and the pane says that rather than leaving the commit unexplained.
  const document = page.locator(".arch-file", { hasText: documentPath });
  await expect(document).toContainText("not source");
  await expect(document).toHaveAttribute("data-standing", "out-of-scope");

  // Code in a language the host does not extract is a named gap in it.
  const unreadable = page.locator(".arch-file", { hasText: unread });
  await expect(unreadable).toContainText("language not extracted");
  await expect(unreadable).toHaveAttribute("data-standing", "unread");
});

/**
 * The list is a pane of its own: bounded, self-scrolling, clipped rather than
 * widening the surface, and collapsible so a reader who wants the whole diagram
 * can have it back.
 */
test("keeps the changed-file pane bounded at every width the surface can take", async ({ page }) => {
  const measured = [];
  for (const width of [1600, 1280, 900, 600]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${studio.url}/#/impact`);
    await expect(page.locator(".arch-file-list")).toBeVisible();
    measured.push(await page.evaluate(() => {
      const box = (selector) => {
        const rect = document.querySelector(selector)?.getBoundingClientRect();
        return { right: Math.round(rect?.right ?? -1), width: Math.round(rect?.width ?? -1) };
      };
      const level = document.querySelector(".arch-zoom-level")?.textContent ?? "";
      return {
        width: window.innerWidth,
        pane: box(".arch-pane"),
        files: box(".arch-files"),
        zoom: Number.parseInt(level, 10),
        pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
      };
    }));
  }

  for (const row of measured) {
    expect(row.pageOverflow, `page overflow at ${row.width}px`).toBe(false);
    // Clipped inside the pane it sits in, and never wider than it.
    expect(row.files.right, `file list inside its pane at ${row.width}px`).toBeLessThanOrEqual(row.pane.right + 1);
    expect(row.files.width, `file list width at ${row.width}px`).toBeLessThanOrEqual(row.pane.width);
    // A bounded list leaves the diagram a readable share of the pane.
    expect(row.zoom, `zoom at ${row.width}px`).toBeGreaterThanOrEqual(50);
  }

  // Collapsing hands the height back to the diagram, and the control says which
  // state it is in rather than relying on the caret alone.
  const toggle = page.getByRole("button", { name: "Changed files" });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const folded = await page.locator(".arch-zoom-level").innerText();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".arch-file-list")).toHaveCount(0);
  expect(Number.parseInt(await page.locator(".arch-zoom-level").innerText(), 10))
    .toBeGreaterThanOrEqual(Number.parseInt(folded, 10));
});
