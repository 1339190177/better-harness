import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createLineFramer } from "@qoder-ai/harness/exec";

export const PTY_HOST_PROTOCOL_VERSION = "pty-rust-1.0.0+jsonl-v1";

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
/** Bound on concurrent unanswered requests; a terminal rarely needs many. */
const MAX_PENDING = 64;

/** Terminal output for one session; `data` is the raw master bytes. */
export interface PtyDataEvent {
  readonly ptyId: number;
  readonly data: Buffer;
}

/** One session ended. Exactly one of `code`/`signal` is non-null. */
export interface PtyExitEvent {
  readonly ptyId: number;
  readonly code: number | null;
  readonly signal: number | null;
}

export interface PtySpawnParams {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly rows?: number;
  readonly cols?: number;
  readonly term?: string;
}

export interface RustPtyHostOptions {
  readonly executable: string;
  readonly transport?: "stdio" | "nsxpc";
  readonly timeoutMs?: number;
  readonly spawnProcess?: (executable: string) => ChildProcessWithoutNullStreams;
}

export interface RustPtyHost {
  readonly processId: number | undefined;
  readonly bridgeProcessId: number | undefined;
  describe(): Promise<Record<string, unknown>>;
  spawn(params: PtySpawnParams): Promise<number>;
  write(ptyId: number, data: Buffer | string): Promise<number>;
  resize(ptyId: number, rows: number, cols: number): Promise<void>;
  signal(ptyId: number, signal: number): Promise<void>;
  closePty(ptyId: number): Promise<void>;
  /** Subscribe to terminal output; returns an unsubscribe. */
  onData(handler: (event: PtyDataEvent) => void): () => void;
  /** Subscribe to session exit; returns an unsubscribe. */
  onExit(handler: (event: PtyExitEvent) => void): () => void;
  close(): Promise<void>;
}

interface Pending {
  readonly method: string;
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * One supervised pty host, spoken as newline-delimited JSON.
 *
 * Unlike the request/reply capability hosts (diff, arch, evidence), this host is
 * duplex: `pty.data` and `pty.exit` arrive unsolicited on the child's schedule,
 * so it cannot ride `createSupervisedRustHost` — that transport rejects any
 * frame whose id does not match an in-flight request. Replies here are still
 * id-correlated with a deadline; event frames are dispatched to listeners. NSXPC
 * never silently falls back to stdio: the bridge must present a `transport`
 * frame before its first reply.
 */
export function createRustPtyHost(options: RustPtyHostOptions): RustPtyHost {
  const transport = options.transport ?? "stdio";
  if (transport !== "stdio" && transport !== "nsxpc") throw new TypeError("Unknown pty host transport.");
  if (options.executable.trim().length === 0) throw new Error("The pty host executable must be a non-empty path.");
  const timeoutMs = options.timeoutMs ?? 30_000;
  const launch = options.spawnProcess ?? ((executable: string) => spawn(executable, [], { stdio: "pipe", windowsHide: true }));

  const events = new EventEmitter();
  events.setMaxListeners(0);
  const framer = createLineFramer(MAX_FRAME_BYTES);
  const pending = new Map<number, Pending>();
  let child: ChildProcessWithoutNullStreams | undefined;
  let sequence = 0;
  let closed = false;
  let failure: Error | undefined;
  let transportProven = transport !== "nsxpc";
  let servicePid: number | undefined;
  let bridgePid: number | undefined;

  /** Fail every outstanding request; the host is not restarted mid-session. */
  const fail = (error: Error): void => {
    if (failure) return;
    failure = error;
    const active = child;
    child = undefined;
    for (const [, request] of pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    active?.kill("SIGKILL");
    events.emit("host-error", error);
  };

  const ingest = (chunk: Buffer): void => {
    const { lines, overflow } = framer.push(chunk);
    if (overflow) {
      fail(new Error("Pty host response exceeds its frame limit."));
      return;
    }
    for (const line of lines) {
      if (line.trim() === "") continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch {
        fail(new Error("Pty host returned malformed JSON."));
        return;
      }
      if (!record(value) || value.version !== 1) {
        fail(new Error("Pty host returned an invalid envelope."));
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
          fail(new Error("The pty host did not prove an NSXPC service before its first frame; refusing a silent stdio fallback."));
          return;
        }
        transportProven = true;
        servicePid = Number(event.servicePid);
        bridgePid = Number(event.bridgePid);
        continue;
      }
      if (!transportProven) {
        fail(new Error("The pty host did not prove an NSXPC service before its first frame; refusing a silent stdio fallback."));
        return;
      }
      if (event !== undefined) {
        dispatchEvent(event);
        continue;
      }
      if (!Number.isSafeInteger(value.id)) {
        fail(new Error("Pty host returned an invalid envelope."));
        return;
      }
      const request = pending.get(Number(value.id));
      if (!request) {
        fail(new Error("Pty host returned an unknown request id."));
        return;
      }
      pending.delete(Number(value.id));
      clearTimeout(request.timer);
      if (record(value.error)) {
        request.reject(new Error(typeof value.error.message === "string" ? value.error.message : "Pty host request failed."));
      } else if (!record(value.result)) {
        request.reject(new Error("Pty host returned an empty result."));
      } else {
        request.resolve(value.result);
      }
    }
  };

  const dispatchEvent = (event: Record<string, unknown>): void => {
    const ptyId = Number(event.ptyId);
    if (!Number.isSafeInteger(ptyId)) return;
    if (event.type === "pty.data" && typeof event.dataBase64 === "string") {
      events.emit("data", { ptyId, data: Buffer.from(event.dataBase64, "base64") } satisfies PtyDataEvent);
    } else if (event.type === "pty.exit") {
      const code = typeof event.code === "number" ? event.code : null;
      const signal = typeof event.signal === "number" ? event.signal : null;
      events.emit("exit", { ptyId, code, signal } satisfies PtyExitEvent);
    }
  };

  const start = (): ChildProcessWithoutNullStreams => {
    if (child) return child;
    if (failure) throw failure;
    framer.reset();
    const active = child = launch(options.executable);
    bridgePid = active.pid;
    active.stderr.resume();
    active.on("error", () => fail(new Error("The pty host could not start.")));
    active.stdin.on("error", () => fail(new Error("The pty host closed its input.")));
    active.on("exit", () => fail(new Error("The pty host exited.")));
    // No setEncoding: the framer splits bytes and decodes whole lines, keeping
    // the frame budget honest for multi-byte terminal output.
    active.stdout.on("data", (chunk: Buffer) => { if (child === active) ingest(chunk); });
    return active;
  };

  const call = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    if (closed) return Promise.reject(new Error("Pty host is closed."));
    if (failure) return Promise.reject(failure);
    if (pending.size >= MAX_PENDING) return Promise.reject(new Error("Pty host request queue is full."));
    let active: ChildProcessWithoutNullStreams;
    try { active = start(); } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error("The pty host could not start."));
    }
    const id = ++sequence;
    const frame = JSON.stringify({ version: 1, id, method, params });
    if (Buffer.byteLength(frame, "utf8") > MAX_REQUEST_BYTES) {
      return Promise.reject(new Error("A pty host request exceeds its frame limit."));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`The pty host '${method}' request timed out.`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { method, resolve, reject, timer });
      active.stdin.write(`${frame}\n`, (error) => { if (error) fail(new Error("Writing to the pty host failed.")); });
    });
  };

  return {
    get processId() { return transport === "nsxpc" ? servicePid : child?.pid; },
    get bridgeProcessId() { return bridgePid; },
    async describe() {
      const result = await call("host.describe");
      if (result.protocol !== PTY_HOST_PROTOCOL_VERSION) {
        throw new Error(`Unexpected pty host protocol: ${String(result.protocol)}`);
      }
      return result;
    },
    async spawn(params) {
      const result = await call("pty.spawn", {
        command: params.command,
        ...(params.args ? { args: [...params.args] } : {}),
        ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
        ...(params.env !== undefined ? { env: { ...params.env } } : {}),
        ...(params.rows !== undefined ? { rows: params.rows } : {}),
        ...(params.cols !== undefined ? { cols: params.cols } : {}),
        ...(params.term !== undefined ? { term: params.term } : {}),
      });
      const ptyId = Number(result.ptyId);
      if (!Number.isSafeInteger(ptyId)) throw new Error("Pty host returned an invalid ptyId.");
      return ptyId;
    },
    async write(ptyId, data) {
      const buffer = typeof data === "string" ? Buffer.from(data, "utf8") : data;
      const result = await call("pty.write", { ptyId, dataBase64: buffer.toString("base64") });
      return Number(result.written) || 0;
    },
    async resize(ptyId, rows, cols) {
      await call("pty.resize", { ptyId, rows, cols });
    },
    async signal(ptyId, signal) {
      await call("pty.signal", { ptyId, signal });
    },
    async closePty(ptyId) {
      await call("pty.close", { ptyId });
    },
    onData(handler) {
      events.on("data", handler);
      return () => events.off("data", handler);
    },
    onExit(handler) {
      events.on("exit", handler);
      return () => events.off("exit", handler);
    },
    async close() {
      if (closed) return;
      try { if (child) await call("shutdown"); } catch { /* process may already be gone */ }
      closed = true;
      const active = child;
      child = undefined;
      const stopped = new Error("Pty host is closed.");
      for (const [, request] of pending) { clearTimeout(request.timer); request.reject(stopped); }
      pending.clear();
      active?.kill("SIGKILL");
    },
  };
}
