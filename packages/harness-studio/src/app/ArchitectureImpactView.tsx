import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { isArchitectureImpact, type ArchitectureElement, type ArchitectureImpact } from "../contracts/architecture-impact.js";
import { SpinnerGap } from "@phosphor-icons/react/SpinnerGap";

interface Props {
  sha: string;
  /** Optional short sha, so a surface that owns the commit selection can show it. */
  label?: string;
  /** The surface owns the generation pane, so it also owns the button that opens it. */
  agentTrigger: RefObject<HTMLButtonElement | null>;
  /** Whether the model-generation pane is open beside this projection. */
  agentOpen: boolean;
  onToggleAgent: () => void;
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
  impacted: boolean;
  /** Child rows, kept from measurement so placement stays a pure function of it. */
  rows: DiagramNode[][];
}

/** Pan and zoom of the viewport, in screen units. */
interface View {
  scale: number;
  x: number;
  y: number;
}

/** A label is what the omitted-file notice prints for each bound. */
const OMISSION_REASON: Record<ArchitectureImpact["omitted"][number]["reason"], string> = {
  "too-large": "over the per-file bound",
  "request-budget": "past the request budget",
  "import-hop": "past the one-hop neighbourhood",
  "unsupported-language": "in a language the host does not extract",
  "unparsed": "which the host could not parse",
};

/**
 * One omission as the notice prints it. The groups are joined into one line that
 * the toolbar clips and hints, so the path a reader needs is in the tooltip
 * rather than in a width the pane does not have.
 */
function omissionNotice(omitted: ArchitectureImpact["omitted"]): string {
  return omitted
    .map((omission) => `${omission.count} file${omission.count === 1 ? "" : "s"} not read (${OMISSION_REASON[omission.reason]}: ${omission.examplePath})`)
    .join("; ");
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
const ZOOM_STEP = 1.25;
const MAX_SCALE = 4;
const MIN_SCALE = 0.15;
/**
 * A fit below this is a thumbnail, not a diagram: the pane shows the corner of
 * the picture at a legible scale and the reader pans, instead of shrinking a
 * model until its labels cannot be read.
 */
const MIN_LEGIBLE_SCALE = 0.5;
const POPUP_W = 296;

export function ArchitectureImpactView({ sha, label, agentTrigger, agentOpen, onToggleAgent }: Props) {
  const [data, setData] = useState<ArchitectureImpact | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  /** `null` means "fit the pane": the reading a reader wants before any zooming. */
  const [view, setView] = useState<View | null>(null);
  /** Set while a generated model is being saved as the declared one. */
  const [saving, setSaving] = useState(false);
  /** The last save outcome, shown beside the badge; cleared when the commit changes. */
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const [pane, setPane] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const panRef = useRef<{ pointerId: number; startX: number; startY: number; origin: View; moved: boolean } | null>(null);
  /** Set while a drag is in progress, so releasing it does not also select. */
  const draggedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelected(null);
    setView(null);
    setSaveNote(null);
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

  // The viewport is measured rather than assumed: a docked pane is resizable, and
  // "fit" is only meaningful against the size the reader actually has.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const measure = (): void => {
      const bounds = canvas.getBoundingClientRect();
      paneRef.current = { w: bounds.width, h: bounds.height };
      setPane({ w: bounds.width, h: bounds.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [loading, error]);

  // React attaches wheel listeners passively, so zooming without also scrolling
  // the pane needs the listener registered here.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      zoomAbout(event.offsetX, event.offsetY, event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  });
  const exportDsl = useCallback(() => {
    if (!data?.dsl) return;
    const blob = new Blob([data.dsl], { type: "text/plain;charset=utf-8" });
    downloadBlob(blob, `${sha}.dsl`);
  }, [data, sha]);

  const diagramSizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });

  const exportSvg = useCallback(() => {
    const live = svgRef.current;
    if (live === null) return;
    const clone = live.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    // The live viewport may be zoomed and panned; a file is of the diagram, so it
    // is written at the diagram's own size with the view transform removed.
    const { width, height } = diagramSizeRef.current;
    clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
    clone.setAttribute("width", String(width));
    clone.setAttribute("height", String(height));
    clone.querySelector("g.arch-view")?.removeAttribute("transform");
    // An exported file leaves this stylesheet behind, so the paint it needs is
    // resolved onto the nodes themselves; otherwise the diagram arrives as an
    // unreadable black rectangle in every other viewer.
    inlinePaint(live, clone);
    const blob = new Blob([clone.outerHTML], { type: "image/svg+xml;charset=utf-8" });
    downloadBlob(blob, `${sha}.architecture.svg`);
  }, [sha]);

  if (loading) return <div className="arch-pane"><div className="arch-loading" role="status"><SpinnerGap aria-hidden="true" size={16} className="spin" /><span>Loading architecture impact...</span></div></div>;
  if (error) return <div className="arch-pane"><div className="arch-error">{error}</div></div>;
  if (!data) return null;

  const roots = buildTree(data);
  const diagram = layOut(roots);
  diagramSizeRef.current = diagram;
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

  const fit = fitView(pane, diagram);
  const shown = view ?? fit;
  const selectedNode = selected === null ? undefined : nodesById.get(selected);
  const notice = omissionNotice(data.omitted);

  /** Zoom about a point in the pane, so the element under the pointer stays put. */
  function zoomAbout(px: number, py: number, factor: number): void {
    const current = view ?? fitView(paneRef.current, diagram);
    const scale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE);
    const ratio = scale / current.scale;
    setView({ scale, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio });
  }

  function zoomBy(factor: number): void {
    zoomAbout(pane.w / 2, pane.h / 2, factor);
  }

  function startPan(event: ReactPointerEvent<SVGSVGElement>): void {
    if (event.button !== 0) return;
    draggedRef.current = false;
    panRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: shown, moved: false };
  }

  /**
   * Panning captures the pointer, which retargets the click that follows to the
   * viewport. Capture is therefore taken on the first real movement: a press and
   * release without one stays a click on whatever element was under it.
   */
  function movePan(event: ReactPointerEvent<SVGSVGElement>): void {
    const pan = panRef.current;
    if (pan === null || pan.pointerId !== event.pointerId) return;
    const dx = event.clientX - pan.startX;
    const dy = event.clientY - pan.startY;
    if (!pan.moved) {
      if (Math.hypot(dx, dy) < 3) return;
      pan.moved = true;
      draggedRef.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setView({ scale: pan.origin.scale, x: pan.origin.x + dx, y: pan.origin.y + dy });
  }

  function endPan(event: ReactPointerEvent<SVGSVGElement>): void {
    const pan = panRef.current;
    if (pan === null || pan.pointerId !== event.pointerId) return;
    panRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  /** Selecting is a gesture of its own: a drag that ended on an element is not one. */
  function select(id: string): void {
    if (draggedRef.current) return;
    setSelected(selected === id ? null : id);
  }

  /**
   * Save the generated model as the worktree's declared one, on the reader's
   * action. A declared model is only replaced when the reader confirms it, so a
   * routine save never clobbers an authored model.
   */
  async function saveModel(overwrite: boolean): Promise<void> {
    setSaving(true);
    setSaveNote(null);
    try {
      const response = await fetch("/api/git/architecture/model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overwrite }),
      });
      if (response.ok) {
        setSaveNote("Saved as the declared model. Reopen the commit to project onto it.");
      } else {
        const payload = await response.json().catch(() => ({}));
        setSaveNote(typeof (payload as { error?: unknown }).error === "string" ? (payload as { error: string }).error : "The model could not be saved.");
      }
    } catch (cause) {
      setSaveNote(cause instanceof Error ? cause.message : "The model could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="arch-pane" data-arch-sha={sha}>
      <div className="arch-header">
        <strong>Architecture Impact</strong>
        <span>{label === undefined ? undefined : `${label} · `}{data.elements.length} elements · {edges.length} edges</span>
        {data.modelSource?.origin === "generated" && (
          // A generated model is a candidate, not an authored fact, so it is
          // labelled as one wherever it is shown.
          <span className="arch-badge" title="Derived from the project structure. Review and save to declare it.">
            Auto-generated{data.modelSource.confidence === undefined ? "" : ` · ${data.modelSource.confidence} confidence`}
          </span>
        )}
      </div>
      <div className="arch-toolbar">
        <span className="arch-summary">
          {data.overlay.changedSymbols > 0
            // Elements reached are named only when there are some: "0 elements
            // reached" beside a non-zero impact reads as a contradiction, while
            // the radius is usually inside the elements that already changed.
            ? `${data.overlay.changedSymbols} changed symbols, ${data.overlay.impactedSymbols} impacted${data.impactedHitIds.length > 0 ? `, ${data.impactedHitIds.length} elements reached` : ""}`
            : "No architecture impact detected"}
        </span>
        {notice !== "" && (
          // A projection that stays quiet about the files it skipped reads as
          // "nothing there", which is the one thing it must never imply.
          <span className="arch-omitted" title={notice}>{notice}</span>
        )}
        <span className="arch-zoom" role="group" aria-label="Diagram zoom">
          <button type="button" className="arch-btn" onClick={() => zoomBy(1 / ZOOM_STEP)} aria-label="Zoom out">−</button>
          <span className="arch-zoom-level">{Math.round(shown.scale * 100)}%</span>
          <button type="button" className="arch-btn" onClick={() => zoomBy(ZOOM_STEP)} aria-label="Zoom in">+</button>
          <button type="button" className="arch-btn" onClick={() => { setView(null); }} disabled={view === null}>Fit</button>
        </span>
        {data.dsl && <button type="button" className="arch-btn" onClick={exportDsl}>Export .dsl</button>}
        <button type="button" className="arch-btn" onClick={exportSvg}>Export .svg</button>
        <button ref={agentTrigger} type="button" className="arch-btn" aria-expanded={agentOpen} aria-controls={agentOpen ? "impact-agent-panel" : undefined} onClick={onToggleAgent}>Generate with AI</button>
        {data.modelSource?.origin === "generated" && (
          <button type="button" className="arch-btn" onClick={() => { void saveModel(false); }} disabled={saving}>
            {saving ? "Saving…" : "Save as declared model"}
          </button>
        )}
      </div>
      {saveNote !== null && <div className="arch-save-note" role="status">{saveNote}</div>}
      <div
        className="arch-canvas"
        ref={canvasRef}
        onKeyDown={(event) => {
          if (event.key === "Escape") { setSelected(null); setView(null); }
        }}
      >
        <svg
          ref={svgRef}
          viewBox={`0 0 ${pane.w} ${pane.h}`}
          width="100%"
          height="100%"
          className="arch-svg"
          role="img"
          aria-label={`Declared architecture with this commit's change marked: ${data.elements.length} elements, ${data.changedHitIds.length} changed, ${data.impactedHitIds.length} reached, ${edges.length} relationships.`}
          xmlns="http://www.w3.org/2000/svg"
          onPointerDown={startPan}
          onPointerMove={movePan}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          onDoubleClick={() => setView(null)}
        >
          <defs>
            <marker id="arch-arrow-declared" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" className="arch-arrow-declared" />
            </marker>
            <marker id="arch-arrow-observed" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" className="arch-arrow-observed" />
            </marker>
          </defs>
          <g className="arch-view" transform={`translate(${shown.x} ${shown.y}) scale(${shown.scale})`}>
            {/* Boundaries paint before their contents, so a nested element is never hidden. */}
            <g className="arch-boundaries">
              {flatten(roots).filter((node) => node.children.length > 0).map((node) => (
                <g
                  key={`boundary-${node.element.id}`}
                  className={`${stateClass(node)}${selected === node.element.id ? " arch-selected" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${node.element.name}, ${node.element.kind}, ${stateLabel(node)}`}
                  onClick={() => select(node.element.id)}
                  onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(node.element.id); } }}
                >
                  <rect x={node.box.x} y={node.box.y} width={node.box.w} height={node.box.h} rx={6} className="arch-boundary" />
                  <text x={node.box.x + 8} y={node.box.y + 15} className="arch-boundary-title">
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
                <g
                  key={`element-${node.element.id}`}
                  className={`${stateClass(node)}${selected === node.element.id ? " arch-selected" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${node.element.name}, ${node.element.kind}, ${stateLabel(node)}`}
                  onClick={() => select(node.element.id)}
                  onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(node.element.id); } }}
                >
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
              <LegendElement x={MARGIN + 232} y={diagram.height - 26} state="arch-box-impacted" label="reached by it" />
              <LegendElement x={MARGIN + 372} y={diagram.height - 26} state="arch-box-observed" label="seen in code facts" />
              <LegendEdge x={MARGIN + 532} y={diagram.height - 29} observed={false} label="declared relationship" />
              <LegendEdge x={MARGIN + 712} y={diagram.height - 29} observed label="code-fact call" />
              <text x={MARGIN} y={diagram.height - 10} className="arch-legend-note">
                Reached means a caller one import hop from the change. Code facts only: runtime traffic, logs and traces were not evaluated.
              </text>
            </g>
          </g>
        </svg>
        {selectedNode !== undefined && (
          <ElementPopup
            node={selectedNode}
            elements={data.elements}
            edges={edges}
            pane={pane}
            view={shown}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  );
}

/** A docked card, anchored to the element it describes rather than centred. */
function ElementPopup({
  node,
  elements,
  edges,
  pane,
  view,
  onClose,
}: {
  node: DiagramNode;
  elements: ArchitectureElement[];
  edges: Array<{ relationship: { id: string; description?: string }; observed: boolean; from: DiagramNode; to: DiagramNode }>;
  pane: { w: number; h: number };
  view: View;
  onClose: () => void;
}) {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const lineage: string[] = [];
  for (let current = node.element.parentId, guard = 0; current !== undefined && guard < 8; guard += 1) {
    const parent = byId.get(current);
    if (parent === undefined) break;
    lineage.unshift(parent.name);
    current = parent.parentId;
  }
  const outgoing = edges.filter((edge) => edge.from.element.id === node.element.id);
  const incoming = edges.filter((edge) => edge.to.element.id === node.element.id);

  const box = screenBox(node.box, view);
  const left = clamp(box.x + box.w / 2 - POPUP_W / 2, 8, Math.max(8, pane.w - POPUP_W - 8));
  const below = box.y + box.h + 8;
  const top = below + 190 > pane.h ? Math.max(8, box.y - 198) : below;

  return (
    <div className="arch-popup" style={{ left, top, width: POPUP_W }} role="dialog" aria-label={`${node.element.name} details`}>
      <div className="arch-popup-head">
        <strong>{node.element.name}</strong>
        <button type="button" className="arch-popup-close" onClick={onClose} aria-label="Close details">×</button>
      </div>
      <div className="arch-popup-meta">
        {[node.element.kind, node.element.technology].filter((value) => value !== undefined && value !== "").join(" · ")}
      </div>
      <div className={`arch-popup-state arch-state-${stateKey(node)}`}>{stateLabel(node)}</div>
      {lineage.length > 0 && <div className="arch-popup-line">{lineage.join(" › ")}</div>}
      {node.element.description !== undefined && node.element.description !== "" && (
        <p className="arch-popup-text">{node.element.description}</p>
      )}
      <Section title="Reaches" entries={outgoing.map(describeEdge)} />
      <Section title="Reached by" entries={incoming.map(describeEdge)} />
    </div>
  );
}

function Section({ title, entries }: { title: string; entries: string[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="arch-popup-section">
      <span className="arch-popup-label">{title}</span>
      <ul className="arch-popup-list">
        {entries.slice(0, 6).map((entry, index) => <li key={`${index}-${entry}`}>{entry}</li>)}
      </ul>
    </div>
  );
}

function describeEdge(edge: { relationship: { description?: string }; observed: boolean; from: DiagramNode; to: DiagramNode }): string {
  const description = edge.relationship.description !== undefined && edge.relationship.description !== "" ? edge.relationship.description : "relationship";
  return `${edge.from.element.name} → ${edge.to.element.name} · ${description}${edge.observed ? " (code fact)" : ""}`;
}

/** Which of the three marked states an element is in, and how it is named. */
function stateKey(node: DiagramNode): "changed" | "impacted" | "observed" | "untouched" {
  if (node.changed) return "changed";
  if (node.impacted) return "impacted";
  if (node.observed) return "observed";
  return "untouched";
}

function stateClass(node: DiagramNode): string {
  return `arch-box-${stateKey(node)}`;
}

function stateLabel(node: DiagramNode): string {
  switch (stateKey(node)) {
    case "changed": return "changed by this commit";
    case "impacted": return "reached by this commit, not changed by it";
    case "observed": return "seen in code facts";
    default: return "not touched by this commit";
  }
}

function screenBox(box: DiagramBox, view: View): DiagramBox {
  return { x: box.x * view.scale + view.x, y: box.y * view.scale + view.y, w: box.w * view.scale, h: box.h * view.scale };
}

function fitView(pane: { w: number; h: number }, diagram: { width: number; height: number }): View {
  if (pane.w === 0 || pane.h === 0 || diagram.width === 0) return { scale: 1, x: 0, y: 0 };
  const wanted = Math.min((pane.w - 8) / diagram.width, (pane.h - 8) / diagram.height, 1.5);
  if (wanted >= MIN_LEGIBLE_SCALE) {
    return { scale: wanted, x: (pane.w - diagram.width * wanted) / 2, y: (pane.h - diagram.height * wanted) / 2 };
  }
  // Anchored at the diagram's own origin, so the picture opens on its roots
  // rather than on whatever happens to sit at its middle.
  return { scale: MIN_LEGIBLE_SCALE, x: 8, y: 8 };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
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
