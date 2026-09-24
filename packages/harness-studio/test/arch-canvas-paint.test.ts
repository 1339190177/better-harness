import { describe, expect, it } from "vitest";
import { parseColor, parseDash } from "../src/app/arch-canvas/kit-paint.js";

/**
 * The canvas takes its colours from the pane's stylesheet, so the parser must
 * read every shape a browser answers `getComputedStyle` with — including the
 * `color(srgb …)` a resolved `color-mix` becomes.
 */
describe("canvas paint parsing", () => {
  it("reads the hex a token is declared with", () => {
    expect(parseColor("#36363d")).toEqual({ r: 54, g: 54, b: 61, a: 1 });
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#11223344").a).toBeCloseTo(0x44 / 255, 5);
  });

  it("reads rgb and rgba, in both the comma and slash forms", () => {
    expect(parseColor("rgb(99, 168, 255)")).toEqual({ r: 99, g: 168, b: 255, a: 1 });
    expect(parseColor("rgba(233, 240, 255, 0.2)")).toEqual({ r: 233, g: 240, b: 255, a: 0.2 });
    expect(parseColor("rgb(99 168 255 / 0.5)")).toEqual({ r: 99, g: 168, b: 255, a: 0.5 });
  });

  it("reads the color(srgb …) a resolved color-mix takes", () => {
    expect(parseColor("color(srgb 1 0.572549 0.603922 / 0.08)")).toEqual({ r: 255, g: 146, b: 154, a: 0.08 });
    expect(parseColor("color(srgb 0.211765 0.211765 0.239216 / 0.45)")).toEqual({ r: 54, g: 54, b: 61, a: 0.45 });
  });

  it("draws nothing for an absent colour and grey for one it cannot read", () => {
    expect(parseColor("none")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseColor("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    // A colour this parser does not know is visible, not silently dropped.
    expect(parseColor("oklab(0.5 0.1 0.1)")).toEqual({ r: 128, g: 128, b: 128, a: 1 });
  });

  it("reads the dash the stroke-dasharray declares, and none when it is solid", () => {
    expect(parseDash("4px, 3px")).toEqual([4, 3]);
    expect(parseDash("5px 3px")).toEqual([5, 3]);
    expect(parseDash("none")).toEqual([]);
    expect(parseDash("")).toEqual([]);
    expect(parseDash("0px")).toEqual([]);
  });
});
