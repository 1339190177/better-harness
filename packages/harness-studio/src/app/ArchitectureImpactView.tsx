import { useCallback, useEffect, useRef, useState } from "react";
import { isArchitectureImpact, type ArchitectureImpact, type ArchitectureElement } from "../contracts/architecture-impact.js";
import { SpinnerGap } from "@phosphor-icons/react/SpinnerGap";

interface Props {
  sha: string;
}

interface DiagramBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface DiagramNode {
  element: ArchitectureElement;
  children: DiagramNode[];
  box: DiagramBox;
  depth: number;
  changed: boolean;
  observed: boolean;
  /** Child rows, kept from measurement so placement stays a pure function of it. */
  rows: DiagramNode[][];
}

/** A leaf is one drawn element; a boundary is one element that contains others. */
const LEAF_W = 176;
const LEAF_H = 54;
const BOUNDARY_HEADER = 22;
const BOUNDARY_PAD = 12;
const SIBLING_GAP = 16;
const ROOT_GAP = 28;
const MARGIN = 16;
/** A boundary wraps its children rather than growing without limit. Wide enough
 * that two containers sit side by side, tall enough that a nested box reads. */
const MAX_ROW_W = 1180;

export function ArchitectureImpactView({ sha }: Props) {
  const [data, setData] = useState<ArchitectureImpact | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/git/commits/${sha}/architecture`)
      .then((r) => r.json())
      .then((d: unknown) => {
        if (cancelled) return;
        // The reading has three states and no error state, so anything that is
        // not a reading is reported as one rather than rendered as a diagram
        // with nothing in it.
        if (!isArchitectureImpact(d) || d.status === "unavailable") {
          setError(readingError(d));
        } else {
          setData(d);
        }
        setLoading(false);
      })
      .catch((e) => {
        if (!cancelled) { setError(e.message); setLoading(false); }
      });
    return () => { cancelled = true; };
  }, [sha]);

  const exportDsl = useCallback(() => {
    if (!data?.dsl) return;
    const blob = new Blob([data.dsl], { type: "text/plain;charset=utf-8" });
    downloadBlob(blob, `${sha}.dsl`);
  }, [data, sha]);

  const exportSvg = useCallback(() => {
    if (!svgRef.current) return;
    const clone = svgRef.current.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    // An exported file leaves this stylesheet behind, so the paint it needs is
    // resolved onto the nodes themselves; otherwise the diagram arrives as an
    // unreadable black rectangle in every other viewer.
    inlinePaint(svgRef.current, clone);
    const blob = new Blob([clone.outerHTML], { type: "image/svg+xml;charset=utf-8" });
    downloadBlob(blob, `${sha}.architecture.svg`);
  }, [sha]);

  if (loading) return <div className="arch-pane"><div className="arch-loading" role="status"><SpinnerGap aria-hidden="true" size={16} className="spin" /><span>Loading architecture impact...</span></div></div>;
  if (error) return <div className="arch-pane"><div className="arch-error">{error}</div></div>;
  if (!data) return null;

  const roots = buildTree(data);
  const diagram = layOut(roots);
  const nodesById = indexNodes(roots);
  const edges = [
    ...data.relationships.map((relationship) => ({ relationship, observed: false })),
    ...data.observedEdges.map((relationship) => ({ relationship, observed: true })),
  ].flatMap(({ relationship, observed }) => {
    const from = nodesById.get(relationship.sourceId);
    const to = nodesById.get(relationship.targetId);
    // An edge to an element this commit's model does not contain is dropped
    // rather than drawn to nowhere; the element list is the reading's own.
    return from === undefined || to === undefined || from === to ? [] : [{ relationship, observed, from, to }];
  });

  return (
    <div className="arch-pane" data-arch-sha={sha}>
      <div className="arch-header"><strong>Architecture Impact</strong><span>{data.elements.length} elements · {edges.length} edges</span></div>
      <div className="arch-toolbar">
        <span className="arch-summary">
          {data.overlay.changedSymbols > 0
            ? `${data.overlay.changedSymbols} changed symbols, ${data.overlay.impactedSymbols} impacted`
            : "No architecture impact detected"}
        </span>
        {data.omitted.length > 0 && (
          // A projection that stays quiet about the files it skipped reads as
          // "nothing there", which is the one thing it must never imply.
          <span className="arch-omitted">
            {data.omitted.map((omission) => `${omission.count} file${omission.count === 1 ? "" : "s"} not read (${omission.reason === "too-large" ? "over the per-file bound" : "past the request budget"}: ${omission.examplePath})`).join("; ")}
          </span>
        )}
        {data.dsl && <button type="button" className="arch-btn" onClick={exportDsl}>Export .dsl</button>}
        <button type="button" className="arch-btn" onClick={exportSvg}>Export .svg</button>
      </div>
      <div className="arch-canvas">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${diagram.width} ${diagram.height}`}
          width={diagram.width}
          height={diagram.height}
          className="arch-svg"
          role="img"
          aria-label={`Declared architecture with this commit's change marked: ${data.elements.length} elements and ${edges.length} relationships.`}
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <marker id="arch-arrow-declared" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" className="arch-arrow-declared" />
            </marker>
            <marker id="arch-arrow-observed" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" className="arch-arrow-observed" />
            </marker>
          </defs>
          {/* Boundaries paint before their contents, so a nested element is never hidden. */}
          <g className="arch-boundaries">
            {flatten(roots).filter((node) => node.children.length > 0).map((node) => (
              <g key={`boundary-${node.element.id}`}>
                <rect
                  x={node.box.x}
                  y={node.box.y}
                  width={node.box.w}
                  height={node.box.h}
                  rx={6}
                  className={node.changed ? "arch-boundary-changed" : "arch-boundary"}
                />
                <text x={node.box.x + 8} y={node.box.y + 15} className={node.changed ? "arch-boundary-title-changed" : "arch-boundary-title"}>
                  {node.element.name} · {node.element.kind}
                </text>
              </g>
            ))}
          </g>
          <g className="arch-edges">
            {edges.map(({ relationship, observed, from, to }) => {
              const [start, end] = anchors(from.box, to.box);
              return (
                <g key={`${observed ? "observed" : "declared"}-${relationship.id}`}>
                  <line
                    x1={start.x}
                    y1={start.y}
                    x2={end.x}
                    y2={end.y}
                    className={observed ? "arch-edge-observed" : "arch-edge-declared"}
                    markerEnd={observed ? "url(#arch-arrow-observed)" : "url(#arch-arrow-declared)"}
                  />
                  {!observed && relationship.description !== undefined && relationship.description !== "" && (
                    <text
                      x={start.x + (end.x - start.x) * 0.35}
                      y={start.y + (end.y - start.y) * 0.35 - 3}
                      className="arch-edge-label"
                      textAnchor="middle"
                    >
                      {relationship.description}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
          <g className="arch-elements">
            {flatten(roots).filter((node) => node.children.length === 0).map((node) => (
              <g key={`element-${node.element.id}`} className={node.changed ? "arch-box-changed" : node.observed ? "arch-box-observed" : "arch-box-default"}>
                <rect x={node.box.x} y={node.box.y} width={node.box.w} height={node.box.h} rx={6} className="arch-box" />
                <text x={node.box.x + node.box.w / 2} y={node.box.y + node.box.h / 2 + 1} textAnchor="middle" dominantBaseline="middle" className="arch-label">
                  {node.element.name}
                </text>
                <text x={node.box.x + node.box.w / 2} y={node.box.y + node.box.h - 7} textAnchor="middle" className="arch-kind">
                  {node.element.kind}
                </text>
              </g>
            ))}
          </g>
          <g className="arch-legend">
            <text x={MARGIN} y={diagram.height - 26} className="arch-legend-title">Legend</text>
            <LegendElement x={MARGIN + 52} y={diagram.height - 26} state="arch-box-changed" label="changed by this commit" />
            <LegendElement x={MARGIN + 232} y={diagram.height - 26} state="arch-box-observed" label="observed in code facts" />
            <LegendEdge x={MARGIN + 412} y={diagram.height - 29} observed={false} label="declared relationship" />
            <LegendEdge x={MARGIN + 592} y={diagram.height - 29} observed label="code-fact call" />
            <text x={MARGIN} y={diagram.height - 10} className="arch-legend-note">
              Code facts only: runtime traffic, logs and traces were not evaluated, so a call that never happened reads like one that did.
            </text>
          </g>
        </svg>
      </div>
    </div>
  );
}

/** Legend entries reuse the diagram's own markup, so a swatch cannot drift from
 * the encoding it explains. */
function LegendElement({ x, y, state, label }: { x: number; y: number; state: string; label: string }) {
  return (
    <g>
      <g className={state}>
        <rect x={x} y={y - 9} width={24} height={14} rx={3} className="arch-box" />
      </g>
      <text x={x + 32} y={y} className="arch-legend-label">{label}</text>
    </g>
  );
}

function LegendEdge({ x, y, observed, label }: { x: number; y: number; observed: boolean; label: string }) {
  return (
    <g>
      <line
        x1={x}
        y1={y - 2}
        x2={x + 24}
        y2={y - 2}
        className={observed ? "arch-edge-observed" : "arch-edge-declared"}
        markerEnd={observed ? "url(#arch-arrow-observed)" : "url(#arch-arrow-declared)"}
      />
      <text x={x + 32} y={y} className="arch-legend-label">{label}</text>
    </g>
  );
}

/** Build the declared hierarchy, treating anything unparented as a root. */
function buildTree(data: ArchitectureImpact): DiagramNode[] {
  const changed = new Set(data.changedHitIds);
  const observed = new Set(data.codeHitIds);
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

function indexNodes(roots: readonly DiagramNode[]): Map<string, DiagramNode> {
  return new Map(flatten(roots).map((node) => [node.element.id, node]));
}

/**
 * Where a relationship meets its two boxes.
 *
 * A declared model is not a drawing, so the anchor is chosen from the relative
 * position of the two boxes rather than stored in the model.
 */
function anchors(from: DiagramBox, to: DiagramBox): [{ x: number; y: number }, { x: number; y: number }] {
  if (from.y + from.h <= to.y + 1) return [{ x: from.x + from.w / 2, y: from.y + from.h }, { x: to.x + to.w / 2, y: to.y }];
  if (to.y + to.h <= from.y + 1) return [{ x: from.x + from.w / 2, y: from.y }, { x: to.x + to.w / 2, y: to.y + to.h }];
  if (from.x + from.w <= to.x + 1) return [{ x: from.x + from.w, y: from.y + from.h / 2 }, { x: to.x, y: to.y + to.h / 2 }];
  return [{ x: from.x, y: from.y + from.h / 2 }, { x: to.x + to.w, y: to.y + to.h / 2 }];
}

/** Copies presentation onto the clone, so an exported file stands on its own. */
const PAINT_PROPERTIES = [
  "fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "stroke-linejoin",
  "font-family", "font-size", "font-weight", "paint-order", "text-anchor", "dominant-baseline",
] as const;

function inlinePaint(source: SVGSVGElement, clone: SVGSVGElement): void {
  const live = [source, ...source.querySelectorAll("*")];
  const copies = [clone, ...clone.querySelectorAll("*")];
  for (let index = 0; index < live.length && index < copies.length; index += 1) {
    const computed = getComputedStyle(live[index]!);
    copies[index]!.setAttribute("style", PAINT_PROPERTIES.map((property) => `${property}:${computed.getPropertyValue(property)}`).join(";"));
  }
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Why this commit has no reading: the server's reason, or the shape it sent. */
function readingError(payload: unknown): string {
  if (isArchitectureImpact(payload) && typeof payload.error === "string") return payload.error;
  if (typeof payload === "object" && payload !== null && typeof (payload as { error?: unknown }).error === "string") {
    return (payload as { error: string }).error;
  }
  return "Architecture impact is unavailable for this commit.";
}
