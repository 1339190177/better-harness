import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HARNESS_RUN_REQUEST_KIND, parseHarnessRunRequestV1 } from "@qoder-ai/harness/protocol";
import { architectureBootstrapPrompt, architectureEvidencePack, writeArchitectureEvidence } from "../src/server/architecture-acp.js";

const candidate = { elements: [{ id: "system", name: "demo", kind: "SoftwareSystem", tags: ["generated"], parent_id: null }], relationships: [] };
const bindings = [{ pathGlob: "packages/api/**", elementId: "packages-api" }];
const trackedPaths = [
  "packages/api/package.json",
  "packages/api/src/handler.ts",
  "packages/api/src/router.ts",
  "packages/api/README.md",
  "rust/core/Cargo.toml",
];

/** What the run request the pane streams looks like for this evidence file. */
function runRequest(prompt: string) {
  return parseHarnessRunRequestV1({ kind: HARNESS_RUN_REQUEST_KIND, threadId: "architecture", runId: "arch-1", prompt });
}

describe("architectureEvidencePack", () => {
  it("carries the candidate, bindings, and grounded evidence the agent refines", () => {
    const payload = JSON.parse(architectureEvidencePack({ candidate, bindings, trackedPaths }));
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
});

describe("architectureBootstrapPrompt", () => {
  const input = { evidencePath: "candidate.json", modelPath: "model.json", bindingsPath: "bindings.json" };

  it("names the evidence the agent reads and the exact files it must write", () => {
    const prompt = architectureBootstrapPrompt(input);
    expect(prompt).toContain("`candidate.json`");
    expect(prompt).toContain("`model.json`");
    expect(prompt).toContain("`bindings.json`");
    expect(prompt).toContain("Do not write anywhere else.");
  });

  it("is a pure function of its inputs", () => {
    expect(architectureBootstrapPrompt(input)).toBe(architectureBootstrapPrompt(input));
  });

  /**
   * The pack is the file, not the prompt: a real monorepo's candidate is past the
   * run protocol's 65_536-character bound on its own, and a prompt that carried it
   * would make the session refuse to start.
   */
  it("keeps a large project's candidate out of the prompt the protocol accepts", () => {
    const large = {
      elements: Array.from({ length: 200 }, (_, index) => ({
        id: `element-${index}`,
        name: `Element ${index}`,
        kind: "Component",
        description: "A boundary that explains itself at length. ".repeat(10),
        technology: "TypeScript",
        tags: ["generated"],
        parent_id: null,
      })),
      relationships: [],
    };
    const manyPaths = Array.from({ length: 1400 }, (_, index) => `packages/pkg-${index % 40}/src/module-${index}.ts`);
    expect(architectureEvidencePack({ candidate: large, bindings: [], trackedPaths: manyPaths }).length).toBeGreaterThan(65_536);
    expect(runRequest(architectureBootstrapPrompt(input)).prompt.length).toBeLessThanOrEqual(65_536);
  });
});

describe("writeArchitectureEvidence", () => {
  it("writes the pack inside the fence, and leaves a file the reader already had alone", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arch-evidence-"));
    try {
      expect(await writeArchitectureEvidence(directory, '{"pack":1}', "arch_abc-123")).toBe("candidate.json");
      expect(await readFile(join(directory, "candidate.json"), "utf8")).toBe('{"pack":1}');
      // The second run finds the name taken: it scopes its own rather than replacing it.
      const scoped = await writeArchitectureEvidence(directory, '{"pack":2}', "arch_def-456");
      expect(scoped).toBe("candidate-archdef-456.json");
      expect(await readFile(join(directory, "candidate.json"), "utf8")).toBe('{"pack":1}');
      expect(await readFile(join(directory, scoped), "utf8")).toBe('{"pack":2}');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
