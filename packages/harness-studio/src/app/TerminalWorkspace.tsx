import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useStudioTheme } from "./studio-theme.js";
import {
  connectPtyStream,
  decodePtyBytes,
  ptyClose,
  ptyResize,
  ptySpawn,
  ptyWrite,
  type PtyStreamEvent,
} from "./components/pty-client.js";

/** xterm colours drawn from the Studio theme, so the terminal matches the workbench. */
function terminalTheme(dark: boolean): NonNullable<ConstructorParameters<typeof Terminal>[0]>["theme"] {
  return dark
    ? { background: "#0b0e14", foreground: "#c9d1d9", cursor: "#c9d1d9", selectionBackground: "#264f78" }
    : { background: "#ffffff", foreground: "#1f2328", cursor: "#1f2328", selectionBackground: "#add6ff" };
}

/**
 * The Terminal workbench: a real pseudo-terminal backed by the native pty host.
 *
 * A shell is spawned on mount (the server resolves `$SHELL`), its bytes are
 * streamed in over SSE and written to xterm, keystrokes are sent back with
 * `pty.write`, and container resizes are pushed with `pty.resize` so full-screen
 * TUIs lay out correctly. One session per mount; a fresh one is a click away.
 */
export function TerminalWorkspace(): React.JSX.Element {
  const { t } = useTranslation("common");
  const theme = useStudioTheme();
  const mountRef = useRef<HTMLDivElement>(null);
  const [ptyId, setPtyId] = useState<number>();
  const [exited, setExited] = useState<string>();
  const [error, setError] = useState<string>();
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const element = mountRef.current;
    if (element === null) return;
    const term = new Terminal({
      fontFamily: "var(--font-code, ui-monospace, SFMono-Regular, Menlo, monospace)",
      fontSize: 12,
      cursorBlink: true,
      convertEol: false,
      theme: terminalTheme(theme === "dark"),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    fit.fit();

    const controller = new AbortController();
    let currentPty: number | undefined;
    let inputBinding: IDisposable | undefined;
    let disposed = false;

    // Follow container size changes, then tell the child its new winsize.
    const resizeObserver = new ResizeObserver(() => {
      try { fit.fit(); } catch { /* the element can be measured as zero mid-layout */ }
      if (currentPty !== undefined) void ptyResize(currentPty, term.rows, term.cols).catch(() => undefined);
    });
    resizeObserver.observe(element);

    connectPtyStream((event: PtyStreamEvent) => {
      if (event.ptyId !== currentPty) return;
      if (event.type === "pty.data" && event.dataBase64 !== undefined) {
        term.write(decodePtyBytes(event.dataBase64));
      } else if (event.type === "pty.exit") {
        const how = event.signal !== null ? t("terminal.exitSignal", { signal: event.signal }) : t("terminal.exitCode", { code: event.code });
        term.write(`\r\n\x1b[2m${how}\x1b[0m\r\n`);
        setExited(how);
        currentPty = undefined;
      }
    }, controller.signal).catch((streamError: unknown) => {
      if (!controller.signal.aborted) setError(streamError instanceof Error ? streamError.message : String(streamError));
    });

    void (async () => {
      try {
        const id = await ptySpawn({ rows: term.rows, cols: term.cols, term: "xterm-256color" });
        if (disposed) { await ptyClose(id).catch(() => undefined); return; }
        currentPty = id;
        setPtyId(id);
        // Send keystrokes only once a session exists to receive them.
        inputBinding = term.onData((data) => { void ptyWrite(id, data).catch(() => undefined); });
        term.focus();
      } catch (spawnError) {
        setError(spawnError instanceof Error ? spawnError.message : String(spawnError));
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
      resizeObserver.disconnect();
      inputBinding?.dispose();
      if (currentPty !== undefined) void ptyClose(currentPty).catch(() => undefined);
      term.dispose();
    };
    // `generation` bumps to force a fresh session; `theme` re-themes via its own effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation]);

  return <div className="terminal-workspace">
    <div className="terminal-toolbar">
      <span className="terminal-status">
        {error !== undefined ? t("terminal.failed") : exited !== undefined ? exited : ptyId === undefined ? t("terminal.starting") : t("terminal.running")}
      </span>
      <button
        type="button"
        onClick={() => { setError(undefined); setExited(undefined); setPtyId(undefined); setGeneration((value) => value + 1); }}
      >
        {t("terminal.newSession")}
      </button>
    </div>
    {error !== undefined && <p className="terminal-error" role="alert">{error}</p>}
    <div className="terminal-surface" ref={mountRef} />
  </div>;
}
