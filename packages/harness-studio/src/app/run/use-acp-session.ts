import { useCallback, useEffect, useRef, useState } from "react";

import { applyHarnessRunEvent, initialRunState, settleRunState, type HarnessRunState } from "./run-store.js";
import { postAcpRunAction } from "./acp-run-actions.js";
import { streamRun, type StudioRunProjectBinding } from "./stream-run.js";

/**
 * One prepared ACP streaming session, folded into a Studio run projection.
 *
 * The Impact model generator and the Compare lanes both open a session this
 * way. Callers differ only in where the folded state lives — a single component
 * state, or one lane of a comparison — so the caller owns the fold target and
 * this owns the transport, the event reduction, and abort propagation.
 */
export interface AcpSessionStreamInput {
  endpoint: string;
  /** The transport request body; ACP prepare flows carry a placeholder here and
   * replace it with the reader's prompt through a `start` action later. */
  prompt: string;
  threadId: string;
  runId: string;
  project?: StudioRunProjectBinding;
  signal: AbortSignal;
  /** Fold the next batch of events into whatever state the caller keeps. */
  fold: (reduce: (state: HarnessRunState) => HarnessRunState) => void;
}

/** Open a prepared ACP session and fold its native event stream. Rejects with
 * the run's own reason so callers can surface it; aborting is not a failure. */
export async function streamAcpSession(input: AcpSessionStreamInput): Promise<void> {
  await streamRun(
    input.endpoint,
    input.prompt,
    input.threadId,
    input.runId,
    input.project,
    (events) => input.fold((state) => events.reduce(applyHarnessRunEvent, state)),
    input.signal,
  );
}

export interface AcpSessionConnectInput {
  endpoint: string;
  prompt: string;
  project?: StudioRunProjectBinding;
}

export interface AcpSession {
  state: HarnessRunState;
  active: boolean;
  connect(input: AcpSessionConnectInput): Promise<void>;
  stop(): Promise<void>;
}

/**
 * A single-agent ACP session bound to one component.
 *
 * The multi-agent Compare surface orchestrates many sessions imperatively and
 * calls {@link streamAcpSession} per lane; a single-session surface (the Impact
 * model generator) uses this hook so it never re-implements the connect, fold,
 * settle-on-error, and cancel-on-stop lifecycle.
 */
export function useAcpSession(idPrefix: string): AcpSession {
  const [state, setState] = useState<HarnessRunState>(initialRunState);
  const stateRef = useRef(state);
  const controller = useRef<AbortController | undefined>(undefined);

  const commit = useCallback((next: HarnessRunState): void => {
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(() => () => controller.current?.abort(), []);

  const connect = useCallback(async (input: AcpSessionConnectInput): Promise<void> => {
    if (stateRef.current.status === "running") return;
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    const runId = `${idPrefix}_${crypto.randomUUID()}`;
    const threadId = `${idPrefix}_${crypto.randomUUID()}`;
    commit({ ...initialRunState(), status: "running", runId, threadId });
    try {
      await streamAcpSession({
        endpoint: input.endpoint,
        prompt: input.prompt,
        threadId,
        runId,
        ...(input.project === undefined ? {} : { project: input.project }),
        signal: active.signal,
        fold: (reduce) => {
          if (active.signal.aborted) return;
          commit(reduce(stateRef.current));
        },
      });
    } catch (error) {
      if (active.signal.aborted) return;
      // The reason a session could not start is the one thing the reader has to
      // act on, so it is shown rather than replaced by a generic failure.
      commit(settleRunState(
        { ...stateRef.current, status: "error", error: error instanceof Error ? error.message : "The agent session failed." },
        "interrupted",
      ));
    }
  }, [commit, idPrefix]);

  const stop = useCallback(async (): Promise<void> => {
    const runId = stateRef.current.runId;
    if (runId) await postAcpRunAction(runId, "cancel").catch(() => undefined);
    controller.current?.abort();
    commit(settleRunState({ ...stateRef.current, status: "finished" }, "interrupted"));
  }, [commit]);

  return { state, active: state.status === "running", connect, stop };
}
