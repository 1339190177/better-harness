import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  createAppSdk,
  type AppMount,
  type AppSdk,
} from "@qoder-ai/harness-studio-apps/client";
import type { StudioTheme } from "../studio-theme.js";

/**
 * Mounts one hosted component — an app's `ui/entry.mjs`, served by the apps
 * host under `/apps/<name>/ui/*` — and keeps the SDK the entry received in
 * sync. The mount itself happens once per `name`/`entry`: a theme switch only
 * updates `sdk.theme.mode` and the container's `data-hs-theme`, and a new
 * `props` reference is pushed through `events.emit("props", next)` instead of
 * remounting, so an entry's own view state survives host updates.
 *
 * The caller owns the props object: keep it memoized (`useMemo` or a module
 * constant) — a new reference means "these are the new props".
 */
export function HostedComponent({ name, entry, props, theme, forwardedEvents, onEvent, className }: {
  name: string;
  entry: string;
  props: Record<string, unknown>;
  theme: StudioTheme;
  /** Event names the entry emits that the caller wants delivered to `onEvent`. */
  forwardedEvents?: readonly string[];
  onEvent?: (name: string, payload: unknown) => void;
  className?: string;
}): React.JSX.Element {
  const { t } = useTranslation("common");
  const container = useRef<HTMLDivElement>(null);
  const sdk = useRef<AppSdk | undefined>(undefined);
  const [failure, setFailure] = useState<string>();
  // The mount effect must not restart on host updates, so it reads the latest
  // values through refs while the effects below keep the mounted sdk in sync.
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const propsRef = useRef(props);
  propsRef.current = props;
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  // A stable dependency for the forwarded set: callers may pass a fresh array.
  const forwardedKey = (forwardedEvents ?? []).join(",");

  useEffect(() => {
    const target = container.current;
    if (target === null) return;
    let disposed = false;
    let teardown: (() => void) | undefined;
    setFailure(undefined);
    const sdkForEntry = createAppSdk({ name, props: propsRef.current, theme: { mode: themeRef.current } });
    sdk.current = sdkForEntry;
    target.dataset.hsTheme = themeRef.current;
    const unsubscribes = (forwardedKey === "" ? [] : forwardedKey.split(",")).map((eventName) =>
      sdkForEntry.events.on(eventName, (payload) => onEventRef.current?.(eventName, payload)),
    );
    void (async () => {
      try {
        const module = await import(/* The apps host serves this path; the bundler must not inline it. */ `/apps/${encodeURIComponent(name)}/ui/${entry}`);
        const mount = (module as { default?: AppMount }).default;
        if (typeof mount !== "function") throw new Error(t("components.entryMissingMount", { entry }));
        if (disposed) return;
        teardown = mount(target, sdkForEntry) ?? undefined;
      } catch (error) {
        if (!disposed) setFailure(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      disposed = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
      try {
        teardown?.();
      } catch {
        // An entry's teardown failure must not take the shell down with it.
      }
      target.replaceChildren();
      sdk.current = undefined;
    };
  }, [name, entry, forwardedKey, t]);

  useEffect(() => {
    if (container.current !== null) container.current.dataset.hsTheme = theme;
    if (sdk.current !== undefined) sdk.current.theme.mode = theme;
  }, [theme]);

  useEffect(() => {
    const current = sdk.current;
    if (current === undefined) return;
    current.props = props;
    current.events.emit("props", props);
  }, [props]);

  return <div className={className === undefined ? "hosted-component-frame" : `hosted-component-frame ${className}`}>
    {failure !== undefined && <div className="hosted-component-failure" role="alert">
      <strong>{t("components.entryFailed")}</strong>
      <p>{failure}</p>
    </div>}
    <div ref={container} className="hosted-component" data-hs-theme={theme} />
  </div>;
}
