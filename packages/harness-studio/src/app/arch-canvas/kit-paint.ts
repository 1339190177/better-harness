/**
 * The paint the canvas draws with, resolved from the stylesheet rather than
 * restated in JavaScript.
 *
 * The SVG diagram's colours live in `workbench.css` and are declared against the
 * shared semantic tokens, including `color-mix` for the state fills. The canvas
 * reads the same rules through a hidden probe element, so a token or state
 * colour changes in one place and both renderers follow — no second copy of the
 * mix arithmetic to drift.
 */
import type { ArchState } from "./diagram-model.js";

/** Channels are 0-255; alpha is 0-1. */
export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface ShapePaint {
  fill: RGBA;
  stroke: RGBA;
  width: number;
  dash: number[];
}

export interface KitPaint {
  boundary: Record<ArchState, ShapePaint>;
  leaf: Record<ArchState, ShapePaint>;
  /** The ring a selected node draws instead: the focus colour, thicker. */
  selected: { stroke: RGBA; width: number };
  edge: { declared: { stroke: RGBA; width: number; dash: number[] }; observed: { stroke: RGBA; width: number; dash: number[] } };
  arrow: { declared: RGBA; observed: RGBA };
}

const TRANSPARENT: RGBA = { r: 0, g: 0, b: 0, a: 0 };
const FALLBACK: RGBA = { r: 128, g: 128, b: 128, a: 1 };

function channel(value: string): number {
  const percent = value.endsWith("%");
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(255, Math.round(percent ? (number / 100) * 255 : number)));
}

function alpha(value: string | undefined): number {
  if (value === undefined) return 1;
  const percent = value.endsWith("%");
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return 1;
  return Math.max(0, Math.min(1, percent ? number / 100 : number));
}

/**
 * A computed colour as the four channels the canvas needs.
 *
 * A browser answering `getComputedStyle` for a token gives `#rrggbb`, `rgb()`,
 * `rgba()`, and — for a `color-mix` result — `color(srgb r g b / a)` with
 * channels in 0-1. All three are read; anything else is drawn grey rather than
 * dropped, so a colour this parser does not know is visible, not silent.
 */
export function parseColor(value: string): RGBA {
  const text = value.trim().toLowerCase();
  if (text === "" || text === "none" || text === "transparent") return TRANSPARENT;
  if (text.startsWith("#")) {
    const hex = text.slice(1);
    if (hex.length === 3) return { r: channel(String(parseInt(hex[0]! + hex[0]!, 16))), g: channel(String(parseInt(hex[1]! + hex[1]!, 16))), b: channel(String(parseInt(hex[2]! + hex[2]!, 16))), a: 1 };
    if (hex.length >= 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16),
        a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
      };
    }
    return FALLBACK;
  }
  // `color(srgb 1 0.57 0.6 / 0.08)` — the shape a resolved color-mix takes.
  const srgb = /^color\(\s*srgb\s+([^)]+)\)$/.exec(text);
  if (srgb !== null) {
    const [channels, opacity] = srgb[1]!.split("/");
    const parts = channels!.trim().split(/\s+/);
    if (parts.length < 3) return FALLBACK;
    // These channels are 0-1, so they are scaled rather than rounded.
    const scaled = (raw: string): number => {
      const percent = raw.endsWith("%");
      const number = Number.parseFloat(raw);
      if (!Number.isFinite(number)) return 0;
      return Math.max(0, Math.min(255, Math.round((percent ? number / 100 : number) * 255)));
    };
    return { r: scaled(parts[0]!), g: scaled(parts[1]!), b: scaled(parts[2]!), a: alpha(opacity?.trim()) };
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(text);
  if (rgb !== null) {
    const [channels, opacity] = rgb[1]!.split("/");
    const parts = channels!.trim().split(/[\s,]+/);
    if (parts.length < 3) return FALLBACK;
    return { r: channel(parts[0]!), g: channel(parts[1]!), b: channel(parts[2]!), a: alpha(parts[3] ?? opacity?.trim()) };
  }
  return FALLBACK;
}

/** `4px, 3px` from the stylesheet, as the points the canvas dashes at. */
export function parseDash(value: string): number[] {
  const text = value.trim().toLowerCase();
  if (text === "" || text === "none") return [];
  const parts = text.split(/[\s,]+/).map((part) => Number.parseFloat(part)).filter((number) => Number.isFinite(number) && number >= 0);
  return parts.length === 0 || parts.every((number) => number === 0) ? [] : parts;
}

const STATES: ArchState[] = ["changed", "impacted", "observed", "untouched"];

const PROBE_STYLE = "position:absolute;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none";

/**
 * Resolves every colour the canvas draws with, by asking the browser what the
 * pane's own rules compute to for a probe element of each role.
 *
 * The probe is attached to the document rather than to the pane: the state rules
 * are global and the tokens live on the root, so the probe needs no host — and
 * waiting for the pane's own ref would mean waiting for a ref React attaches
 * after this component's layout effect has already run.
 */
export function readKitPaint(): KitPaint {
  const probe = document.createElement("div");
  probe.setAttribute("style", PROBE_STYLE);
  probe.setAttribute("aria-hidden", "true");
  /**
   * One shape of a role in a state. The state is the shape's parent, because the
   * stylesheet reaches it with a descendant selector — `.arch-box-changed
   * .arch-box` — so both classes on one element would only ever read the base.
   */
  const shape = (role: string, ...ancestors: string[]): ShapePaint => {
    const group = document.createElement("div");
    group.className = ancestors.join(" ");
    probe.appendChild(group);
    const node = document.createElement("div");
    node.className = role;
    group.appendChild(node);
    const style = getComputedStyle(node);
    return {
      fill: parseColor(style.getPropertyValue("fill") || style.fill),
      stroke: parseColor(style.getPropertyValue("stroke") || style.stroke),
      width: Number.parseFloat(style.getPropertyValue("stroke-width")) || 1,
      dash: parseDash(style.getPropertyValue("stroke-dasharray")),
    };
  };
  const edgeStyle = (...ancestors: string[]): { stroke: RGBA; width: number; dash: number[] } => {
    const shapePaint = shape("", ...ancestors);
    return { stroke: shapePaint.stroke, width: shapePaint.width, dash: shapePaint.dash };
  };
  document.body.appendChild(probe);
  try {
    const byState = (role: "arch-boundary" | "arch-box"): Record<ArchState, ShapePaint> => {
      const entries = STATES.map((state) => [state, shape(role, `arch-box-${state}`)] as const);
      return Object.fromEntries(entries) as Record<ArchState, ShapePaint>;
    };
    // A selected node keeps its state fill and takes the focus ring.
    const selected = shape("arch-box", "arch-selected", "arch-box-changed");
    const declared = edgeStyle("arch-edge-declared");
    const observed = edgeStyle("arch-edge-observed");
    const declaredArrow = shape("", "arch-arrow-declared");
    const observedArrow = shape("", "arch-arrow-observed");
    return {
      boundary: byState("arch-boundary"),
      leaf: byState("arch-box"),
      selected: { stroke: selected.stroke, width: selected.width },
      edge: { declared, observed },
      arrow: { declared: declaredArrow.fill, observed: observedArrow.fill },
    };
  } finally {
    probe.remove();
  }
}
