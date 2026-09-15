import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { StructuralDiffProvider } from "../../contracts/structural-diff.js";
import {
  createSupervisedRustHost,
  RustHostError,
  type RustHostFailure,
  type SupervisedRustHost,
} from "./rust-host-transport.js";

export const DIFF_HOST_PROTOCOL_VERSION = "diff-rust-1.0.0+jsonl-v1";

/** Which failure a caller is looking at, so the route can pick a status. */
export type RustDiffFailure = RustHostFailure;

export { RustHostError as RustDiffHostError };

export interface RustDiffHostOptions {
  readonly executable: string;
  readonly transport?: "stdio" | "nsxpc";
  readonly timeoutMs?: number;
  readonly spawnProcess?: (executable: string) => ChildProcessWithoutNullStreams;
}

export interface RustDiffHost extends StructuralDiffProvider {
  readonly processId: number | undefined;
  readonly bridgeProcessId: number | undefined;
  describe(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/**
 * One supervised diff-host process.
 *
 * Structural diffing is the heaviest native call in the app, so the host is
 * given a deadline per request and killed when it misses one: a parser wedged on
 * a pathological file must not take the Studio server with it. NSXPC never
 * silently falls back to stdio.
 */
export function createRustDiffHost(options: RustDiffHostOptions): RustDiffHost {
  const host: SupervisedRustHost = createSupervisedRustHost({
    ...options,
    label: "Diff host",
    protocolVersion: DIFF_HOST_PROTOCOL_VERSION,
    // A revision over the per-file bound is a refusal, not a host fault.
    classifyRefusal: (code) => (code === "limit/revision" ? "limit" : "call"),
  });
  return {
    get processId() { return host.processId; },
    get bridgeProcessId() { return host.bridgeProcessId; },
    describe: () => host.describe(),
    structuralDiff(params) {
      return host.call("diff.structural", params);
    },
    close: () => host.close(),
  };
}
