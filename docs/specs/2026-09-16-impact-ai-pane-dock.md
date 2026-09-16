# Dock the AI model-generation conversation beside the Impact projection

## Traceability

- Spec ID: 2026-09-16-impact-ai-pane-dock
- Status: Implemented (2026-09-16)

## Intent

The Impact pane's `Generate with AI` entry opened its conversation as a bounded
strip *inside* the projection, under the toolbar (`max-height: 46%`). Memory's
equivalent entry (`AI Analysis`) opens a conversation pane of its own on the right,
which reads as one reading beside another rather than as a disclosure of the
diagram. Make Impact agree: the same conversation surface (`AcpSessionStream
compact`) docks in a right-hand pane, the shell's own resize sash separates it from
the projection, and the surface's own width decides which reading yields first.

## Acceptance scenarios

- AC-1 Opening: activating `Generate with AI` puts the conversation pane in the
  surface's last column, beside the projection rather than over it; the trigger
  reports `aria-expanded="true"` and `aria-controls="impact-agent-panel"`.
- AC-2 Width: the divider is the shell's `studio-pane-sash` — draggable,
  keyboard-operable (arrows 8px, Shift 32px, Home/End to the bounds, double click
  resets), and the pane is clamped to a floor of 280px and to the width the surface
  can give it without starving the projection.
- AC-3 Yielding: below a 1000px surface the commit chooser steps aside; below 760px
  the pane holds the surface. No width overflows the page, and the visible columns
  partition the surface exactly.
- AC-4 Closing: closing returns the chooser and the diagram, and focus lands on the
  trigger that opened the pane.

## Non-goals

- No change to `AcpSessionStream`, the ACP protocol, or run state.
- No persisted pane width. DESIGN.md allows persisting a user-adjusted size only
  once the layout is stable at wide, compact, and narrow widths.
- No change to the projection, the model generator, or the architecture host
  contract.

## Plan

1. `ImpactView` owns the pane: open state, width, a measured frame, the `PaneSash`,
   and the `.impact-agent-slot` the panel renders into. Closing restores focus to the
   trigger.
2. `ArchitectureImpactView`'s toolbar button becomes controlled (`agentTrigger` ref
   plus `aria-expanded` / `aria-controls`), and its inline panel render is removed.
3. `workbench.css`: `has-agent` / `agent-compact` / `agent-narrow` layout rules with
   explicit grid placement (hiding a column must not slide the divider into it), and
   `.arch-agent-panel` restyled from an inline strip to a right-hand pane whose
   transcript scrolls inside it.
4. i18n: `panes.resizeImpactAgent` added to both `en` and `zh-CN`.

## Test evidence

- `packages/harness-studio/test/browser/impact.spec.mjs`, two new cases: the pane
  docks beside the projection, resizes from the keyboard, and returns focus on
  close; and at six widths the pane stays readable (never a sliver, never wider than
  the surface, columns summing to the surface), with the narrowest width holding the
  pane alone and handing the diagram back on close.
- `npx playwright test test/browser/impact.spec.mjs` — 8 passed.
- `npx playwright test` (harness-studio) — 125 passed.
- `npx vitest run` in `packages/harness-studio` — 728 passed; `tsc --noEmit` clean.
- Screenshots at wide, compact, and narrow in both themes (dark/light), with no
  console or page errors and no horizontal overflow.

## Risks

- In the compact band the chooser yields while the pane is open, so a reader cannot
  switch commits without closing it. This is the same trade-off Memory makes when it
  hides the explorer beside the analysis pane.
- The run outlives the commit it was started for: the pane belongs to the surface, so
  switching commits does not cancel an in-flight session.
