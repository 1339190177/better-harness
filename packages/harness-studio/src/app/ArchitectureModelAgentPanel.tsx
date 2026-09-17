import { PromptInput, PromptInputFooter, PromptInputSubmit, PromptInputTextarea, PromptInputTools } from "./components/ai-elements/prompt-input.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "@phosphor-icons/react/X";
import { AcpComposer } from "./run/AcpComposer.js";
import { AcpSessionSettings } from "./run/AcpSessionSettings.js";
import { AcpSessionStream } from "./run/AcpSessionStream.js";
import { createAcpSessionActions } from "./run/acp-session-actions.js";
import { postAcpRunAction } from "./run/acp-run-actions.js";
import { useAcpSession } from "./run/use-acp-session.js";

export interface ArchitectureAcpAgent { id: string; label: string; available: boolean; unavailableReason?: string }

/**
 * Generate the architecture model with an agent, fenced to the architecture
 * directory.
 *
 * This reuses the same ACP conversation surface the memory analysis panel uses:
 * a run is started with the generated candidate injected as evidence, the agent
 * writes `model.json`/`bindings.json` into `.better-harness/architecture/`, and
 * a reader can then reopen the commit to project onto the confirmed model. The
 * default prompt asks the agent to refine the candidate; the reader can add
 * instructions before starting or in follow-up turns.
 */
export function ArchitectureModelAgentPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [agents, setAgents] = useState<ArchitectureAcpAgent[]>([]);
  const [agentId, setAgentId] = useState("");
  const [draft, setDraft] = useState("Refine the generated candidate into a confirmed architecture model and write it into the architecture directory.");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string>();
  const input = useRef<HTMLTextAreaElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  // The same prepared-session mechanism the Compare lanes use, for one Agent.
  const { state, active, connect, stop } = useAcpSession("arch");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/git/architecture/agents", { cache: "no-store" });
        const payload = await response.json() as { agents?: ArchitectureAcpAgent[] };
        if (cancelled) return;
        const list = payload.agents ?? [];
        setAgents(list);
        setAgentId(list.find((agent) => agent.available)?.id ?? "");
      } catch { /* the composer shows the unavailable state below */ }
    })();
    input.current?.focus();
    return () => { cancelled = true; };
  }, []);

  const actions = useMemo(() => state.runId ? createAcpSessionActions(state.runId) : undefined, [state.runId]);

  function connectAgent(): void {
    if (active || !agentId) return;
    void connect({ endpoint: "/api/git/architecture/acp/stream", prompt: JSON.stringify({ agentId }) });
  }

  async function sendInitial(): Promise<void> {
    if (!state.acp.prepared || !actions || sending || !draft.trim()) return;
    setSending(true); setSendError(undefined);
    try { await actions.execute({ action: "start", prompt: draft }); }
    catch (error) { setSendError(error instanceof Error ? error.message : String(error)); }
    finally { setSending(false); }
  }

  const agentLabel = agents.find((agent) => agent.id === agentId)?.label;
  return (
    <aside className="arch-agent-panel" aria-label="Generate architecture model with AI" onKeyDown={(event) => { if (event.key === "Escape" && event.target === close.current) { event.stopPropagation(); onClose(); } }}>
      <div className="arch-agent-toolbar">
        <strong>Generate model with AI</strong>
        <button ref={close} type="button" onClick={onClose} aria-label="Close AI generation">
          <X size={15} />
        </button>
      </div>
      {state.runId
        ? <AcpSessionStream compact showComposer={false} autoStart={false} state={state} prompt="" actions={actions} agentId={agentId} onPermission={(requestId, optionId) => postAcpRunAction(state.runId!, { requestId, optionId })} />
        : <p className="arch-agent-intro">The agent refines the generated candidate and writes <code>model.json</code> and <code>bindings.json</code> into the architecture directory. Reopen the commit afterwards to project onto it.</p>}
      <footer className="arch-agent-composer">
        {active && state.conversation && !state.acp.prepared && actions
          ? <AcpComposer key={state.runId} compact sessionLabel={agentLabel} state={state} actions={actions} agentId={agentId} toolbar={<AcpSessionSettings session={state.acp} runId={state.runId} active={active} actions={actions} agentId={agentId} />} />
          : <div className="acp-composer">
            <PromptInput onSubmit={(event) => { event.preventDefault(); void sendInitial(); }}>
              <PromptInputTextarea ref={input} rows={3} aria-label="Instructions for the model agent" placeholder="Optional: how should the model be named or grouped?" value={draft} maxLength={8192} onValueChange={setDraft} />
              <PromptInputFooter>
                <PromptInputTools>
                  {active && actions
                    ? <AcpSessionSettings session={state.acp} runId={state.runId} active={active} actions={actions} agentId={agentId} />
                    : <select aria-label="Model agent" value={agentId} disabled={active} onChange={(event) => setAgentId(event.target.value)}>
                      {!agents.some((agent) => agent.available) && <option value="">No agent available</option>}
                      {agents.map((agent) => <option key={agent.id} value={agent.id} disabled={!agent.available}>{agent.label}</option>)}
                    </select>}
                </PromptInputTools>
                {!active
                  ? <button className="primary" type="button" disabled={!agentId} onClick={connectAgent}>Connect agent</button>
                  : <PromptInputSubmit label="Send" pending={sending} disabled={!state.acp.prepared || !active || sending || !draft.trim()} />}
              </PromptInputFooter>
              {active && <div className="acp-composer-caption"><span className="acp-composer-agent-label">{agentLabel}</span><button type="button" onClick={() => void stop()}>Close session</button></div>}
            </PromptInput>
          </div>}
        {sendError && <p role="alert">{sendError}</p>}
      </footer>
    </aside>
  );
}
