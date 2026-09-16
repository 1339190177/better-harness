import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { HARNESS_RUN_REQUEST_KIND, type HarnessRunStreamEventV1 } from "@qoder-ai/harness/protocol";
import { streamHarnessRun, type StudioRunStreamOptions } from "../src/server/run-stream.js";
import { decodeSseStream } from "./sse-test-utils.js";

/**
 * The stream is the only channel a run has, so what it does with a failure
 * decides whether a reader can ever learn the reason.
 */
let stop: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stop?.();
  stop = undefined;
});

/** One run request, carrying the fields the protocol requires. */
function runRequest(runId: string): string {
  return JSON.stringify({ kind: HARNESS_RUN_REQUEST_KIND, threadId: "thread-1", runId, prompt: "hello" });
}

async function stream(body: string, options: Pick<StudioRunStreamOptions, "run">): Promise<HarnessRunStreamEventV1[]> {
  const server = createServer((incoming: IncomingMessage, response: ServerResponse) => {
    void streamHarnessRun(incoming, response, {
      source: "language 0.3\n",
      // Injected runs never build an executor, so the factory is the harness's own refusal to be used.
      executorFactory: () => { throw new Error("this test injects the run"); },
      ...options,
    });
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  stop = () => new Promise<void>((closed) => server.close(() => closed()));
  const { port } = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${port}/api/runs/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return decodeSseStream<HarnessRunStreamEventV1>(await response.text());
}

describe("streamHarnessRun", () => {
  /**
   * A run that throws after the stream opened used to end the response with no
   * terminal event at all, which a reader can only report as "the stream stopped":
   * the reason reached neither the pane nor a log. It travels as an event now.
   */
  it("reports why a run failed, as the terminal event of its stream", async () => {
    const events = await stream(runRequest("run-1"), {
      run: () => { throw new Error("the ACP host refused the fence"); },
    });

    expect(events.map((entry) => entry.event)).toEqual([{ type: "run-error", message: "the ACP host refused the fence" }]);
    expect(events[0]!.sequence).toBe(1);
    expect(events[0]!.runId).toBe("run-1");
  });

  it("leaves a run that finishes to end its own stream", async () => {
    const events = await stream(runRequest("run-2"), {
      run: async ({ onRunEvent }) => {
        onRunEvent({ type: "run-finished", exitCode: 0 });
        return { ok: true };
      },
    });

    expect(events.map((entry) => entry.event.type)).toEqual(["run-finished"]);
  });
});
