import { describe, expect, it } from "vitest";
import { architectureBootstrapPrompt } from "../src/server/architecture-acp.js";

describe("architectureBootstrapPrompt", () => {
  const candidate = { elements: [{ id: "system", name: "demo", kind: "SoftwareSystem", tags: ["generated"], parent_id: null }], relationships: [] };
  const bindings = [{ pathGlob: "packages/api/**", elementId: "packages-api" }];
  const trackedPaths = [
    "packages/api/package.json",
    "packages/api/src/handler.ts",
    "packages/api/src/router.ts",
    "packages/api/README.md",
    "rust/core/Cargo.toml",
  ];

  it("carries the candidate, bindings, and grounded evidence the agent refines", () => {
    const prompt = architectureBootstrapPrompt({ candidate, bindings, trackedPaths, modelPath: "model.json", bindingsPath: "bindings.json" });
    const payload = JSON.parse(prompt.slice(prompt.indexOf("{")));
    expect(payload.candidateModel).toEqual(candidate);
    expect(payload.candidateBindings).toEqual([{ path_glob: "packages/api/**", element_id: "packages-api" }]);
    // Manifests are surfaced so the agent can name boundaries; a README is not one.
    expect(payload.manifests).toContain("packages/api/package.json");
    expect(payload.manifests).toContain("rust/core/Cargo.toml");
    expect(payload.manifests).not.toContain("packages/api/README.md");
    // Source directories ground component names; a docs-only path is excluded.
    expect(payload.sourceDirectories).toContain("packages/api/src");
    expect(payload.sourceDirectories).not.toContain("packages/api");
  });

  it("names the exact files the agent must write, and fences it to the working directory", () => {
    const prompt = architectureBootstrapPrompt({ candidate, bindings, trackedPaths, modelPath: "model.json", bindingsPath: "bindings.json" });
    expect(prompt).toContain("`model.json`");
    expect(prompt).toContain("`bindings.json`");
    expect(prompt).toContain("Do not write anywhere else.");
  });

  it("is a pure function of its inputs", () => {
    const input = { candidate, bindings, trackedPaths, modelPath: "model.json", bindingsPath: "bindings.json" };
    expect(architectureBootstrapPrompt(input)).toBe(architectureBootstrapPrompt(input));
  });
});
