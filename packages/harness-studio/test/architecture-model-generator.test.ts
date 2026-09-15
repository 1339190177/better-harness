import { describe, expect, it } from "vitest";
import { generateArchitectureModel } from "../src/server/architecture-model-generator.js";

/** Narrow the opaque `modelJson` to the shape the generator promises. */
function elements(modelJson: unknown): Array<{ id: string; name: string; kind: string; tags: string[]; parent_id: string | null }> {
  return (modelJson as { elements: Array<{ id: string; name: string; kind: string; tags: string[]; parent_id: string | null }> }).elements;
}

describe("generateArchitectureModel", () => {
  it("derives one system, a container per manifest, and components only for source directories", () => {
    const generated = generateArchitectureModel({
      repoName: "demo",
      trackedPaths: [
        "packages/api/package.json",
        "packages/api/src/handler.ts",
        "packages/api/src/router.ts",
        "packages/api/docs/readme.md",
        "packages/web/package.json",
        "packages/web/src/app.tsx",
      ],
      manifests: [
        { path: "packages/api/package.json", name: "@demo/api" },
        { path: "packages/web/package.json", name: "@demo/web" },
      ],
    });
    const els = elements(generated.modelJson);
    const system = els.filter((element) => element.kind === "SoftwareSystem");
    const containers = els.filter((element) => element.kind === "Container");
    const components = els.filter((element) => element.kind === "Component");

    expect(system).toHaveLength(1);
    expect(system[0]!.parent_id).toBeNull();
    // One container per manifest boundary; each parented to the system.
    expect(containers.map((element) => element.name).sort()).toEqual(["@demo/api", "@demo/web"]);
    expect(containers.every((element) => element.parent_id === system[0]!.id)).toBe(true);
    // A component grounds in a source directory (`src`), never in a docs one.
    expect(components.map((element) => element.name)).toContain("src");
    expect(components.some((element) => element.name === "docs")).toBe(false);
    // Every generated element is tagged so it is never read as an authored fact.
    expect(els.every((element) => element.tags.includes("generated"))).toBe(true);
  });

  it("binds every element to a path glob that exists in the tracked set", () => {
    const generated = generateArchitectureModel({
      repoName: "demo",
      trackedPaths: ["packages/api/package.json", "packages/api/src/handler.ts"],
      manifests: [{ path: "packages/api/package.json", name: "api" }],
    });
    for (const binding of generated.bindings) {
      const prefix = binding.pathGlob.replace(/\/\*\*$/u, "").replace(/^\*\*$/u, "");
      expect(binding.elementId).not.toBe("");
      if (prefix !== "") {
        expect(["packages/api/package.json", "packages/api/src/handler.ts"].some((path) => path.startsWith(prefix))).toBe(true);
      }
    }
    // No relationships are invented for a generated model.
    expect((generated.modelJson as { relationships: unknown[] }).relationships).toEqual([]);
  });

  it("is a pure function: the same tracked set always yields the same model", () => {
    const input = {
      repoName: "demo",
      trackedPaths: ["packages/a/package.json", "packages/a/src/x.ts", "packages/b/package.json", "packages/b/src/y.ts"],
      manifests: [{ path: "packages/a/package.json" }, { path: "packages/b/package.json" }],
    };
    expect(generateArchitectureModel(input)).toEqual(generateArchitectureModel(input));
  });

  it("treats a repository with no nested manifests as a single container", () => {
    const generated = generateArchitectureModel({
      repoName: "solo",
      trackedPaths: ["src/index.ts", "src/util.ts", "README.md"],
      manifests: [{ path: "package.json", name: "solo" }],
    });
    const els = elements(generated.modelJson);
    expect(els.filter((element) => element.kind === "Container")).toHaveLength(1);
    // The lone container binds the whole repository, not a stray `/**`.
    expect(generated.bindings.some((binding) => binding.pathGlob === "**")).toBe(true);
    expect(generated.bindings.every((binding) => !binding.pathGlob.startsWith("/"))).toBe(true);
  });

  it("ignores build output and dependency directories when grounding components", () => {
    const generated = generateArchitectureModel({
      repoName: "demo",
      trackedPaths: [
        "packages/api/package.json",
        "packages/api/src/handler.ts",
        "packages/api/node_modules/dep/index.js",
        "packages/api/dist/bundle.js",
      ],
      manifests: [{ path: "packages/api/package.json", name: "api" }],
    });
    const componentBindings = generated.bindings.map((binding) => binding.pathGlob);
    expect(componentBindings.some((glob) => glob.includes("node_modules"))).toBe(false);
    expect(componentBindings.some((glob) => glob.includes("dist"))).toBe(false);
  });
});
