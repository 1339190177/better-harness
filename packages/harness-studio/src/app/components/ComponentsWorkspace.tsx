import { AppWindow } from "@phosphor-icons/react/AppWindow";
import { ArrowClockwise } from "@phosphor-icons/react/ArrowClockwise";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { StudioConfig } from "../studio-shell-model.js";
import { studioApiError } from "../studio-api.js";
import { useStudioTheme } from "../studio-theme.js";
import { HostedComponent } from "./HostedComponent.js";

/** One record as the apps host publishes it (`GET /api/apps`, proxied by the shell). */
export interface StudioComponentRecord {
  name: string;
  displayName?: string;
  version?: string;
  description?: string;
  enabled?: boolean;
  backend_status?: { running?: boolean } | null;
  manifest?: {
    ui?: {
      entry?: string;
      pages?: ReadonlyArray<{ route?: string; label?: string }>;
    };
  };
}

/** Why the records could not be read, so the workbench can say which. */
type ComponentsLoadFailure = "not-configured" | "unreachable";

function entryOf(record: StudioComponentRecord): string | undefined {
  const entry = record.manifest?.ui?.entry;
  return typeof entry === "string" && entry !== "" ? entry : undefined;
}

async function readComponentsResponse(response: Response): Promise<{ records?: StudioComponentRecord[]; failure?: ComponentsLoadFailure }> {
  if (!response.ok) {
    let code = "";
    try {
      code = ((await response.json()) as { code?: string }).code ?? "";
    } catch {
      // A non-JSON body still falls through to the unreachable wording.
    }
    return { failure: code === "apps_host_not_configured" ? "not-configured" : "unreachable" };
  }
  const payload: unknown = await response.json();
  // The host answers with the record array itself, not a wrapper.
  return Array.isArray(payload) ? { records: payload as StudioComponentRecord[] } : { failure: "unreachable" };
}

/** A stable empty props object: HostedComponent treats a new reference as new props. */
const NO_PROPS: Record<string, unknown> = {};

/**
 * The Components workbench: the apps host's record list on the left, the
 * selected component's UI mounted on the right. Enable/disable talks to the
 * same lifecycle endpoints the host serves, so the sidebar's own state is the
 * only state.
 */
export function ComponentsWorkspace({ config }: { config: StudioConfig }): React.JSX.Element {
  const { t } = useTranslation("common");
  const theme = useStudioTheme();
  const [records, setRecords] = useState<StudioComponentRecord[]>();
  const [failure, setFailure] = useState<ComponentsLoadFailure>();
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [actionFailure, setActionFailure] = useState<string>();

  async function reload(): Promise<void> {
    if (!config.appsHostEnabled) {
      setFailure("not-configured");
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await readComponentsResponse(await fetch("api/apps", { headers: { accept: "application/json" } }));
      setRecords(result.records);
      setFailure(result.failure);
      if (result.records !== undefined) {
        // Keep the reader's selection when it still exists; otherwise land on
        // the first component so the pane is never pointlessly blank.
        setSelected((current) => result.records!.some((record) => record.name === current) ? current : result.records![0]?.name);
      }
    } catch {
      setFailure("unreachable");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // The enablement config changes only across a Studio restart, so one load
    // per mount is the whole story; reload stays out of the deps for that reason.
  }, []);

  async function setEnabled(record: StudioComponentRecord, enabled: boolean): Promise<void> {
    setBusy(record.name);
    setActionFailure(undefined);
    try {
      const response = await fetch(
        `api/apps/${encodeURIComponent(record.name)}/${enabled ? "enable" : "disable"}`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(await studioApiError(response));
      await reload();
    } catch (error) {
      setActionFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(undefined);
    }
  }

  const active = records?.find((record) => record.name === selected);
  const activeEntry = active === undefined ? undefined : entryOf(active);

  if (failure !== undefined) {
    return <div className="components-empty components-empty-frame" role="note">
      <strong>{failure === "not-configured" ? t("components.hostRequired") : t("components.unreachable")}</strong>
      <p>{failure === "not-configured" ? t("components.hostRequiredDetail") : t("components.unreachableDetail")}</p>
      {failure === "unreachable" && <button type="button" onClick={() => void reload()}>{t("components.retry")}</button>}
    </div>;
  }

  return <div className="components-workbench">
    <nav className="components-list" aria-label={t("components.listAria")}>
      <div className="components-list-toolbar">
        <span>{t("components.count", { count: records?.length ?? 0 })}</span>
        <button type="button" title={t("components.refresh")} aria-label={t("components.refresh")} disabled={loading} onClick={() => void reload()}>
          <ArrowClockwise aria-hidden="true" size={15} />
        </button>
      </div>
      {loading && records === undefined && <p className="components-list-note">{t("components.loading")}</p>}
      {records?.length === 0 && <p className="components-list-note">{t("components.empty")}</p>}
      {(records ?? []).map((record) => <button
        key={record.name}
        type="button"
        className="components-list-item"
        aria-current={record.name === selected}
        onClick={() => setSelected(record.name)}
      >
        <AppWindow aria-hidden="true" size={16} />
        <span className="components-list-name">
          <strong>{record.displayName ?? record.name}</strong>
          <small>{record.version === undefined ? record.name : `v${record.version}`}</small>
        </span>
        <span className={`components-list-state${record.enabled ? " is-enabled" : ""}`}>
          {record.enabled ? t("components.enabled") : t("components.disabled")}
        </span>
      </button>)}
    </nav>
    <section className="components-pane" aria-label={active === undefined ? t("components.paneAria") : active.displayName ?? active.name}>
      {active === undefined
        ? <div className="components-empty"><strong>{t("components.select")}</strong></div>
        : <>
          <header className="components-pane-header">
            <div className="components-pane-identity">
              <h2>{active.displayName ?? active.name}</h2>
              <small>{active.name}{active.version === undefined ? "" : ` · v${active.version}`}</small>
            </div>
            {active.backend_status !== null && active.backend_status !== undefined && (
              <span className={`components-backend${active.backend_status.running ? " is-running" : ""}`}>
                {active.backend_status.running ? t("components.backendRunning") : t("components.backendStopped")}
              </span>
            )}
            <button
              type="button"
              disabled={busy === active.name}
              onClick={() => void setEnabled(active, active.enabled !== true)}
            >
              {busy === active.name ? t("components.working") : active.enabled ? t("components.disable") : t("components.enable")}
            </button>
          </header>
          {actionFailure !== undefined && <p className="components-pane-failure" role="alert">{actionFailure}</p>}
          {activeEntry === undefined
            ? <div className="components-empty" role="note">
              <strong>{t("components.noUi")}</strong>
              <p>{t("components.noUiDetail")}</p>
            </div>
            : active.enabled !== true
              ? <div className="components-empty" role="note">
                <strong>{t("components.disabledTitle")}</strong>
                <p>{t("components.disabledDetail")}</p>
              </div>
              : <HostedComponent
                key={`${active.name}-${active.enabled === true}`}
                name={active.name}
                entry={activeEntry}
                props={NO_PROPS}
                theme={theme}
              />}
        </>}
    </section>
  </div>;
}
