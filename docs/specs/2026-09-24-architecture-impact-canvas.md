# Canvas rendering for the architecture impact diagram

## Traceability

- Spec ID: architecture-impact-canvas
- Status: Implemented

## Intent

The Impact pane draws a commit projected onto its declared architecture. It draws
that diagram with SVG, and the reader has to pan and zoom a DOM tree to read it.
This change draws the diagram with `canvaskit-wasm` (Skia compiled to WebAssembly,
presented on a WebGL surface) so the viewport is a GPU-composited picture rather
than a re-rasterised DOM tree, and keeps the existing SVG diagram as the fallback
when the wasm or WebGL is unavailable.

Labels are deliberately not drawn by Skia. `canvaskit-wasm` exposes
`FontMgr.FromData` but no system font manager (`FontMgr.System` is undefined), and
this app ships no font files — `--font-ui` is the platform's own stack. Drawing
text through Skia would therefore need a bundled font, which cannot cover the
model names a bilingual project authors. Labels are instead laid out in diagram
space and painted by a DOM overlay that uses the app's own font stack, so they stay
crisp at every zoom and correct for non-Latin names without shipping a font.

## Acceptance Scenarios

- AC-1: When `canvaskit.wasm` loads and a WebGL surface is created, the pane draws
  the diagram into a canvas inside `.arch-canvas`, and a pan or a zoom updates the
  viewport without rebuilding the drawn nodes or re-laying the model out.
- AC-2: When the wasm cannot load or no WebGL surface can be created, the pane
  draws the existing SVG diagram instead, with the same elements, edges and states.
- AC-3: Clicking a node selects it and opens the element card; a drag never
  selects; Escape clears both the selection and the viewport.
- AC-4: Zoom is read out in the toolbar and Fit returns to the whole picture; the
  diagram opens at a legible scale rather than as a thumbnail.
- AC-5: Labels use the app's own font and remain legible at every zoom, including
  non-Latin element names.
- AC-6: Loading, drawing, panning, zooming and unloading the pane produce no
  console or page errors, and the pane releases the surface and the wasm objects
  it allocated.

## Non-goals

- `Export .svg` and the DOM-clone export it needs. The reader does not need an
  exported diagram, and a canvas has no DOM to clone; the button and its code are
  removed. This supersedes the export paragraph of
  `docs/specs/2026-09-14-commit-architecture-impact.md`.
- Keyboard and screen-reader access to diagram nodes. The canvas path is pointer
  only; the SVG fallback keeps whatever it already had.
- Changing the reading, the layout, the route, the toolbar's other actions, or
  `Export .dsl` (a model text export, unrelated to the renderer).

## Plan and Tasks

Affected modules:

- `packages/harness-studio/src/app/arch-canvas/kit-loader.ts` — loads the runtime
  once per page. The package's glue is a classic script that publishes its
  initializer as a global and finds its wasm beside itself, so both are served
  from the app's assets rather than bundled — the glue carries Node-only branches
  a browser bundle cannot resolve. A failed load is remembered so the pane falls
  back once rather than retrying every render.
- `packages/harness-studio/src/app/arch-canvas/kit-paint.ts` — resolves the paint
  by asking the browser what the pane's own rules compute to, for a probe element
  of each role and state. The state is the probe's parent, because the stylesheet
  reaches the shape with a descendant selector.
- `packages/harness-studio/src/app/arch-canvas/diagram-model.ts` — the reading as
  a laid-out picture: the tree, the edges, hit testing, label placement and the
  legend, all pure so the geometry is testable without a GPU and both renderers
  draw one picture rather than two that drift.
- `packages/harness-studio/src/app/arch-canvas/kit-draw.ts` — the painting order:
  boundaries, edges with arrow heads, leaves, then the legend.
- `packages/harness-studio/src/app/arch-canvas/KitSurface.tsx` — the canvas
  component: surface lifecycle, resize and theme observation, the DOM label
  overlay, and teardown. Pointer pan, wheel zoom and click selection stay in the
  pane, which owns the gesture for both renderers.
- `packages/harness-studio/src/app/ArchitectureImpactView.tsx` — choose the canvas
  renderer when it is available and render the SVG diagram otherwise; remove the
  SVG export button and its helpers.
- `packages/harness-studio/scripts/app-build.mjs` — copy
  `node_modules/canvaskit-wasm/bin/canvaskit.{js,wasm}` into `dist/app/assets`.
- `packages/harness-studio/src/server/http-utils.ts` — serve `.wasm` as
  `application/wasm`, so the runtime streams instead of arriving as an opaque
  download.
- `packages/harness-studio/src/app/styles/workbench.css` — the canvas and label
  overlay classes, mapped to the existing semantic tokens.

Tasks:

1. Add `canvaskit-wasm` and serve its wasm from the app assets.
2. Build the plan/hit helpers and cover them with unit tests.
3. Build the canvas component and the label overlay.
4. Integrate with the fallback and drop the export path.
5. Re-point the browser spec at behaviour that survives both renderers.

Decision rationale: the canvas is the pane's own surface, not the desktop native
chart host, because Studio is served to plain browsers — a Rust/wgpu host cannot
draw into a browser page. Text stays DOM because CanvasKit cannot reach a system
font here.

## Test and Review Evidence

Recorded from a local run.

- Unit — `npx vitest run test/arch-canvas-model.test.ts test/arch-canvas-paint.test.ts`:
  15 tests over the layout, edge resolution, state ranking, hit testing, label and
  legend placement, and the computed-colour parser (AC-1, AC-3, AC-5).
- Package suite — `npx vitest run`: 99 files, 824 tests pass.
- Types — `npx tsc --noEmit` passes.
- Browser — `npx playwright test test/browser/impact.spec.mjs`: 9 tests pass. The
  first draws with Skia (`.arch-kit-canvas`), clicks an element by its label to
  open the card, closes it with Escape, and reads zoom/Fit out; the fallback test
  blocks `canvaskit.wasm` and gets the SVG diagram, still clickable, with zoom and
  Fit intact (AC-1, AC-2, AC-3, AC-4, AC-6).
- At scale — a 53-element / 72-edge model drew 124 labels, 5 boundaries and a
  904×673 canvas, panned 30 steps in ~0.3 s, zoomed 74% → 92%, and reported no
  console or page errors. Screenshots at wide, compact and narrow widths confirmed
  the state colours, dashed observed edges, arrow heads and legend match the SVG
  diagram (AC-5, AC-6).
- Risk observed while verifying: two silent-failure modes were found and fixed —
  a parent ref read from a child's layout effect (React attaches it later, so the
  canvas never sized), and a style probe that put the state and role classes on
  one element and so missed the descendant rules (every state drew identically).
  Both are covered by the screenshot and fallback assertions above.
