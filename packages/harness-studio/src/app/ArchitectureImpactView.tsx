import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from "react";
import type { CanvasKit } from "canvaskit-wasm";
import {
  isArchitectureImpact,
  type ArchitectureElement,
  type ArchitectureImpact,
  type ArchitectureImpactFile,
  type ArchitectureImpactFileState,
} from "../contracts/architecture-impact.js";
import {
  MAX_SCALE,
  MIN_SCALE,
  ZOOM_STEP,
  anchors,
  buildLayout,
  clamp,
  fitView,
  legendSpec,
  pickNode,
  screenBox,
  stateKey,
  stateLabel,
  toDiagram,
  type DiagramEdge,
  type DiagramLayout,
  type DiagramNode,
  type DiagramView,
} from "./arch-canvas/diagram-model.js";
import { KitSurface } from "./arch-canvas/KitSurface.js";
import { loadCanvasKit } from "./arch-canvas/kit-loader.js";
import { CaretDown } from "@phosphor-icons/react/CaretDown";
import { CaretRight } from "@phosphor-icons/react/CaretRight";
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

const POPUP_W = 296;

export function ArchitectureImpactView({ sha, label, agentTrigger, agentOpen, onToggleAgent }: Props) {
  const [data, setData] = useState<ArchitectureImpact | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  /** `null` means "fit the pane": the reading a reader wants before any zooming. */
  const [view, setView] = useState<DiagramView | null>(null);
  /** Set while a generated model is being saved as the declared one. */
  const [saving, setSaving] = useState(false);
  /** The last save outcome, shown beside the badge; cleared when the commit changes. */
  const [saveNote, setSaveNote] = useState<string | null>(null);
  /** Open state of the docked changed-file list. */
  const [filesOpen, setFilesOpen] = useState(true);
  const svgRef = useRef<SVGSVGElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const panRef = useRef<{ pointerId: number; startX: number; startY: number; origin: DiagramView; moved: boolean } | null>(null);
  /** Set while a drag is in progress, so releasing it does not also select. */
  const draggedRef = useRef(false);
  /** The reading, laid out once: a viewport gesture must not relayout the model. */
  const layout = useMemo(() => (data === null ? null : buildLayout(data)), [data]);
  const viewGroupRef = useRef<SVGGElement>(null);
  /** True only while a pointer is dragging, so the compositor hint is transient. */
  const [interacting, setInteracting] = useState(false);
  /**
   * The CanvasKit runtime: `undefined` while it loads, `null` when this browser
   * cannot run it. The SVG diagram draws until it is ready, and keeps drawing if
   * it never is — a canvas is a faster renderer, not a required one.
   */
  const [canvasKit, setCanvasKit] = useState<CanvasKit | null | undefined>(undefined);
  /** The fitted viewport, read by a gesture that has no view of its own yet. */
  const fit = useMemo(() => (layout === null ? { scale: 1, x: 0, y: 0 } : fitView(pane, layout.diagram)), [layout, pane]);
  const fitRef = useRef(fit);
  fitRef.current = fit;

  useEffect(() => {
    let live = true;
    void loadCanvasKit().then((runtime) => { if (live) setCanvasKit(runtime); });
    return () => { live = false; };
  }, []);

  /** A surface Skia refused is the same as a runtime that never arrived. */
  const kitUnavailable = useCallback((): void => setCanvasKit(null), []);

  /** Zoom about a point in the pane, so the element under the pointer stays put. */
  const zoomAbout = useCallback((px: number, py: number, factor: number): void => {
    // The previous viewport is read from the update, not from this render, so a
    // burst of wheel steps cannot each zoom from the view before the last one.
    setView((previous) => {
      const current = previous ?? fitRef.current;
      const scale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE);
      const ratio = scale / current.scale;
      return { scale, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio };
    });
  }, []);

  /**
   * Selecting is a gesture of its own: a drag that ended on an element is not
   * one. Stable, so the drawn diagram is not reconciled when nothing moved.
   */
  const select = useCallback((id: string): void => {
    if (draggedRef.current) return;
    setSelected((current) => (current === id ? null : id));
  }, []);

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
      setPane({ w: bounds.width, h: bounds.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [loading, error]);

  // React attaches wheel listeners passively, so zooming without also scrolling
  // the pane needs the listener registered here. It zooms from the previous
  // viewport through the setter, so the listener itself is stable.
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
  }, [zoomAbout, loading, error]);
  const exportDsl = useCallback(() => {
    if (!data?.dsl) return;
    const blob = new Blob([data.dsl], { type: "text/plain;charset=utf-8" });
    downloadBlob(blob, `${sha}.dsl`);
  }, [data, sha]);

  if (loading) return <div className="arch-pane"><div className="arch-loading" role="status"><SpinnerGap aria-hidden="true" size={16} className="spin" /><span>Loading architecture impact...</span></div></div>;
  if (error) return <div className="arch-pane"><div className="arch-error">{error}</div></div>;
  if (!data || layout === null) return null;

  // The reading's own layout, read once: only the viewport moves from here.
  const diagramLayout: DiagramLayout = layout;
  const { diagram, nodesById, edges, names } = diagramLayout;

  const shown = view ?? fit;
  /** The canvas draws the diagram; until it can, the SVG does. */
  const onCanvas = canvasKit !== null && canvasKit !== undefined;
  const selectedNode = selected === null ? undefined : nodesById.get(selected);
  const notice = omissionNotice(data.omitted);

  function zoomBy(factor: number): void {
    zoomAbout(pane.w / 2, pane.h / 2, factor);
  }

  function startPan(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    // A canvas holds no focusable nodes, so the pane takes focus itself and the
    // keys a reader expects of it — Escape — still arrive.
    if (onCanvas) event.currentTarget.focus();
    draggedRef.current = false;
    panRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: shown, moved: false };
  }

  /**
   * Panning captures the pointer, which retargets the click that follows to the
   * viewport. Capture is therefore taken on the first real movement: a press and
   * release without one stays a click on whatever element was under it.
   */
  function movePan(event: ReactPointerEvent<HTMLDivElement>): void {
    const pan = panRef.current;
    if (pan === null || pan.pointerId !== event.pointerId) return;
    const dx = event.clientX - pan.startX;
    const dy = event.clientY - pan.startY;
    if (!pan.moved) {
      if (Math.hypot(dx, dy) < 3) return;
      pan.moved = true;
      draggedRef.current = true;
      // A drag is the one gesture worth compositing: the hint is taken while it
      // runs and released with it, so a settled diagram is rasterised sharply.
      setInteracting(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setView({ scale: pan.origin.scale, x: pan.origin.x + dx, y: pan.origin.y + dy });
  }

  function endPan(event: ReactPointerEvent<HTMLDivElement>): void {
    const pan = panRef.current;
    if (pan === null || pan.pointerId !== event.pointerId) return;
    panRef.current = null;
    setInteracting(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  /**
   * A canvas has no nodes to click, so the pane hit-tests the pointer itself,
   * against the same boxes the picture was drawn from.
   */
  function pickAt(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!onCanvas) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const node = pickNode(diagramLayout, toDiagram({ x: event.clientX - bounds.left, y: event.clientY - bounds.top }, shown));
    if (node !== undefined) select(node.element.id);
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
        <button ref={agentTrigger} type="button" className="arch-btn" aria-expanded={agentOpen} aria-controls={agentOpen ? "impact-agent-panel" : undefined} onClick={onToggleAgent}>Generate with AI</button>
        {data.modelSource?.origin === "generated" && (
          <button type="button" className="arch-btn" onClick={() => { void saveModel(false); }} disabled={saving}>
            {saving ? "Saving…" : "Save as declared model"}
          </button>
        )}
      </div>
      {saveNote !== null && <div className="arch-save-note" role="status">{saveNote}</div>}
      <div
        className={`arch-canvas${onCanvas ? " arch-canvas-kit" : ""}`}
        ref={canvasRef}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") { setSelected(null); setView(null); }
        }}
        // The pane owns the gesture for both renderers: the SVG's nodes and the
        // canvas's hit test are two readings of the same viewport.
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onClick={pickAt}
        onDoubleClick={() => setView(null)}
      >
        {canvasKit !== null && canvasKit !== undefined ? (
          <KitSurface
            canvasKit={canvasKit}
            layout={layout}
            selected={selected}
            view={shown}
            pane={pane}
            onUnavailable={kitUnavailable}
          />
        ) : (
          <svg
            ref={svgRef}
            viewBox={`0 0 ${pane.w} ${pane.h}`}
            width="100%"
            height="100%"
            className="arch-svg"
            role="img"
            aria-label={`Declared architecture with this commit's change marked: ${data.elements.length} elements, ${data.changedHitIds.length} changed, ${data.impactedHitIds.length} reached, ${edges.length} relationships.`}
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
            <g
              ref={viewGroupRef}
              className="arch-view"
              // A CSS transform is the compositor's to move; the SVG attribute is
              // not, so panning with it would re-rasterise every node it contains.
              // The hint is taken only while a drag runs, so a settled diagram is
              // rasterised sharply rather than left as a scaled bitmap.
              style={{
                transform: `translate(${shown.x}px, ${shown.y}px) scale(${shown.scale})`,
                transformOrigin: "0 0",
                transformBox: "view-box",
                willChange: interacting ? "transform" : undefined,
              } as CSSProperties}
            >
              <DiagramContent layout={layout} selected={selected} onSelect={select} />
            </g>
          </svg>
        )}
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
      {data.files.length > 0 && (
        // The reading's own change, named. Without it a no-impact commit answers
        // with silence about what it did change, and a reader cannot tell that
        // apart from a commit the projection was never about.
        <section className="arch-files" aria-label="Changed files">
          <header className="arch-files-head">
            <button
              type="button"
              className="arch-files-toggle"
              aria-expanded={filesOpen}
              onClick={() => setFilesOpen((open) => !open)}
            >
              {filesOpen ? <CaretDown aria-hidden="true" size={12} /> : <CaretRight aria-hidden="true" size={12} />}
              <strong>Changed files</strong>
            </button>
            <span className="arch-files-count">{filesSummary(data.files)}</span>
          </header>
          {filesOpen && (
            <ul className="arch-file-list">
              {data.files.map((file) => {
                // A reader knows the boundary by name; the id is only what the
                // projection carries, so an unmatched one is the fallback.
                const owners = file.elementIds.map((id) => names.get(id) ?? id).join(", ");
                return (
                  <li key={file.path} className="arch-file" data-standing={FILE_STANDING[file.state]}>
                    <span className="arch-file-status" title={file.status}>{CHANGE_LETTER[file.status]}</span>
                    <span className="arch-file-path" title={file.path}>{file.path}</span>
                    <span className="arch-file-state">{FILE_STATE_LABEL[file.state]}</span>
                    {owners !== "" && <span className="arch-file-element" title={owners}>{owners}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * Everything the viewport draws.
 *
 * Memoised on the reading, the selection and the select handler: a pan or a
 * zoom only moves the group around it, so the nodes are not diffed again per
 * frame — which is what made a large model unusable to pan.
 */
const DiagramContent = memo(function DiagramContent({ layout, selected, onSelect }: {
  layout: DiagramLayout;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const { boundaries, leaves, edges, diagram } = layout;
  const legend = legendSpec(diagram);
  return (
    <>
      {/* Boundaries paint before their contents, so a nested element is never hidden. */}
      <g className="arch-boundaries">
        {boundaries.map((node) => (
          <g
            key={`boundary-${node.element.id}`}
            className={`${stateClass(node)}${selected === node.element.id ? " arch-selected" : ""}`}
            role="button"
            tabIndex={0}
            aria-label={`${node.element.name}, ${node.element.kind}, ${stateLabel(node)}`}
            onClick={() => onSelect(node.element.id)}
            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(node.element.id); } }}
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
        {leaves.map((node) => (
          <g
            key={`element-${node.element.id}`}
            className={`${stateClass(node)}${selected === node.element.id ? " arch-selected" : ""}`}
            role="button"
            tabIndex={0}
            aria-label={`${node.element.name}, ${node.element.kind}, ${stateLabel(node)}`}
            onClick={() => onSelect(node.element.id)}
            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(node.element.id); } }}
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
        {/* Placed from the shared legend, so the words and the swatches cannot
            drift from the canvas legend that states the same thing. */}
        <text x={legend.title.x} y={legend.title.y} className="arch-legend-title">{legend.title.text}</text>
        {legend.swatches.map((swatch) => (
          <LegendElement key={swatch.state} x={swatch.x} y={swatch.y} state={`arch-box-${swatch.state}`} label={swatch.label} />
        ))}
        {legend.edges.map((entry) => (
          <LegendEdge key={entry.label} x={entry.x} y={entry.y} observed={entry.observed} label={entry.label} />
        ))}
        <text x={legend.note.x} y={legend.note.y} className="arch-legend-note">{legend.note.text}</text>
      </g>
    </>
  );
});

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
  view: DiagramView;
  onClose: () => void;
}) {
  // The card tracks the viewport, so the map and the two edge lists are derived
  // from the reading and the node rather than recomputed on every frame a pan
  // moves it.
  const { lineage, outgoing, incoming } = useMemo(() => {
    const byId = new Map(elements.map((element) => [element.id, element]));
    const lineage: string[] = [];
    for (let current = node.element.parentId, guard = 0; current !== undefined && guard < 8; guard += 1) {
      const parent = byId.get(current);
      if (parent === undefined) break;
      lineage.unshift(parent.name);
      current = parent.parentId;
    }
    return {
      lineage,
      outgoing: edges.filter((edge) => edge.from.element.id === node.element.id),
      incoming: edges.filter((edge) => edge.to.element.id === node.element.id),
    };
  }, [elements, edges, node]);

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

/** The one-letter change kind a file row leads with, as git prints it. */
const CHANGE_LETTER: Record<ArchitectureImpactFile["status"], string> = {
  added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", "type-changed": "T",
};

/** What each standing means to a reader, in the pane's own words. */
const FILE_STATE_LABEL: Record<ArchitectureImpactFileState, string> = {
  "in-projection": "in projection",
  "not-source": "not source",
  deleted: "deleted at this revision",
  "too-large": "over the per-file bound",
  "request-budget": "past the request budget",
  "unsupported-language": "language not extracted",
  unparsed: "could not be parsed",
};

/**
 * How a standing reads: held by the projection, outside what it is about, or a
 * named gap in it. The three groups are the ones a reader acts on differently,
 * so the list paints three tones rather than seven.
 */
const FILE_STANDING: Record<ArchitectureImpactFileState, "projected" | "out-of-scope" | "unread"> = {
  "in-projection": "projected",
  "not-source": "out-of-scope",
  deleted: "out-of-scope",
  "too-large": "unread",
  "request-budget": "unread",
  "unsupported-language": "unread",
  unparsed: "unread",
};

/** How many files the commit changed, and how many of them the reading held. */
function filesSummary(files: readonly ArchitectureImpactFile[]): string {
  const held = files.filter((file) => file.state === "in-projection").length;
  const counted = `${files.length} file${files.length === 1 ? "" : "s"}`;
  return held === 0 ? `${counted} · none in projection` : `${counted} · ${held} in projection`;
}

function stateClass(node: DiagramNode): string {
  return `arch-box-${stateKey(node)}`;
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
