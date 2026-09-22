import { createSseParser } from "../sse-client.js";

/** One event as the `/api/pty/stream` SSE endpoint publishes it. */
export interface PtyStreamEvent {
  type: "pty.data" | "pty.exit";
  ptyId: number;
  dataBase64?: string;
  code?: number | null;
  signal?: number | null;
}

export interface PtySpawnRequest {
  /** Omit to open the reader's login shell (`$SHELL`), resolved by the server. */
  command?: string;
  args?: readonly string[];
  cwd?: string;
  rows?: number;
  cols?: number;
  term?: string;
}

/** Base64-encode UTF-8 text for `pty.write` (the wire carries raw bytes). */
export function encodePtyInput(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Decode a `pty.data` base64 chunk back to text for display. */
export function decodePtyOutput(dataBase64: string): string {
  return new TextDecoder().decode(decodePtyBytes(dataBase64));
}

/** Decode a `pty.data` base64 chunk to raw bytes (for a real terminal emulator). */
export function decodePtyBytes(dataBase64: string): Uint8Array {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? `${path} failed (${response.status}).`);
  }
  return (await response.json()) as Record<string, unknown>;
}

export async function ptySpawn(request: PtySpawnRequest): Promise<number> {
  const result = await postJson("api/pty/spawn", request);
  return Number(result.ptyId);
}

export async function ptyWrite(ptyId: number, text: string): Promise<void> {
  await postJson("api/pty/write", { ptyId, dataBase64: encodePtyInput(text) });
}

export async function ptyResize(ptyId: number, rows: number, cols: number): Promise<void> {
  await postJson("api/pty/resize", { ptyId, rows, cols });
}

export async function ptyClose(ptyId: number): Promise<void> {
  await postJson("api/pty/close", { ptyId });
}

/**
 * Open the terminal event stream until `signal` aborts. The stream carries every
 * session's events, so the caller filters by `ptyId`. Reuses the shell's SSE
 * parser rather than `EventSource`, keeping one streaming path across Studio.
 */
export async function connectPtyStream(
  onEvent: (event: PtyStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch("api/pty/stream", { signal, headers: { accept: "text/event-stream" } });
  if (!response.ok || response.body === null) {
    throw new Error(`Terminal stream failed (${response.status}).`);
  }
  const parser = createSseParser<PtyStreamEvent>(onEvent);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    parser.end();
    reader.releaseLock();
  }
}
