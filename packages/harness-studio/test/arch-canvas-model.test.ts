import { describe, expect, it } from "vitest";
import type { ArchitectureImpact } from "../src/contracts/architecture-impact.js";
import {
  BOUNDARY_HEADER,
  BOUNDARY_PAD,
  LEAF_H,
  LEAF_W,
  MARGIN,
  MIN_LEGIBLE_SCALE,
  anchors,
  buildLabels,
  buildLayout,
  fitView,
  pickNode,
  screenBox,
  stateKey,
  toDiagram,
  toScreen,
} from "../src/app/arch-canvas/diagram-model.js";

/**
 * A small reading: one system holding one container holding one component, a
 * sibling component outside it, and both a declared and an observed edge.
 */
const reading: ArchitectureImpact = {
  kind: "CommitArchitectureImpactV1",
  sha: "abc1234",
  status: "impact",
  elements: [
    { id: "sys", name: "Platform", kind: "SoftwareSystem", tags: [] },
    { id: "box", name: "Store", kind: "Container", tags: [], parentId: "sys" },
    { id: "leaf", name: "Loader", kind: "Component", tags: [], parentId: "box" },
    { id: "loose", name: "Caller", kind: "Component", tags: [] },
  ],
  relationships: [{ id: "r1", sourceId: "leaf", targetId: "loose", description: "calls", kind: "Imports" }],
  observedEdges: [{ id: "r2", sourceId: "leaf", targetId: "loose", kind: "ResolvedCall" }],
  codeHitIds: ["loose"],
  changedHitIds: ["leaf"],
  impactedHitIds: [],
  overlay: { changedSymbols: 1, impactedSymbols: 0, impactedFiles: [] },
  dsl: "",
  files: [],
  omitted: [],
};

/** An element the model never declared is not a drawn node; an edge to it is dropped. */
const withStranger: ArchitectureImpact = {
  ...reading,
  relationships: [...reading.relationships, { id: "r3", sourceId: "leaf", targetId: "missing", kind: "Imports" }],
};

describe("architecture diagram model", () => {
  it("nests elements under their declared parent and splits boundaries from leaves", () => {
    const layout = buildLayout(reading);
    expect(layout.boundaries.map((node) => node.element.id)).toEqual(["sys", "box"]);
    expect(layout.leaves.map((node) => node.element.id)).toEqual(["leaf", "loose"]);
    expect(layout.nodesById.size).toBe(4);
    // The container wraps its child: a header plus padding above the leaf.
    const box = layout.nodesById.get("box")!;
    expect(box.children.map((child) => child.element.id)).toEqual(["leaf"]);
    expect(box.box.h).toBeGreaterThanOrEqual(BOUNDARY_HEADER + BOUNDARY_PAD + LEAF_H);
  });

  it("treats an element whose parent is not declared as a root", () => {
    const orphaned: ArchitectureImpact = {
      ...reading,
      elements: reading.elements.map((element) => (element.id === "loose" ? { ...element, parentId: "ghost" } : element)),
    };
    const layout = buildLayout(orphaned);
    // A drawn child beats an invisible one, so the orphan is a root and a leaf.
    expect(layout.leaves.map((node) => node.element.id)).toContain("loose");
  });

  it("resolves both declared and observed edges and drops the ones it cannot place", () => {
    const layout = buildLayout(withStranger);
    expect(layout.edges.map((edge) => edge.relationship.id)).toEqual(["r1", "r2"]);
    expect(layout.edges.map((edge) => edge.observed)).toEqual([false, true]);
  });

  it("ranks changed over impacted over observed over untouched", () => {
    const layout = buildLayout({ ...reading, impactedHitIds: ["leaf", "box"] });
    expect(stateKey(layout.nodesById.get("leaf")!)).toBe("changed");
    expect(stateKey(layout.nodesById.get("box")!)).toBe("impacted");
    expect(stateKey(layout.nodesById.get("loose")!)).toBe("observed");
    expect(stateKey(layout.nodesById.get("sys")!)).toBe("untouched");
  });

  it("anchors an edge between the facing sides of two boxes", () => {
    const above = { x: 0, y: 0, w: 100, h: 40 };
    const below = { x: 0, y: 100, w: 100, h: 40 };
    expect(anchors(above, below)).toEqual([{ x: 50, y: 40 }, { x: 50, y: 100 }]);
    const left = { x: 0, y: 0, w: 40, h: 40 };
    const right = { x: 200, y: 0, w: 40, h: 40 };
    expect(anchors(left, right)).toEqual([{ x: 40, y: 20 }, { x: 200, y: 20 }]);
  });

  it("opens at the whole picture when it fits, and legibly when it does not", () => {
    const roomy = fitView({ w: 1200, h: 900 }, { width: 600, height: 300 });
    expect(roomy.scale).toBeGreaterThan(MIN_LEGIBLE_SCALE);
    expect(roomy.x).toBeGreaterThan(0);
    const cramped = fitView({ w: 200, h: 120 }, { width: 6000, height: 4000 });
    expect(cramped).toEqual({ scale: MIN_LEGIBLE_SCALE, x: 8, y: 8 });
  });

  it("round-trips a point between diagram and screen units", () => {
    const view = { scale: 0.5, x: 30, y: -10 };
    const diagram = { x: 200, y: 80 };
    expect(toScreen(diagram, view)).toEqual({ x: 130, y: 30 });
    expect(toDiagram(toScreen(diagram, view), view)).toEqual(diagram);
    // The card anchors to the element it describes, in the same units.
    expect(screenBox({ x: 200, y: 80, w: 40, h: 20 }, view)).toEqual({ x: 130, y: 30, w: 20, h: 10 });
  });

  it("picks the leaf under the pointer, else the innermost boundary, else nothing", () => {
    const layout = buildLayout(reading);
    const leaf = layout.nodesById.get("leaf")!;
    const box = layout.nodesById.get("box")!;
    expect(pickNode(layout, { x: leaf.box.x + leaf.box.w / 2, y: leaf.box.y + leaf.box.h / 2 })?.element.id).toBe("leaf");
    // Inside the container's own padding, which no leaf covers.
    expect(pickNode(layout, { x: box.box.x + 2, y: box.box.y + 2 })?.element.id).toBe("box");
    expect(pickNode(layout, { x: -1000, y: -1000 })).toBeUndefined();
  });

  it("labels boundaries at their header, leaves around their centre, and edges with their name", () => {
    const layout = buildLayout(reading);
    const labels = buildLabels(layout, "leaf");
    const byKey = new Map(labels.map((label) => [label.key, label]));

    const box = layout.nodesById.get("box")!;
    expect(byKey.get("boundary-box")).toMatchObject({
      text: "Store · Container", role: "boundary-title", x: box.box.x + 8, y: box.box.y + 15, align: "start",
    });

    const leaf = layout.nodesById.get("leaf")!;
    // The leaf under selection is the one the labels mark, in both of its lines.
    expect(byKey.get("leaf-name-leaf")).toMatchObject({
      text: "Loader", role: "leaf-name", x: leaf.box.x + LEAF_W / 2, y: leaf.box.y + leaf.box.h / 2 + 1, align: "center", selected: true, state: "changed",
    });
    expect(byKey.get("leaf-kind-leaf")).toMatchObject({ text: "Component", role: "leaf-kind", selected: true });
    expect(byKey.get("leaf-name-loose")?.selected).toBe(false);

    // Only a declared relationship with a description carries a label.
    expect(byKey.get("edge-r1")).toMatchObject({ text: "calls", role: "edge-label", align: "center" });
    expect(byKey.has("edge-r2")).toBe(false);
  });

  it("places every root inside the diagram margins", () => {
    const layout = buildLayout(reading);
    for (const node of [...layout.boundaries, ...layout.leaves]) {
      if (node.element.parentId !== undefined) continue;
      expect(node.box.x).toBe(MARGIN);
      expect(node.box.y).toBeGreaterThanOrEqual(MARGIN);
    }
    expect(layout.diagram.width).toBeGreaterThanOrEqual(820);
    expect(layout.diagram.height).toBeGreaterThan(0);
  });
});
