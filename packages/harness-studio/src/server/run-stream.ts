import type { IncomingMessage, ServerResponse } from "node:http";
import { runHarness, type HarnessExecutorFactory } from "@qoder-ai/harness/exec";
import {
  HARNESS_RUN_STREAM_EVENT_KIND,
  parseHarnessRunRequestV1,
  type HarnessRunStreamEventV1,
} from "@qoder-ai/harness/protocol";
import { encodeSseData, readJsonBody, respondJson, sameOriginRequest } from "./http-utils.js";

export interface StudioRunStreamOptions {
  source: string;
  /** Already-read request, transformed by a trusted host route before streaming. */
  input?: unknown;
  harnessId?: string;
  runtimeId?: string;
  cwd?: string;
  sourceRoot?: string;
  executorFactory: HarnessExecutorFactory;
  /** The runner itself, injectable so a host can be tested against a run that throws. */
  run?: typeof runHarness;
  /** Invoked after request validation and before the executor is created. */
  onInput?: (input: { prompt: string; threadId: string; runId: string }) => void;
  runAbortSignal?: (runId: string) => AbortSignal | undefined;
  onClientDisconnect?: (runId: string) => void;
}

export async function streamHarnessRun(
  request: IncomingMessage,
  response: ServerResponse,
  options: StudioRunStreamOptions,
): Promise<void> {
  if (!sameOriginRequest(request)) {
    respondJson(response, 403, { error: "Cross-origin Harness runs are not allowed." });
    return;
  }
  if (!isJsonRequest(request)) {
    respondJson(response, 415, { error: "Harness runs require Content-Type: application/json." });
    return;
  }
  let input;
  try {
    input = parseHarnessRunRequestV1(options.input ?? await readJsonBody(request, 66_560));
  } catch (error) {
    respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    return;
  }

  options.onInput?.(input);
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-store",
    Connection: "keep-alive",
    "X-Content-Type-Options": "nosniff",
  });
  let sequence = 0;
  let terminal = false;
  const disconnect = (): void => {
    if (!terminal && !response.writableEnded) options.onClientDisconnect?.(input.runId);
  };
  /** One place builds the envelope, so a reason this host reports itself is a
   * stream event like any other rather than a sentence the reader never sees. */
  const emit = (event: HarnessRunStreamEventV1["event"]): void => {
    sequence += 1;
    if (event.type === "run-finished") terminal = true;
    const envelope: HarnessRunStreamEventV1 = {
      kind: HARNESS_RUN_STREAM_EVENT_KIND,
      threadId: input.threadId,
      runId: input.runId,
      sequence,
      event,
    };
    response.write(encodeSseData(envelope));
  };
  response.once("close", disconnect);
  try {
    const abortSignal = options.runAbortSignal?.(input.runId);
    await (options.run ?? runHarness)({
      source: options.source,
      prompt: input.prompt,
      threadId: input.threadId,
      runId: input.runId,
      onRunEvent: emit,
      ...(options.harnessId === undefined ? {} : { harnessId: options.harnessId }),
      ...(options.runtimeId === undefined ? {} : { runtimeId: options.runtimeId }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.sourceRoot === undefined ? {} : { sourceRoot: options.sourceRoot }),
      ...(abortSignal === undefined ? {} : { abortSignal }),
      executorFactory: options.executorFactory,
    });
  } catch (error) {
    // A run that fails after the stream opened has no other channel. Without a
    // terminal event the reader sees a stream that simply stopped, and the reason
    // is lost on both sides.
    if (!terminal && !response.writableEnded && !response.destroyed) {
      emit({ type: "run-error", message: error instanceof Error ? error.message : "The run failed." });
    }
  } finally {
    response.removeListener("close", disconnect);
    if (!response.writableEnded) response.end();
  }
}

function isJsonRequest(request: IncomingMessage): boolean {
  const header = request.headers["content-type"];
  const value = Array.isArray(header) ? header[0] : header;
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}
