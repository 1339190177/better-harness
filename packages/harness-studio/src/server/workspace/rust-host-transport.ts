import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createLineFramer } from "@qoder-ai/harness/exec";

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
/**
 * What every capability host's `wire.rs` accepts on one request line. Sending
 * more is not a bounded refusal for the host: its stdio driver and its NSXPC
 * bridge both end the process. Capping here keeps an oversized request a local
 * `limit` failure, measured against the limit the host actually enforces.
 */
const DEFAULT_MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_PENDING = 8;
/** One re-queue after another request killed the host; bounds restart storms. */
const MAX_RESTARTS = 1;

/** Which failure a caller is looking at, so a route can pick a status. */
export type RustHostFailure = "unavailable" | "timeout" | "protocol" | "limit" | "call";

export class RustHostError extends Error {
  constructor(message: string, readonly failure: RustHostFailure) {
    super(message);
  }
}

export interface SupervisedRustHostOptions {
  readonly executable: string;
  readonly transport?: "stdio" | "nsxpc";
  readonly timeoutMs?: number;
  readonly spawnProcess?: (executable: string) => ChildProcessWithoutNullStreams;
  /** One request line's byte budget; defaults to what the hosts themselves accept. */
  readonly maxRequestBytes?: number;
  /** How this host names itself in every error it raises, e.g. `"Diff host"`. */
  readonly label: string;
  /** The version `host.describe` must report; another host's version is a fault. */
  readonly protocolVersion: string;
  /** Classify one per-request refusal code into a failure kind. */
  readonly classifyRefusal?: (code: unknown) => RustHostFailure;
}

export interface SupervisedRustHost {
  readonly processId: number | undefined;
  readonly bridgeProcessId: number | undefined;
  describe(): Promise<Record<string, unknown>>;
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
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
 * One supervised native capability host, spoken as newline-delimited JSON.
 *
 * Every `${label}` host in this app — structural diff and architecture impact —
 * runs as the same shape: a single long-lived process answering one request at a
 * time with a per-request deadline, killed when it misses one, because a parser
 * wedged on a pathological file must not take the Studio server with it. NSXPC
 * never silently falls back to stdio.
 */
export function createSupervisedRustHost(options: SupervisedRustHostOptions): SupervisedRustHost {
  const transport = options.transport ?? "stdio";
  if (transport !== "stdio" && transport !== "nsxpc") throw new TypeError("Unknown host transport.");
  if (options.executable.trim().length === 0) throw new Error("The host executable must be a non-empty path.");
  const label = options.label;
  const lower = label.toLowerCase();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const classifyRefusal = options.classifyRefusal ?? (() => "call" as const);
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
      next.reject(error instanceof Error ? error : new RustHostError(`${label} could not start.`, "unavailable"));
      pump();
      return;
    }
    const timer = setTimeout(
      () => fail(active, new RustHostError(`${label} ${next.method} timed out.`, "timeout")),
      timeoutMs,
    );
    inflight = { ...next, timer };
    active.stdin.write(`${next.frame}\n`, (error) => { if (error) fail(active, new RustHostError(`${label} input closed.`, "unavailable")); });
  };

  const start = (): ChildProcessWithoutNullStreams => {
    if (child) return child;
    framer.reset();
    const active = child = launch(options.executable);
    bridgePid = active.pid;
    active.stderr.resume();
    active.on("error", () => fail(active, new RustHostError(`${label} could not start.`, "unavailable")));
    active.stdin.on("error", () => fail(active, new RustHostError(`${label} input closed.`, "unavailable")));
    active.on("exit", () => fail(active, new RustHostError(`${label} exited during a request.`, "unavailable")));
    // No setEncoding: the framer splits bytes and decodes whole lines, which is
    // what keeps the frame budget honest for multi-byte source text.
    active.stdout.on("data", (chunk: Buffer) => {
      if (child !== active) return;
      const { lines, overflow } = framer.push(chunk);
      if (overflow) {
        fail(active, new RustHostError(`${label} response exceeds its frame limit.`, "limit"));
        return;
      }
      for (const line of lines) {
        if (line.trim() === "") continue;
        let value: unknown;
        try { value = JSON.parse(line); } catch {
          fail(active, new RustHostError(`${label} returned malformed JSON.`, "protocol"));
          return;
        }
        if (!record(value) || value.version !== 1) {
          fail(active, new RustHostError(`${label} returned an invalid envelope.`, "protocol"));
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
            fail(active, new RustHostError(`The ${lower} did not prove an NSXPC service before its first frame; refusing a silent stdio fallback.`, "protocol"));
            return;
          }
          transportProven = true;
          servicePid = Number(event.servicePid);
          bridgePid = Number(event.bridgePid);
          continue;
        }
        if (!transportProven) {
          fail(active, new RustHostError(`The ${lower} did not prove an NSXPC service before its first frame; refusing a silent stdio fallback.`, "protocol"));
          return;
        }
        if (!Number.isSafeInteger(value.id)) {
          fail(active, new RustHostError(`${label} returned an invalid envelope.`, "protocol"));
          return;
        }
        const request = inflight;
        if (!request || request.id !== Number(value.id)) {
          fail(active, new RustHostError(`${label} returned an unknown request id.`, "protocol"));
          return;
        }
        clearTimeout(request.timer);
        inflight = undefined;
        if (record(value.error)) {
          request.reject(new RustHostError(
            typeof value.error.message === "string" ? value.error.message : `${label} request failed.`,
            classifyRefusal(value.error.code),
          ));
        } else if (!record(value.result)) {
          request.reject(new RustHostError(`${label} returned an empty result.`, "protocol"));
        } else {
          request.resolve(value.result);
        }
        pump();
      }
    });
    return active;
  };

  const call = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    if (closed) return Promise.reject(new RustHostError(`${label} is closed.`, "unavailable"));
    if (queue.length + (inflight ? 1 : 0) >= MAX_PENDING) return Promise.reject(new RustHostError(`${label} queue is full.`, "unavailable"));
    const id = ++sequence;
    const frame = JSON.stringify({ version: 1, id, method, params });
    if (Buffer.byteLength(frame, "utf8") > maxRequestBytes) return Promise.reject(new RustHostError(`${label} request exceeds its frame limit.`, "limit"));
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
      if (result.protocol !== options.protocolVersion) {
        throw new RustHostError(`Unexpected ${lower} protocol: ${String(result.protocol)}`, "protocol");
      }
      return result;
    },
    call,
    async close() {
      if (closed) return;
      try { if (child) await call("shutdown"); } catch { /* process may already be gone */ }
      closed = true;
      // Read the child after the await: a request that timed out while shutdown was
      // queued restarts the host, and the process to reap is the current one.
      const active = child;
      child = undefined;
      const stopped = new RustHostError(`${label} is closed.`, "unavailable");
      if (inflight) { clearTimeout(inflight.timer); inflight.reject(stopped); inflight = undefined; }
      for (const request of queue.splice(0)) request.reject(stopped);
      active?.kill("SIGKILL");
    },
  };
}
