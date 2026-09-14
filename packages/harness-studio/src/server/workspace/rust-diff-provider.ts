import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createLineFramer } from "@qoder-ai/harness/exec";
import type { StructuralDiffProvider } from "../../contracts/structural-diff.js";

export const DIFF_HOST_PROTOCOL_VERSION = "diff-rust-1.0.0+jsonl-v1";
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_PENDING = 8;
/** One re-queue after another request killed the host; bounds restart storms. */
const MAX_RESTARTS = 1;

/** Which failure a caller is looking at, so the route can pick a status. */
export type RustDiffFailure = "unavailable" | "timeout" | "protocol" | "limit" | "call";

export class RustDiffHostError extends Error {
  constructor(message: string, readonly failure: RustDiffFailure) {
    super(message);
  }
}

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

interface Queued {
  readonly id: number;
  readonly method: string;
  readonly frame: string;
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  restarts: number;
}
interface Inflight extends Queued {
  readonly timer: ReturnType<typeof setTimeout>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  const transport = options.transport ?? "stdio";
  if (transport !== "stdio" && transport !== "nsxpc") throw new TypeError("Unknown diff transport.");
  if (options.executable.trim().length === 0) throw new Error("The diff host executable must be a non-empty path.");
  const timeoutMs = options.timeoutMs ?? 30_000;
  const launch = options.spawnProcess ?? ((executable: string) => spawn(executable, [], { stdio: "pipe", windowsHide: true }));
  let child: ChildProcessWithoutNullStreams | undefined;
  let sequence = 0;
  let closed = false;
  let transportProven = transport !== "nsxpc";
  let servicePid: number | undefined;
  let bridgePid: number | undefined;
  let inflight: Inflight | undefined;
  const queue: Queued[] = [];
  const framer = createLineFramer(MAX_FRAME_BYTES);

  /**
   * The host answers one request at a time, so only the in-flight request is
   * implicated in a failure. Queued requests were never written and carry no
   * side effect: re-queue them onto a fresh process instead of failing them for
   * another request's fault, and give up after MAX_RESTARTS so a host that
   * cannot run cannot spin up processes indefinitely.
   */
  const fail = (active: ChildProcessWithoutNullStreams, error: Error): void => {
    if (child !== active) return;
    child = undefined;
    const failed = inflight;
    inflight = undefined;
    if (failed) { clearTimeout(failed.timer); failed.reject(error); }
    active.kill("SIGKILL");
    for (const request of queue.splice(0)) {
      if (request.restarts >= MAX_RESTARTS) request.reject(error);
      else { request.restarts += 1; queue.push(request); }
    }
    pump();
  };
  /** Writes at most one request at a time so a deadline measures host work, not queue depth. */
  const pump = (): void => {
    if (inflight || queue.length === 0 || closed) return;
    const next = queue.shift()!;
    let active: ChildProcessWithoutNullStreams;
    try { active = start(); }
    catch (error) {
      next.reject(error instanceof Error ? error : new RustDiffHostError("Diff host could not start.", "unavailable"));
      pump();
      return;
    }
    const timer = setTimeout(
      () => fail(active, new RustDiffHostError(`Diff host ${next.method} timed out.`, "timeout")),
      timeoutMs,
    );
    inflight = { ...next, timer };
    active.stdin.write(`${next.frame}\n`, (error) => { if (error) fail(active, new RustDiffHostError("Diff host input closed.", "unavailable")); });
  };

  const start = (): ChildProcessWithoutNullStreams => {
    if (child) return child;
    framer.reset();
    const active = child = launch(options.executable);
    bridgePid = active.pid;
    active.stderr.resume();
    active.on("error", () => fail(active, new RustDiffHostError("Diff host could not start.", "unavailable")));
    active.stdin.on("error", () => fail(active, new RustDiffHostError("Diff host input closed.", "unavailable")));
    active.on("exit", () => fail(active, new RustDiffHostError("Diff host exited during a request.", "unavailable")));
    // No setEncoding: the framer splits bytes and decodes whole lines, which is
    // what keeps the frame budget honest for multi-byte source text.
    active.stdout.on("data", (chunk: Buffer) => {
      if (child !== active) return;
      const { lines, overflow } = framer.push(chunk);
      if (overflow) {
        fail(active, new RustDiffHostError("Diff host response exceeds its frame limit.", "limit"));
        return;
      }
      for (const line of lines) {
        if (line.trim() === "") continue;
        let value: unknown;
        try { value = JSON.parse(line); } catch {
          fail(active, new RustDiffHostError("Diff host returned malformed JSON.", "protocol"));
          return;
        }
        if (!record(value) || value.version !== 1) {
          fail(active, new RustDiffHostError("Diff host returned an invalid envelope.", "protocol"));
          return;
        }
        const event = record(value.event) ? value.event : undefined;
        if (event?.type === "transport") {
          if (
            transport !== "nsxpc"
            || event.transport !== "nsxpc"
            || !Number.isInteger(event.servicePid)
            || !Number.isInteger(event.bridgePid)
            || Number(event.servicePid) <= 0
            || event.servicePid === event.bridgePid
          ) {
            fail(active, new RustDiffHostError("The diff host did not prove an NSXPC service before its first frame; refusing a silent stdio fallback.", "protocol"));
            return;
          }
          transportProven = true;
          servicePid = Number(event.servicePid);
          bridgePid = Number(event.bridgePid);
          continue;
        }
        if (!transportProven) {
          fail(active, new RustDiffHostError("The diff host did not prove an NSXPC service before its first frame; refusing a silent stdio fallback.", "protocol"));
          return;
        }
        if (!Number.isSafeInteger(value.id)) {
          fail(active, new RustDiffHostError("Diff host returned an invalid envelope.", "protocol"));
          return;
        }
        const request = inflight;
        if (!request || request.id !== Number(value.id)) {
          fail(active, new RustDiffHostError("Diff host returned an unknown request id.", "protocol"));
          return;
        }
        clearTimeout(request.timer);
        inflight = undefined;
        if (record(value.error)) {
          request.reject(new RustDiffHostError(
            typeof value.error.message === "string" ? value.error.message : "Diff host request failed.",
            value.error.code === "limit/revision" ? "limit" : "call",
          ));
        } else if (!record(value.result)) {
          request.reject(new RustDiffHostError("Diff host returned an empty result.", "protocol"));
        } else {
          request.resolve(value.result);
        }
        pump();
      }
    });
    return active;
  };

  const call = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    if (closed) return Promise.reject(new RustDiffHostError("Diff host is closed.", "unavailable"));
    if (queue.length + (inflight ? 1 : 0) >= MAX_PENDING) return Promise.reject(new RustDiffHostError("Diff host queue is full.", "unavailable"));
    const id = ++sequence;
    const frame = JSON.stringify({ version: 1, id, method, params });
    if (Buffer.byteLength(frame, "utf8") > MAX_REQUEST_BYTES) return Promise.reject(new RustDiffHostError("Diff host request exceeds its frame limit.", "limit"));
    return new Promise((resolve, reject) => {
      queue.push({ id, method, frame, resolve, reject, restarts: 0 });
      pump();
    });
  };

  return {
    get processId() { return transport === "nsxpc" ? servicePid : child?.pid; },
    get bridgeProcessId() { return bridgePid; },
    async describe() {
      const result = await call("host.describe");
      if (result.protocol !== DIFF_HOST_PROTOCOL_VERSION) {
        throw new RustDiffHostError(`Unexpected diff host protocol: ${String(result.protocol)}`, "protocol");
      }
      return result;
    },
    structuralDiff(params) {
      return call("diff.structural", params);
    },
    async close() {
      if (closed) return;
      try { if (child) await call("shutdown"); } catch { /* process may already be gone */ }
      closed = true;
      // Read the child after the await: a request that timed out while shutdown was
      // queued restarts the host, and the process to reap is the current one.
      const active = child;
      child = undefined;
      const stopped = new RustDiffHostError("Diff host is closed.", "unavailable");
      if (inflight) { clearTimeout(inflight.timer); inflight.reject(stopped); inflight = undefined; }
      for (const request of queue.splice(0)) request.reject(stopped);
      active?.kill("SIGKILL");
    },
  };
}
