/**
 * Type declarations for the app-UI contract implemented in ``client.mjs``.
 * The implementation is plain ESM so app entries can import it as written;
 * these declarations exist for TypeScript consumers (the Studio shell).
 */

/** The contract version the host speaks; bump only with a breaking change. */
export const APP_CONTRACT_VERSION: number;

/** HTTP failure from an app API call. ``body`` is unparsed on purpose. */
export class AppApiError extends Error {
  constructor(status: number, body: string, url: string);
  readonly status: number;
  readonly body: string;
  readonly url: string;
}

/** A client bound to one app's API namespace (``/apps/<name>/api/*``). */
export interface AppApi {
  request<T = unknown>(path?: string, init?: RequestInit): Promise<T | undefined>;
  get<T = unknown>(path?: string, init?: RequestInit): Promise<T | undefined>;
  del<T = unknown>(path?: string, init?: RequestInit): Promise<T | undefined>;
  post<T = unknown>(path?: string, body?: unknown, init?: RequestInit): Promise<T | undefined>;
  put<T = unknown>(path?: string, body?: unknown, init?: RequestInit): Promise<T | undefined>;
  patch<T = unknown>(path?: string, body?: unknown, init?: RequestInit): Promise<T | undefined>;
}

/**
 * Host → app event delivery; ``on`` returns its own unsubscribe.
 *
 * When the bus was built with an allow-list (the app's manifest
 * ``capabilities.events``), ``on`` refuses a name outside it and returns a
 * no-op unsubscribe — the host would never deliver such an event, so a
 * listener for it can only wait forever.
 */
export interface AppEventBus {
  /** Whether ``on`` would accept *name* under the current allow-list. */
  canSubscribe(name: string): boolean;
  on(name: string, fn: (payload: unknown) => void): () => void;
  off(name: string, fn: (payload: unknown) => void): void;
  emit(name: string, payload?: unknown): void;
}

/** The host's color mode, mirrored on the container as ``data-hs-theme``. */
export interface AppTheme {
  mode: "light" | "dark";
}

/** The SDK handed to an app entry's ``mount``. The host owns this object. */
export interface AppSdk {
  /** ``APP_CONTRACT_VERSION`` the host speaks. */
  readonly contract: number;
  /** The app's manifest name. */
  readonly name: string;
  readonly api: AppApi;
  readonly events: AppEventBus;
  readonly theme: AppTheme;
  /**
   * Host-supplied context for this mount. Read it at mount; every update
   * arrives as the ``"props"`` event carrying the next object (the host also
   * replaces ``sdk.props`` with it).
   */
  props: Record<string, unknown>;
}

/**
 * The default export of an app's UI entry: mount into ``container``, return
 * an optional teardown the host calls before dropping the container.
 */
export type AppMount = (container: HTMLElement, sdk: AppSdk) => void | (() => void);

export function createAppApi(options?: {
  name?: string;
  base?: string;
  fetch?: typeof fetch;
}): AppApi;

/** Events the contract defines; always subscribable, never manifest-declared. */
export const RESERVED_EVENTS: readonly string[];

export function createEventBus(options?: {
  /** The app's manifest ``capabilities.events``; omit to skip the check. */
  allowed?: readonly string[];
  /** Called instead of the default console error when a name is refused. */
  onRefused?: (name: string) => void;
}): AppEventBus;

export function createAppSdk(options: {
  name: string;
  fetch?: typeof fetch;
  api?: AppApi;
  /** The app's manifest ``capabilities.events``, used to build the event bus. */
  allowedEvents?: readonly string[];
  events?: AppEventBus;
  theme?: AppTheme;
  props?: Record<string, unknown>;
}): AppSdk;
