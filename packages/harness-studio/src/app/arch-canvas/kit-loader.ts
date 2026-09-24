import type { CanvasKit } from "canvaskit-wasm";

/**
 * The CanvasKit runtime, loaded once per page.
 *
 * The package's glue is a classic script that publishes its initializer as a
 * global; it is served beside its wasm rather than bundled, because the glue
 * carries Node-only branches a browser bundle cannot resolve. The wasm is
 * 7.3 MB and is only fetched the first time the pane asks for it. A load that
 * fails is remembered as `null`, so a browser that cannot run it falls back to
 * the SVG diagram once rather than retrying on every render.
 */
declare global {
  interface Window {
    CanvasKitInit?: (options?: { locateFile?: (file: string) => string }) => Promise<CanvasKit>;
  }
}

let pending: Promise<CanvasKit | null> | undefined;

export function loadCanvasKit(): Promise<CanvasKit | null> {
  pending ??= start();
  return pending;
}

async function start(): Promise<CanvasKit | null> {
  try {
    await loadScript(new URL("assets/canvaskit.js", document.baseURI).href);
    const init = window.CanvasKitInit;
    if (init === undefined) return null;
    return await init({ locateFile: (file: string) => new URL(`assets/${file}`, document.baseURI).href });
  } catch {
    return null;
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () => reject(new Error("The CanvasKit runtime could not be loaded.")));
    document.head.appendChild(script);
  });
}
