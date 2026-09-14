/**
 * Supervised arch-host process provider.
 *
 * Mirrors rust-diff-provider.ts using the same supervised single-process
 * pattern. The host answers one request at a time with a per-request deadline.
 */
import type { ArchitectureImpact, ArchitectureImpactProvider } from "../../contracts/architecture-impact.js";
import type { StructuralDiffProvider } from "../../contracts/structural-diff.js";

// Reuse the Rust host supervision from the diff provider.
// Both share the same JSONL transport and process lifecycle.
import { createRustDiffHost, type RustDiffHost } from "./rust-diff-provider.js";

export interface RustArchHostOptions {
  readonly executable: string;
  readonly timeoutMs?: number;
}

export function createRustArchHost(options: RustArchHostOptions): ArchitectureImpactProvider & { close(): Promise<void> } {
  const host = createRustDiffHost({
    executable: options.executable,
    transport: "stdio",
    timeoutMs: options.timeoutMs ?? 30_000,
  });

  return {
    async architectureImpact(params): Promise<ArchitectureImpact> {
      const raw = await host.structuralDiff({
        path: "/_", // dummy path, not opened
        before: JSON.stringify(params),
        after: "",
      });
      // The host processes this as an arch.snapshot call internally.
      // For the Studio integration path, we call via the host.describe
      // mechanism and route to arch.snapshot.
      // This is a placeholder: the actual integration will route the
      // request through the arch host's own dispatch.
      throw new Error("arch host integration in progress");
    },
    close: () => host.close(),
  };
}