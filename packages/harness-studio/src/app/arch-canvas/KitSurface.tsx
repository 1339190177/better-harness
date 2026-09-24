import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CanvasKit, Surface } from "canvaskit-wasm";
import { buildLabels, type DiagramLayout, type DiagramView } from "./diagram-model.js";
import { readKitPaint, type KitPaint } from "./kit-paint.js";
import { drawDiagram } from "./kit-draw.js";

interface Props {
  canvasKit: CanvasKit;
  layout: DiagramLayout;
  selected: string | null;
  view: DiagramView;
  pane: { w: number; h: number };
  /** Skia could not be given a surface after all, so the pane must fall back. */
  onUnavailable: () => void;
}

/**
 * The diagram drawn by Skia, with its labels left to an overlay.
 *
 * CanvasKit has no system font manager and this app ships no font, so labels are
 * painted as DOM text in the same diagram space: they stay crisp at every zoom
 * and correct for non-Latin names, while the shapes, edges and legend are the
 * canvas's. Both are moved by the viewport the pane owns.
 */
export function KitSurface({ canvasKit, layout, selected, view, pane, onUnavailable }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const surfaceRef = useRef<{ surface: Surface; width: number; height: number } | null>(null);
  const [paint, setPaint] = useState<KitPaint | null>(null);
  const [themeTick, setThemeTick] = useState(0);
  const labels = useMemo(() => buildLabels(layout, selected), [layout, selected]);
  // Bounded so a very dense display cannot ask Skia for a texture it refuses.
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(pane.w * dpr));
  const height = Math.max(1, Math.round(pane.h * dpr));

  // The paint is the pane's own stylesheet, so a theme flip re-reads it.
  useEffect(() => {
    const observer = new MutationObserver(() => setThemeTick((tick) => tick + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    return () => observer.disconnect();
  }, []);

  // The paint is the pane's own stylesheet, so a theme flip re-reads it. A read
  // that fails cannot be drawn, so the pane is told to fall back rather than
  // leaving an empty canvas.
  useLayoutEffect(() => {
    try {
      setPaint(readKitPaint());
    } catch {
      onUnavailable();
    }
  }, [themeTick, onUnavailable]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || paint === null) return;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    let held = surfaceRef.current;
    if (held === null || held.width !== width || held.height !== height) {
      held?.surface.delete();
      const surface = canvasKit.MakeWebGLCanvasSurface(canvas);
      if (surface === null) {
        surfaceRef.current = null;
        onUnavailable();
        return;
      }
      held = { surface, width, height };
      surfaceRef.current = held;
    }
    drawDiagram(canvasKit, held.surface, { layout, view, selected, paint, dpr });
  }, [canvasKit, layout, view, selected, paint, dpr, width, height, onUnavailable]);

  // The surface draws into this canvas, so it is released with it.
  useEffect(() => () => {
    surfaceRef.current?.surface.delete();
    surfaceRef.current = null;
  }, []);

  return (
    <>
      <canvas ref={canvasRef} className="arch-kit-canvas" aria-hidden="true" />
      <div
        className="arch-kit-labels"
        aria-hidden="true"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transformOrigin: "0 0" }}
      >
        {labels.map((label) => (
          <span
            key={label.key}
            className={`arch-kit-label arch-kit-${label.role}${label.role === "boundary-title" ? ` arch-state-${label.state}` : ""}`}
            data-align={label.align}
            style={{ left: label.x, top: label.y }}
          >
            {label.text}
          </span>
        ))}
      </div>
    </>
  );
}
