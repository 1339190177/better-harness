import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { GitCommit } from "@phosphor-icons/react/GitCommit";
import { SpinnerGap } from "@phosphor-icons/react/SpinnerGap";
import { isGitLogPage, type GitHistoryCommit } from "../contracts/git-history.js";
import { ArchitectureImpactView } from "./ArchitectureImpactView.js";
import { ArchitectureModelAgentPanel } from "./ArchitectureModelAgentPanel.js";
import { PaneSash } from "./shell/PaneSash.js";

interface Props {
  /** Whether a native architecture host is staged; without one there is nothing to project. */
  hostAvailable: boolean;
}

/** How many commits the picker holds at once. It is a chooser, not the history view. */
const PAGE_SIZE = 60;
/** The generation pane's own column: what a transcript and its composer need. */
const AGENT_WIDTH = { default: 360, min: 280 };
/** What the columns beside the pane keep before it yields: the projection is the reading. */
const PICKER_MIN_WIDTH = 260;
const PROJECTION_MIN_WIDTH = 240;
const SASH_WIDTH = 6;
/** Below this a three-column surface starves both readings, so the chooser yields first. */
const AGENT_COMPACT_WIDTH = 1000;
/** Below this one reading fits at a time, so the pane the run writes for takes the surface. */
const AGENT_NARROW_WIDTH = 760;

/**
 * The commit's projection onto the declared architecture, as a surface of its own.
 *
 * Commits answers "what happened"; this answers "what did one of them move". They
 * are different questions with different shapes — the history workbench is three
 * panes wide, and a projection needs the whole pane it is drawn in — so the
 * projection lives here and the history view keeps only history.
 */
export function ImpactView({ hostAvailable }: Props): React.JSX.Element {
  const { t } = useTranslation("git");
  const [commits, setCommits] = useState<GitHistoryCommit[]>([]);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [selectedSha, setSelectedSha] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string>();
  const [revision, setRevision] = useState(0);
  /** Whether the model-generation pane is open beside the projection. */
  const [agentOpen, setAgentOpen] = useState(false);
  /** The pane's width as the reader last set it, before it is fitted to the surface. */
  const [agentWant, setAgentWant] = useState(AGENT_WIDTH.default);
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const request = useRef(0);
  const list = useRef<HTMLUListElement>(null);
  const root = useRef<HTMLElement>(null);
  const agentTrigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const timer = globalThis.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => globalThis.clearTimeout(timer);
  }, [searchInput]);

  // The pane's column is bounded by the surface it sits in, and a sidebar or a
  // drawer decides how wide that is, so the frame is measured rather than assumed.
  useEffect(() => {
    const element = root.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => setFrame({ width: entry!.contentRect.width, height: entry!.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const requestId = ++request.current;
    setLoading(true);
    setFailure(undefined);
    void (async () => {
      try {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (search !== "") params.set("search", search);
        const response = await fetch(`/api/git/log?${params}`, { cache: "no-store" });
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error(apiError(payload, t("errors.historyUnavailable")));
        if (!isGitLogPage(payload)) throw new Error("Git history uses an unsupported contract.");
        if (cancelled || requestId !== request.current) return;
        setCommits(payload.commits);
        // The newest commit is what a reader means by "this project's change", so
        // the surface opens on a reading rather than on an empty pane.
        setSelectedSha((current) => current !== undefined && payload.commits.some((commit) => commit.sha === current)
          ? current
          : payload.commits[0]?.sha);
      } catch (error) {
        if (!cancelled && requestId === request.current) setFailure(error instanceof Error ? error.message : t("errors.historyUnavailable"));
      } finally {
        if (!cancelled && requestId === request.current) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [search, revision, t]);

  const selected = commits.find((commit) => commit.sha === selectedSha);
  // Before the frame is measured the stylesheet's own default stands, so the pane
  // opens at its intended width rather than at a width guessed from zero.
  const measured = frame.width > 0;
  const agentMax = measured ? Math.max(AGENT_WIDTH.min, frame.width - PICKER_MIN_WIDTH - PROJECTION_MIN_WIDTH - SASH_WIDTH) : AGENT_WIDTH.default;
  const agentWidth = Math.min(Math.max(agentWant, AGENT_WIDTH.min), agentMax);
  // Two readings still fit in a compact surface, one holds a narrow one. The
  // breakpoint is the surface's own width, not the window's.
  const agentSqueeze = agentOpen && measured && frame.width <= AGENT_COMPACT_WIDTH
    ? frame.width <= AGENT_NARROW_WIDTH ? " agent-narrow" : " agent-compact"
    : "";

  /** Closing hands focus back to the trigger, so the pane is not a one-way door. */
  function closeAgent(): void {
    setAgentOpen(false);
    requestAnimationFrame(() => agentTrigger.current?.focus());
  }

  return (
    <main
      ref={root}
      className={`impact-view${agentOpen ? " has-agent" : ""}${agentSqueeze}`}
      style={measured ? { "--impact-agent-width": `${agentWidth}px` } as CSSProperties : undefined}
      aria-label={t("impact.aria")}
    >
      <section className="impact-picker" aria-label={t("impact.commits")}>
        <header className="git-pane-header"><strong>{t("impact.commits")}</strong>{!loading && <span>{commits.length}</span>}</header>
        <div className="impact-search">
          <input
            type="search"
            value={searchInput}
            placeholder={t("impact.search")}
            aria-label={t("impact.search")}
            onChange={(event) => setSearchInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") setSearchInput(""); }}
          />
        </div>
        {failure !== undefined
          ? <p className="impact-notice" role="alert">{failure} <button type="button" className="arch-btn" onClick={() => setRevision((current) => current + 1)}>{t("log.retry")}</button></p>
          : loading && commits.length === 0
            ? <p className="impact-notice" role="status"><SpinnerGap aria-hidden="true" size={14} className="spin" />{t("impact.loading")}</p>
            : commits.length === 0
              ? <p className="impact-notice">{t("impact.empty")}</p>
              : (
                <ul className="impact-commits" ref={list} onKeyDown={moveSelection}>
                  {commits.map((commit) => (
                    <li key={commit.sha}>
                      <button
                        type="button"
                        className="impact-commit"
                        aria-current={commit.sha === selectedSha}
                        onClick={() => setSelectedSha(commit.sha)}
                        tabIndex={commit.sha === selectedSha ? 0 : -1}
                        data-sha={commit.sha}
                      >
                        <span className="impact-commit-subject">{commit.summary}</span>
                        <span className="impact-commit-meta">
                          <code>{commit.shortSha}</code>
                          <span>{commit.authorName}</span>
                          <time dateTime={new Date(commit.authoredAt).toISOString()}>{formatDay(commit.authoredAt)}</time>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
      </section>
      <section className="impact-projection" aria-label={t("detail.title")}>
        {!hostAvailable
          ? <p className="impact-notice" role="status">{t("impact.hostUnavailable")}</p>
          : selectedSha === undefined
            ? <div className="impact-empty"><GitCommit aria-hidden="true" size={24} /><p>{t("impact.pick")}</p></div>
            : <ArchitectureImpactView key={selectedSha} sha={selectedSha} label={selected?.shortSha} agentTrigger={agentTrigger} agentOpen={agentOpen} onToggleAgent={() => setAgentOpen((open) => !open)} />}
      </section>
      {agentOpen && (
        <PaneSash
          invert
          orientation="vertical"
          label={t("panes.resizeImpactAgent")}
          size={agentWidth}
          min={AGENT_WIDTH.min}
          max={agentMax}
          fallback={AGENT_WIDTH.default}
          disabled={!measured}
          onSize={setAgentWant}
        />
      )}
      {agentOpen && (
        <div className="impact-agent-slot" id="impact-agent-panel">
          <ArchitectureModelAgentPanel onClose={closeAgent} />
        </div>
      )}
    </main>
  );

  /** Arrow keys walk the picker: a list of buttons still has to behave like one. */
  function moveSelection(event: React.KeyboardEvent<HTMLUListElement>): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const index = commits.findIndex((commit) => commit.sha === selectedSha);
    if (index === -1) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0
      : event.key === "End" ? commits.length - 1
        : Math.min(commits.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
    const sha = commits[next]?.sha;
    if (sha === undefined) return;
    setSelectedSha(sha);
    requestAnimationFrame(() => list.current?.querySelector<HTMLButtonElement>(`button[data-sha="${sha}"]`)?.focus());
  }
}

function formatDay(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10);
}

/** The server answers failures in one shape; the reader gets its message. */
function apiError(payload: unknown, fallback: string): string {
  if (typeof payload === "object" && payload !== null && typeof (payload as { error?: unknown }).error === "string") {
    return (payload as { error: string }).error;
  }
  return fallback;
}
