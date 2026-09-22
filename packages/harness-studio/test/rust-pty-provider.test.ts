import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createRustPtyHost,
  PTY_HOST_PROTOCOL_VERSION,
  type PtyDataEvent,
  type PtyExitEvent,
} from "../src/server/workspace/rust-pty-provider.js";

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  killed: boolean;
  kill: () => void;
}

interface FakeOptions {
  /** Emit an NSXPC transport-proof frame before any reply. */
  readonly transportProof?: { servicePid: number; bridgePid: number };
  /** Suppress the transport frame even in nsxpc mode, to test the guard. */
  readonly silentFallback?: boolean;
}

/**
 * A duplex fake: replies to requests by id and, on pty.spawn, streams a
 * pty.data chunk followed by a pty.exit — the ordering the real host guarantees.
 */
function fakePtyHost(options: FakeOptions = {}): { child: FakeChild; writes: Buffer[] } {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 9001;
  child.killed = false;
  child.kill = () => { if (child.killed) return; child.killed = true; child.emit("exit", 0); };
  const writes: Buffer[] = [];

  if (options.transportProof && !options.silentFallback) {
    // Written synchronously: the PassThrough buffers it until the client attaches
    // its reader, so the proof is delivered before any reply — the order the
    // real NSXPC service guarantees (proof on connect, before the first frame).
    child.stdout.write(
      `${JSON.stringify({ version: 1, event: { type: "transport", transport: "nsxpc", servicePid: options.transportProof.servicePid, bridgePid: options.transportProof.bridgePid } })}\n`,
    );
  }

  child.stdin.on("data", (chunk: Buffer | string) => {
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) continue;
      const request = JSON.parse(line) as { id: number; method: string; params: Record<string, unknown> };
      if (child.killed) continue;
      const ok = (result: object) => child.stdout.write(`${JSON.stringify({ version: 1, id: request.id, result })}\n`);
      const err = (code: string, message: string) => child.stdout.write(`${JSON.stringify({ version: 1, id: request.id, error: { code, message } })}\n`);
      switch (request.method) {
        case "host.describe":
          ok({ protocol: PTY_HOST_PROTOCOL_VERSION, pid: 9001, capabilities: ["pty.spawn"] });
          break;
        case "pty.spawn": {
          if ((request.params.command as string) === "/nope") { err("spawn-failed", "no such file"); break; }
          ok({ ptyId: 1 });
          // Stream output then exit, in order.
          child.stdout.write(`${JSON.stringify({ version: 1, event: { type: "pty.data", ptyId: 1, dataBase64: Buffer.from("hi\n").toString("base64") } })}\n`);
          child.stdout.write(`${JSON.stringify({ version: 1, event: { type: "pty.exit", ptyId: 1, code: 0, signal: null } })}\n`);
          break;
        }
        case "pty.write": {
          const decoded = Buffer.from(request.params.dataBase64 as string, "base64");
          writes.push(decoded);
          ok({ written: decoded.length });
          break;
        }
        case "pty.resize": ok({ ok: true }); break;
        case "pty.signal": ok({ ok: true }); break;
        case "pty.close": ok({ ok: true }); break;
        case "shutdown": ok({ status: "shutting-down" }); break;
        default: err("unknown-method", `unknown method ${request.method}`);
      }
    }
  });
  return { child, writes };
}

describe("native pty host provider", () => {
  it("describes its own protocol", async () => {
    const { child } = fakePtyHost();
    const host = createRustPtyHost({ executable: "/native/harness-pty-host", spawnProcess: () => child as never });
    try {
      await expect(host.describe()).resolves.toMatchObject({ protocol: PTY_HOST_PROTOCOL_VERSION });
    } finally { await host.close(); }
  });

  it("spawns, streams data then exit, and round-trips written bytes", async () => {
    const { child, writes } = fakePtyHost();
    const host = createRustPtyHost({ executable: "/native/harness-pty-host", spawnProcess: () => child as never });
    try {
      const data: PtyDataEvent[] = [];
      const exits: PtyExitEvent[] = [];
      host.onData((event) => data.push(event));
      host.onExit((event) => exits.push(event));

      const ptyId = await host.spawn({ command: "/bin/cat", args: ["-u"], rows: 24, cols: 80 });
      expect(ptyId).toBe(1);

      const written = await host.write(ptyId, "type me");
      expect(written).toBe(7);
      expect(writes.at(-1)!.toString("utf8")).toBe("type me");

      // Events flush on the next microtasks; wait a tick.
      await new Promise((resolve) => setImmediate(resolve));
      expect(data).toHaveLength(1);
      expect(data[0]!.ptyId).toBe(1);
      expect(data[0]!.data.toString("utf8")).toBe("hi\n");
      expect(exits).toEqual([{ ptyId: 1, code: 0, signal: null }]);
    } finally { await host.close(); }
  });

  it("propagates a spawn refusal as a rejected promise", async () => {
    const { child } = fakePtyHost();
    const host = createRustPtyHost({ executable: "/native/harness-pty-host", spawnProcess: () => child as never });
    try {
      await expect(host.spawn({ command: "/nope" })).rejects.toThrow(/no such file/);
    } finally { await host.close(); }
  });

  it("accepts nsxpc once the service proves itself and reports the service pid", async () => {
    const { child } = fakePtyHost({ transportProof: { servicePid: 4242, bridgePid: 9001 } });
    const host = createRustPtyHost({ executable: "/native/harness-pty-client", transport: "nsxpc", spawnProcess: () => child as never });
    try {
      await expect(host.describe()).resolves.toMatchObject({ protocol: PTY_HOST_PROTOCOL_VERSION });
      expect(host.processId).toBe(4242);
    } finally { await host.close(); }
  });

  it("refuses a silent stdio fallback under nsxpc", async () => {
    const { child } = fakePtyHost({ transportProof: { servicePid: 4242, bridgePid: 9001 }, silentFallback: true });
    const host = createRustPtyHost({ executable: "/native/harness-pty-client", transport: "nsxpc", spawnProcess: () => child as never });
    try {
      await expect(host.describe()).rejects.toThrow(/did not prove an NSXPC service/);
    } finally { await host.close(); }
  });
});
