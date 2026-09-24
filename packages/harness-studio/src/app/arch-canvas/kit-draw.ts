/**
 * Draws the diagram with CanvasKit, in the painting order the SVG uses.
 *
 * Text is not drawn here: CanvasKit has no system font to draw it with, so the
 * labels are positioned by `buildLabels` and painted by the DOM overlay beside
 * this canvas. Everything else — boundaries, edges, arrow heads, the state ring
 * and the legend's own shapes — is Skia's.
 */
import type { Canvas, CanvasKit, Paint, Path, Surface } from "canvaskit-wasm";
import {
  SWATCH_H,
  SWATCH_W,
  anchors,
  legendSpec,
  stateKey,
  type DiagramLayout,
  type DiagramNode,
  type DiagramView,
} from "./diagram-model.js";
import type { KitPaint, RGBA, ShapePaint } from "./kit-paint.js";

export interface DrawInput {
  layout: DiagramLayout;
  view: DiagramView;
  selected: string | null;
  paint: KitPaint;
  /** Device pixels per CSS pixel, so a diagram unit is a legible inch on screen. */
  dpr: number;
}

/** How far the arrow head reaches back along its own line, and its half-width. */
const ARROW_LENGTH = 7;
const ARROW_HALF = 3.5;

/**
 * The arrow head is one triangle in its own space, placed by the canvas
 * transform for each edge, so a frame allocates no path per relationship.
 */
function arrowTriangle(ck: CanvasKit): Path {
  const builder = new ck.PathBuilder();
  builder.moveTo(0, 0);
  builder.lineTo(-ARROW_LENGTH, ARROW_HALF);
  builder.lineTo(-ARROW_LENGTH, -ARROW_HALF);
  builder.close();
  const path = builder.detach();
  builder.delete();
  return path;
}

export function drawDiagram(ck: CanvasKit, surface: Surface, input: DrawInput): void {
  const canvas = surface.getCanvas();
  const paint = new ck.Paint();
  const arrow = arrowTriangle(ck);
  try {
    canvas.clear(ck.Color(0, 0, 0, 0));
    canvas.save();
    canvas.scale(input.dpr, input.dpr);
    canvas.translate(input.view.x, input.view.y);
    canvas.scale(input.view.scale, input.view.scale);

    // Boundaries paint before their contents, so a nested element is never hidden.
    for (const node of input.layout.boundaries) shapeNode(ck, canvas, paint, node, input, "boundary");
    for (const edge of input.layout.edges) {
      const [start, end] = anchors(edge.from.box, edge.to.box);
      const spec = edge.observed ? input.paint.edge.observed : input.paint.edge.declared;
      strokeLine(ck, canvas, paint, start, end, spec.stroke, spec.width, spec.dash);
      arrowHead(ck, canvas, paint, arrow, start, end, edge.observed ? input.paint.arrow.observed : input.paint.arrow.declared);
    }
    for (const node of input.layout.leaves) shapeNode(ck, canvas, paint, node, input, "leaf");
    drawLegend(ck, canvas, paint, arrow, input);

    canvas.restore();
    surface.flush();
  } finally {
    paint.delete();
    arrow.delete();
  }
}

function setColour(ck: CanvasKit, paint: Paint, rgba: RGBA): void {
  paint.setColor(ck.Color(rgba.r, rgba.g, rgba.b, rgba.a));
}

function setDash(ck: CanvasKit, paint: Paint, intervals: readonly number[]): void {
  paint.setPathEffect(intervals.length > 0 ? ck.PathEffect.MakeDash([...intervals], 0) : null);
}

function strokeLine(
  ck: CanvasKit, canvas: Canvas, paint: Paint,
  start: { x: number; y: number }, end: { x: number; y: number }, colour: RGBA, width: number, dash: readonly number[],
): void {
  paint.setAntiAlias(true);
  paint.setStyle(ck.PaintStyle.Stroke);
  setColour(ck, paint, colour);
  paint.setStrokeWidth(width);
  setDash(ck, paint, dash);
  canvas.drawLine(start.x, start.y, end.x, end.y, paint);
}

/** One node as the SVG draws it: a filled rounded rect that carries its state. */
function shapeNode(ck: CanvasKit, canvas: Canvas, paint: Paint, node: DiagramNode, input: DrawInput, role: "boundary" | "leaf"): void {
  const spec: ShapePaint = input.paint[role][stateKey(node)];
  const isSelected = node.element.id === input.selected;
  const rrect = ck.RRectXY(ck.LTRBRect(node.box.x, node.box.y, node.box.x + node.box.w, node.box.y + node.box.h), 6, 6);
  paint.setAntiAlias(true);
  paint.setPathEffect(null);
  paint.setStyle(ck.PaintStyle.Fill);
  setColour(ck, paint, spec.fill);
  canvas.drawRRect(rrect, paint);
  paint.setStyle(ck.PaintStyle.Stroke);
  if (isSelected) {
    // A selected node keeps its own fill and swaps the ring the stylesheet gives it.
    setColour(ck, paint, input.paint.selected.stroke);
    paint.setStrokeWidth(input.paint.selected.width);
    paint.setPathEffect(null);
  } else {
    setColour(ck, paint, spec.stroke);
    paint.setStrokeWidth(spec.width);
    // A boundary's frame is dashed; its state rule only recolours it.
    setDash(ck, paint, role === "boundary" ? spec.dash : []);
  }
  canvas.drawRRect(rrect, paint);
}

/** The triangle the SVG's marker draws: a head on the end of its own line. */
function arrowHead(
  ck: CanvasKit, canvas: Canvas, paint: Paint, triangle: Path,
  start: { x: number; y: number }, end: { x: number; y: number }, colour: RGBA,
): void {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return;
  paint.setAntiAlias(true);
  paint.setStyle(ck.PaintStyle.Fill);
  setColour(ck, paint, colour);
  paint.setPathEffect(null);
  canvas.save();
  canvas.translate(end.x, end.y);
  canvas.rotate((Math.atan2(dy, dx) * 180) / Math.PI, 0, 0);
  canvas.drawPath(triangle, paint);
  canvas.restore();
}

/** The legend's own shapes; its words are the overlay's labels. */
function drawLegend(ck: CanvasKit, canvas: Canvas, paint: Paint, arrow: Path, input: DrawInput): void {
  const legend = legendSpec(input.layout.diagram);
  for (const swatch of legend.swatches) {
    const spec = input.paint.leaf[swatch.state];
    const rrect = ck.RRectXY(ck.LTRBRect(swatch.x, swatch.y - 9, swatch.x + SWATCH_W, swatch.y - 9 + SWATCH_H), 3, 3);
    paint.setAntiAlias(true);
    paint.setPathEffect(null);
    paint.setStyle(ck.PaintStyle.Fill);
    setColour(ck, paint, spec.fill);
    canvas.drawRRect(rrect, paint);
    paint.setStyle(ck.PaintStyle.Stroke);
    setColour(ck, paint, spec.stroke);
    paint.setStrokeWidth(spec.width);
    setDash(ck, paint, spec.dash);
    canvas.drawRRect(rrect, paint);
  }
  for (const entry of legend.edges) {
    const start = { x: entry.x, y: entry.y - 2 };
    const end = { x: entry.x + SWATCH_W, y: entry.y - 2 };
    const spec = entry.observed ? input.paint.edge.observed : input.paint.edge.declared;
    strokeLine(ck, canvas, paint, start, end, spec.stroke, spec.width, spec.dash);
    arrowHead(ck, canvas, paint, arrow, start, end, entry.observed ? input.paint.arrow.observed : input.paint.arrow.declared);
  }
}
