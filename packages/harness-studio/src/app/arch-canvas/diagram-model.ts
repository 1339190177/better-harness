/**
 * The Impact diagram as a model: a reading becomes a laid-out picture, and the
 * picture answers what a reader can point at and what each label says.
 *
 * Everything here is pure, so the geometry is testable without a GPU and both
 * renderers — the CanvasKit canvas and the SVG fallback — draw the same picture
 * rather than two that drift.
 */
import type { ArchitectureElement, ArchitectureImpact, ArchitectureRelationship } from "../../contracts/architecture-impact.js";

export interface DiagramBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DiagramNode {
  element: ArchitectureElement;
  children: DiagramNode[];
  box: DiagramBox;
  depth: number;
  changed: boolean;
  observed: boolean;
  impacted: boolean;
  /** Child rows, kept from measurement so placement stays a pure function of it. */
  rows: DiagramNode[][];
}

/** One relationship as the diagram draws it: both ends resolved to boxes. */
export interface DiagramEdge {
  relationship: ArchitectureRelationship;
  observed: boolean;
  from: DiagramNode;
  to: DiagramNode;
}

/** Everything the diagram needs from one reading. */
export interface DiagramLayout {
  diagram: { width: number; height: number };
  boundaries: DiagramNode[];
  leaves: DiagramNode[];
  nodesById: Map<string, DiagramNode>;
  edges: DiagramEdge[];
  names: Map<string, string>;
}

/** Pan and zoom of the viewport, in screen units. */
export interface DiagramView {
  scale: number;
  x: number;
  y: number;
}

/** Which of the three marked states an element is in. */
export type ArchState = "changed" | "impacted" | "observed" | "untouched";

/** A leaf is one drawn element; a boundary is one element that contains others. */
export const LEAF_W = 176;
export const LEAF_H = 54;
export const BOUNDARY_HEADER = 22;
export const BOUNDARY_PAD = 12;
export const SIBLING_GAP = 16;
export const ROOT_GAP = 28;
export const MARGIN = 16;
/** A boundary wraps its children rather than growing without limit. Wide enough
 * that two containers sit side by side, tall enough that a nested box reads. */
export const MAX_ROW_W = 1180;
export const ZOOM_STEP = 1.25;
export const MAX_SCALE = 4;
export const MIN_SCALE = 0.15;
/**
 * A fit below this is a thumbnail, not a diagram: the pane shows the corner of
 * the picture at a legible scale and the reader pans, instead of shrinking a
 * model until its labels cannot be read.
 */
export const MIN_LEGIBLE_SCALE = 0.5;

/**
 * Everything one drawing needs from one reading, computed once.
 *
 * The tree is laid out, flattened and indexed here rather than in a render
 * body, so a viewport gesture moves the picture instead of rebuilding it.
 */
export function buildLayout(data: ArchitectureImpact): DiagramLayout {
  const roots = buildTree(data);
  const nodes = flatten(roots);
  const nodesById = new Map(nodes.map((node) => [node.element.id, node]));
  const edges = [
    ...data.relationships.map((relationship) => ({ relationship, observed: false })),
    ...data.observedEdges.map((relationship) => ({ relationship, observed: true })),
  ].flatMap(({ relationship, observed }): DiagramEdge[] => {
    const from = nodesById.get(relationship.sourceId);
    const to = nodesById.get(relationship.targetId);
    // An edge to an element this commit's model does not contain is dropped
    // rather than drawn to nowhere; the element list is the reading's own.
    return from === undefined || to === undefined || from === to ? [] : [{ relationship, observed, from, to }];
  });
  return {
    diagram: layOut(roots),
    boundaries: nodes.filter((node) => node.children.length > 0),
    leaves: nodes.filter((node) => node.children.length === 0),
    nodesById,
    edges,
    /** Element names, so a file row names the boundary it belongs to. */
    names: new Map(data.elements.map((element) => [element.id, element.name])),
  };
}

/** Build the declared hierarchy, treating anything unparented as a root. */
function buildTree(data: ArchitectureImpact): DiagramNode[] {
  const changed = new Set(data.changedHitIds);
  const observed = new Set(data.codeHitIds);
  const impacted = new Set(data.impactedHitIds);
  const known = new Set(data.elements.map((element) => element.id));
  const childrenOf = new Map<string, ArchitectureElement[]>();
  const roots: ArchitectureElement[] = [];
  for (const element of data.elements) {
    // A parent the model does not define would hide the element entirely, so it
    // becomes a root instead: a drawn child beats an invisible one.
    if (element.parentId !== undefined && element.parentId !== element.id && known.has(element.parentId)) {
      childrenOf.set(element.parentId, [...(childrenOf.get(element.parentId) ?? []), element]);
    } else {
      roots.push(element);
    }
  }
  const build = (element: ArchitectureElement, depth: number, seen: ReadonlySet<string>): DiagramNode => {
    const node: DiagramNode = {
      element,
      children: [],
      box: { x: 0, y: 0, w: 0, h: 0 },
      depth,
      changed: changed.has(element.id),
      observed: observed.has(element.id),
      impacted: impacted.has(element.id),
      rows: [],
    };
    if (seen.has(element.id)) return node;
    const next = new Set([...seen, element.id]);
    node.children = (childrenOf.get(element.id) ?? []).map((child) => build(child, depth + 1, next));
    return node;
  };
  return roots.map((root) => build(root, 0, new Set()));
}

/** Size every node bottom-up, wrapping a boundary's children into rows. */
function measure(node: DiagramNode): void {
  if (node.children.length === 0) {
    node.box.w = LEAF_W;
    node.box.h = LEAF_H;
    return;
  }
  for (const child of node.children) measure(child);
  const rows: DiagramNode[][] = [];
  let row: DiagramNode[] = [];
  let rowWidth = 0;
  for (const child of node.children) {
    const step = child.box.w + (row.length === 0 ? 0 : SIBLING_GAP);
    if (row.length > 0 && rowWidth + step > MAX_ROW_W) {
      rows.push(row);
      row = [];
      rowWidth = 0;
    }
    rowWidth += child.box.w + (row.length === 0 ? 0 : SIBLING_GAP);
    row.push(child);
  }
  rows.push(row);
  node.rows = rows;
  const widest = Math.max(...rows.map((entry) => rowWidthOf(entry)));
  const tallest = rows.reduce((sum, entry) => sum + Math.max(...entry.map((child) => child.box.h)), 0);
  node.box.w = Math.max(widest, LEAF_W) + BOUNDARY_PAD * 2;
  node.box.h = BOUNDARY_HEADER + BOUNDARY_PAD + tallest + SIBLING_GAP * (rows.length - 1) + BOUNDARY_PAD;
}

/** Place measured nodes: children centred inside their boundary. */
function place(node: DiagramNode, x: number, y: number): void {
  node.box.x = x;
  node.box.y = y;
  let cursorY = y + BOUNDARY_HEADER + BOUNDARY_PAD;
  for (const row of node.rows) {
    const rowHeight = Math.max(...row.map((child) => child.box.h));
    let cursorX = x + (node.box.w - rowWidthOf(row)) / 2;
    for (const child of row) {
      place(child, cursorX, cursorY + (rowHeight - child.box.h));
      cursorX += child.box.w + SIBLING_GAP;
    }
    cursorY += rowHeight + SIBLING_GAP;
  }
}

function rowWidthOf(row: readonly DiagramNode[]): number {
  return row.reduce((sum, child) => sum + child.box.w, 0) + SIBLING_GAP * Math.max(0, row.length - 1);
}

function layOut(roots: readonly DiagramNode[]): { width: number; height: number } {
  for (const root of roots) measure(root);
  let cursorY = MARGIN;
  let widest = 0;
  for (const root of roots) {
    place(root, MARGIN, cursorY);
    cursorY += root.box.h + ROOT_GAP;
    widest = Math.max(widest, root.box.w);
  }
  // Room for the legend, which states what the diagram did and did not evaluate.
  return { width: Math.max(widest + MARGIN * 2, 820), height: cursorY - ROOT_GAP + MARGIN + 40 };
}

function flatten(nodes: readonly DiagramNode[]): DiagramNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

export function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

export function fitView(pane: { w: number; h: number }, diagram: { width: number; height: number }): DiagramView {
  if (pane.w === 0 || pane.h === 0 || diagram.width === 0) return { scale: 1, x: 0, y: 0 };
  const wanted = Math.min((pane.w - 8) / diagram.width, (pane.h - 8) / diagram.height, 1.5);
  if (wanted >= MIN_LEGIBLE_SCALE) {
    return { scale: wanted, x: (pane.w - diagram.width * wanted) / 2, y: (pane.h - diagram.height * wanted) / 2 };
  }
  // Anchored at the diagram's own origin, so the picture opens on its roots
  // rather than on whatever happens to sit at its middle.
  return { scale: MIN_LEGIBLE_SCALE, x: 8, y: 8 };
}

/** A box in screen units, for a card anchored to the element it describes. */
export function screenBox(box: DiagramBox, view: DiagramView): DiagramBox {
  return { x: box.x * view.scale + view.x, y: box.y * view.scale + view.y, w: box.w * view.scale, h: box.h * view.scale };
}

/** Where a diagram point sits on screen, and the inverse for a pointer. */
export function toScreen(point: { x: number; y: number }, view: DiagramView): { x: number; y: number } {
  return { x: point.x * view.scale + view.x, y: point.y * view.scale + view.y };
}

export function toDiagram(point: { x: number; y: number }, view: DiagramView): { x: number; y: number } {
  return { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale };
}

/**
 * Where a relationship meets its two boxes.
 *
 * A declared model is not a drawing, so the anchor is chosen from the relative
 * position of the two boxes rather than stored in the model.
 */
export function anchors(from: DiagramBox, to: DiagramBox): [{ x: number; y: number }, { x: number; y: number }] {
  if (from.y + from.h <= to.y + 1) return [{ x: from.x + from.w / 2, y: from.y + from.h }, { x: to.x + to.w / 2, y: to.y }];
  if (to.y + to.h <= from.y + 1) return [{ x: from.x + from.w / 2, y: from.y }, { x: to.x + to.w / 2, y: to.y + to.h }];
  if (from.x + from.w <= to.x + 1) return [{ x: from.x + from.w, y: from.y + from.h / 2 }, { x: to.x, y: to.y + to.h / 2 }];
  return [{ x: from.x, y: from.y + from.h / 2 }, { x: to.x + to.w, y: to.y + to.h / 2 }];
}

export function stateKey(node: DiagramNode): ArchState {
  if (node.changed) return "changed";
  if (node.impacted) return "impacted";
  if (node.observed) return "observed";
  return "untouched";
}

export function stateLabel(node: DiagramNode): string {
  switch (stateKey(node)) {
    case "changed": return "changed by this commit";
    case "impacted": return "reached by this commit, not changed by it";
    case "observed": return "seen in code facts";
    default: return "not touched by this commit";
  }
}

/**
 * The node under a diagram-space point.
 *
 * A leaf wins over the boundary that contains it, because a leaf is what a
 * reader points at; among boundaries the innermost wins for the same reason.
 */
export function pickNode(layout: DiagramLayout, point: { x: number; y: number }): DiagramNode | undefined {
  const holds = (box: DiagramBox): boolean =>
    point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h;
  for (let index = layout.leaves.length - 1; index >= 0; index -= 1) {
    const node = layout.leaves[index]!;
    if (holds(node.box)) return node;
  }
  let innermost: DiagramNode | undefined;
  for (const node of layout.boundaries) {
    if (!holds(node.box)) continue;
    if (innermost === undefined || node.box.w * node.box.h < innermost.box.w * innermost.box.h) innermost = node;
  }
  return innermost;
}

/** What a label is for, so the overlay can style it without re-deriving state. */
export type LabelRole = "boundary-title" | "leaf-name" | "leaf-kind" | "edge-label" | "legend-title" | "legend-label" | "legend-note";

/**
 * One label of the diagram, positioned in diagram units.
 *
 * CanvasKit has no system font to draw text with, and this app ships no font, so
 * the labels are laid out here and painted by a DOM overlay instead — which also
 * keeps them crisp at every zoom and correct for non-Latin names.
 */
export interface DiagramLabel {
  key: string;
  text: string;
  role: LabelRole;
  /** The text's own position in diagram units. */
  x: number;
  y: number;
  /** Whether x is the text's start or its centre. */
  align: "start" | "center";
  selected: boolean;
  state: ArchState;
}

export function buildLabels(layout: DiagramLayout, selected: string | null): DiagramLabel[] {
  const labels: DiagramLabel[] = [];
  for (const node of layout.boundaries) {
    labels.push({
      key: `boundary-${node.element.id}`, text: `${node.element.name} · ${node.element.kind}`,
      role: "boundary-title", x: node.box.x + 8, y: node.box.y + 15, align: "start",
      selected: node.element.id === selected, state: stateKey(node),
    });
  }
  for (const node of layout.leaves) {
    const center = node.box.x + node.box.w / 2;
    const state = stateKey(node);
    const isSelected = node.element.id === selected;
    labels.push({ key: `leaf-name-${node.element.id}`, text: node.element.name, role: "leaf-name", x: center, y: node.box.y + node.box.h / 2 + 1, align: "center", selected: isSelected, state });
    labels.push({ key: `leaf-kind-${node.element.id}`, text: node.element.kind, role: "leaf-kind", x: center, y: node.box.y + node.box.h - 7, align: "center", selected: isSelected, state });
  }
  for (const { relationship, observed, from, to } of layout.edges) {
    if (observed || relationship.description === undefined || relationship.description === "") continue;
    const [start, end] = anchors(from.box, to.box);
    // The label sits on the line rather than at either end, so it reads as the
    // relationship's own name instead of one element's.
    labels.push({
      key: `edge-${relationship.id}`, text: relationship.description, role: "edge-label",
      x: start.x + (end.x - start.x) * 0.35, y: start.y + (end.y - start.y) * 0.35 - 3,
      align: "center", selected: false, state: "untouched",
    });
  }
  const legend = legendSpec(layout.diagram);
  labels.push({ key: "legend-title", text: legend.title.text, role: "legend-title", x: legend.title.x, y: legend.title.y, align: "start", selected: false, state: "untouched" });
  for (const [index, swatch] of legend.swatches.entries()) {
    labels.push({ key: `legend-swatch-${index}`, text: swatch.label, role: "legend-label", x: swatch.x + SWATCH_W + 8, y: swatch.y, align: "start", selected: false, state: "untouched" });
  }
  for (const [index, entry] of legend.edges.entries()) {
    labels.push({ key: `legend-edge-${index}`, text: entry.label, role: "legend-label", x: entry.x + SWATCH_W + 8, y: entry.y, align: "start", selected: false, state: "untouched" });
  }
  labels.push({ key: "legend-note", text: legend.note.text, role: "legend-note", x: legend.note.x, y: legend.note.y, align: "start", selected: false, state: "untouched" });
  return labels;
}

/** The swatch a legend entry draws, in diagram units. */
export const SWATCH_W = 24;
export const SWATCH_H = 14;

export interface LegendSpec {
  title: { x: number; y: number; text: string };
  swatches: Array<{ x: number; y: number; state: ArchState; label: string }>;
  edges: Array<{ x: number; y: number; observed: boolean; label: string }>;
  note: { x: number; y: number; text: string };
}

/**
 * What the legend states, in the words the SVG legend already uses.
 *
 * Both renderers place it from here so the explanation of the encoding cannot
 * drift from the diagram it explains.
 */
export function legendSpec(diagram: { height: number }): LegendSpec {
  const baseline = diagram.height - 26;
  return {
    title: { x: MARGIN, y: baseline, text: "Legend" },
    swatches: [
      { x: MARGIN + 52, y: baseline, state: "changed", label: "changed by this commit" },
      { x: MARGIN + 232, y: baseline, state: "impacted", label: "reached by it" },
      { x: MARGIN + 372, y: baseline, state: "observed", label: "seen in code facts" },
    ],
    edges: [
      { x: MARGIN + 532, y: baseline - 3, observed: false, label: "declared relationship" },
      { x: MARGIN + 712, y: baseline - 3, observed: true, label: "code-fact call" },
    ],
    note: {
      x: MARGIN, y: diagram.height - 10,
      text: "Reached means a caller one import hop from the change. Code facts only: runtime traffic, logs and traces were not evaluated.",
    },
  };
}
