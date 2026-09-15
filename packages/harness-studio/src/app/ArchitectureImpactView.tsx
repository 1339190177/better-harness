import { useCallback, useEffect, useRef, useState } from "react";
import { isArchitectureImpact, type ArchitectureImpact, type ArchitectureElement } from "../contracts/architecture-impact.js";
import { SpinnerGap } from "@phosphor-icons/react/SpinnerGap";

interface Props {
  sha: string;
}

interface LayoutNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  element: ArchitectureElement;
  layer: number;
  changed: boolean;
  observed: boolean;
}

const BOX_W = 180;
const BOX_H = 60;
const LAYER_GAP = 100;
const NODE_GAP = 20;
const MARGIN = { top: 20, right: 20, bottom: 20, left: 20 };

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
    const blob = new Blob([clone.outerHTML], { type: "image/svg+xml;charset=utf-8" });
    downloadBlob(blob, `${sha}.architecture.svg`);
  }, [sha]);

  if (loading) return <div className="arch-pane"><div className="arch-loading" role="status"><SpinnerGap aria-hidden="true" size={16} className="spin" /><span>Loading architecture impact...</span></div></div>;
  if (error) return <div className="arch-pane"><div className="arch-error">{error}</div></div>;
  if (!data) return null;

  const changedSet = new Set(data.changedHitIds);
  const observedSet = new Set(data.codeHitIds);
  const elMap = new Map(data.elements.map((e) => [e.id, e]));

  // Build hierarchy
  const childrenOf = new Map<string, ArchitectureElement[]>();
  const roots: ArchitectureElement[] = [];
  for (const el of data.elements) {
    if (el.parentId) {
      const siblings = childrenOf.get(el.parentId) ?? [];
      siblings.push(el);
      childrenOf.set(el.parentId, siblings);
    } else {
      roots.push(el);
    }
  }

  // Layered layout by BFS depth
  const nodes: LayoutNode[] = [];
  const queue: Array<{ id: string; layer: number }> = [];
  const visited = new Set<string>();
  const layerMap = new Map<number, LayoutNode[]>();

  for (const r of roots) { queue.push({ id: r.id, layer: 0 }); }
  while (queue.length > 0) {
    const { id, layer } = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const el = elMap.get(id);
    if (!el) continue;
    const changed = changedSet.has(id);
    const observed = observedSet.has(id);
    const node: LayoutNode = { id, x: 0, y: 0, w: BOX_W, h: BOX_H, element: el, layer, changed, observed };
    nodes.push(node);
    const layerNodes = layerMap.get(layer) ?? [];
    layerNodes.push(node);
    layerMap.set(layer, layerNodes);
    const kids = childrenOf.get(id) ?? [];
    for (const k of kids) { queue.push({ id: k.id, layer: layer + 1 }); }
  }

  // Position. Every layer is centred under the widest one, and the canvas is
  // sized from that width: sizing it from layer 0 alone leaves a container that
  // has children off-canvas, which reads as if the model were empty.
  const maxLayer = Math.max(0, ...layerMap.keys());
  const layerWidth = (nodes: LayoutNode[]): number => nodes.length === 0 ? 0 : nodes.length * BOX_W + (nodes.length - 1) * NODE_GAP;
  const widest = Math.max(0, ...[...layerMap.values()].map(layerWidth));
  for (const [layer, layerNodes] of layerMap) {
    const startX = MARGIN.left + (widest - layerWidth(layerNodes)) / 2;
    for (let i = 0; i < layerNodes.length; i++) {
      const n = layerNodes[i];
      n.x = startX + i * (BOX_W + NODE_GAP);
      n.y = MARGIN.top + layer * (BOX_H + LAYER_GAP);
    }
  }

  const svgW = Math.max(MARGIN.left + MARGIN.right + widest, 400);
  const svgH = MARGIN.top + MARGIN.bottom + (maxLayer + 1) * BOX_H + maxLayer * LAYER_GAP;

  // Declared edges
  const declaredEdges = data.relationships;
  // Observed edges (cross-component calls)
  const observedEdges = data.observedEdges;

  return (
    <div className="arch-pane" data-arch-sha={sha}>
      <div className="arch-header"><strong>Architecture Impact</strong><span>{data.elements.length} elements</span></div>
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
          viewBox={`0 0 ${svgW} ${svgH}`}
          className="arch-svg"
          xmlns="http://www.w3.org/2000/svg"
        >
          {/* Declared relationships */}
          {declaredEdges.map((rel) => {
            const src = nodes.find((n) => n.id === rel.sourceId);
            const tgt = nodes.find((n) => n.id === rel.targetId);
            if (!src || !tgt) return null;
            return (
              <line
                key={`rel-${rel.id}`}
                x1={src.x + BOX_W / 2}
                y1={src.y + BOX_H}
                x2={tgt.x + BOX_W / 2}
                y2={tgt.y}
                className="arch-edge-declared"
              />
            );
          })}
          {/* Observed edges (dashed, different color) */}
          {observedEdges.map((rel, i) => {
            const src = nodes.find((n) => n.id === rel.sourceId);
            const tgt = nodes.find((n) => n.id === rel.targetId);
            if (!src || !tgt) return null;
            return (
              <line
                key={`obs-${i}`}
                x1={src.x + BOX_W / 2}
                y1={src.y + BOX_H}
                x2={tgt.x + BOX_W / 2}
                y2={tgt.y}
                className="arch-edge-observed"
              />
            );
          })}
          {/* Element boxes */}
          {nodes.map((n) => (
            <g key={n.id}>
              <rect
                x={n.x}
                y={n.y}
                width={n.w}
                height={n.h}
                rx={4}
                className={
                  n.changed
                    ? "arch-box-changed"
                    : n.observed
                      ? "arch-box-observed"
                      : "arch-box-default"
                }
              />
              <text
                x={n.x + BOX_W / 2}
                y={n.y + BOX_H / 2}
                textAnchor="middle"
                dominantBaseline="middle"
                className="arch-label"
              >
                {n.element.name}
              </text>
              {/* Kind badge */}
              <text
                x={n.x + BOX_W / 2}
                y={n.y + BOX_H - 6}
                textAnchor="middle"
                className="arch-kind"
              >
                {n.element.kind}
              </text>
            </g>
          ))}
        </svg>
      </div>
    </div>
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