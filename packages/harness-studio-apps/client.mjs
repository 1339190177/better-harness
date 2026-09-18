/**
 * The app-UI contract for harness-studio apps — the one module both sides of
 * the contract import.
 *
 * Host side (whoever renders an app page): import the app's ESM entry, build
 * an SDK with ``createAppSdk``, call the entry's default export, and keep the
 * returned teardown.
 *
 *   const { default: mount } = await import(`/apps/${name}/ui/${entry}`)
 *   const sdk = createAppSdk({ name })
 *   const teardown = mount(container, sdk)
 *   // later: teardown?.()
 *
 * App side (``apps/<name>/ui/entry.mjs``):
 *
 *   export default function mount(container, sdk) {
 *     // sdk.api.get('things') hits /apps/<name>/api/things, HMAC handled by
 *     // the host proxy — the app never sees or signs anything.
 *     return () => { /* optional teardown *\/ }
 *   }
 *
 * Contract rules, deliberately minimal:
 *
 *   - the entry is a plain ESM module; it must not import from the host's
 *     internals, only from this module (``@qoder-ai/harness-studio-apps/client``)
 *     if it imports anything at all;
 *   - ``mount`` receives a container element it owns completely and the sdk;
 *   - ``mount`` may return a teardown function; the host calls it before
 *     dropping the container;
 *   - the app's own styles travel with the entry (a ``<style>`` tag or a
 *     namespaced class prefix) — the host does not inject a framework;
 *   - the host may pass initial data in ``sdk.props`` and keep it current by
 *     replacing it and emitting a ``"props"`` event with the next object;
 *     entries read ``sdk.props`` at mount and subscribe for updates.
 *
 * API semantics mirror the official KiroCrew app SDK (``@kirocrew/app-sdk``)
 * where it applies to a host-agnostic caller: every method parses a JSON
 * response, an empty successful response resolves to ``undefined``, and an
 * HTTP failure rejects with an ``AppApiError`` carrying ``status`` and the
 * unparsed ``body``.
 */

export const APP_CONTRACT_VERSION = 1

/**
 * Events the CONTRACT defines, as opposed to the ones an app declares. They
 * are always subscribable: an app cannot have to list `"props"` in its manifest
 * to be told about its own props, and the manifest's `<scope>:<name>` shape
 * would not admit them anyway.
 */
export const RESERVED_EVENTS = Object.freeze(['props', 'theme'])

/** HTTP failure from an app API call. ``body`` is unparsed on purpose. */
export class AppApiError extends Error {
  constructor(status, body, url) {
    super(`API ${status}: ${body}`)
    this.name = 'AppApiError'
    this.status = status
    this.body = body
    this.url = url
  }
}

/**
 * A client bound to one app's API namespace.
 *
 * ``base`` defaults to the hosted path — the host proxy forwards
 * ``/apps/<name>/api/*`` to the app's backend process and signs it in transit.
 * Pass an explicit ``base`` only when calling from somewhere else (tests, a
 * different deployment of the same backend).
 */
export function createAppApi({ name, base, fetch: fetchImpl = globalThis.fetch } = {}) {
  const prefix = base ?? `/apps/${encodeURIComponent(name ?? '')}/api`

  async function request(path, init = {}) {
    const rel = String(path ?? '').replace(/^\/+/, '')
    const url = rel ? `${prefix}/${rel}` : prefix
    const res = await fetchImpl(url, init)
    const text = await res.text()
    if (!res.ok) throw new AppApiError(res.status, text, url)
    if (!text) return undefined
    return JSON.parse(text)
  }

  /** JSON-body convenience for the write methods (mirrors the official SDK). */
  function withJsonBody(method, body, init) {
    const headers = { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }
    return { ...(init ?? {}), method, headers, body: JSON.stringify(body ?? null) }
  }

  return {
    request,
    get: (path, init) => request(path, { ...(init ?? {}), method: 'GET' }),
    del: (path, init) => request(path, { ...(init ?? {}), method: 'DELETE' }),
    post: (path, body, init) => request(path, withJsonBody('POST', body, init)),
    put: (path, body, init) => request(path, withJsonBody('PUT', body, init)),
    patch: (path, body, init) => request(path, withJsonBody('PATCH', body, init)),
  }
}

/**
 * Host → app event delivery. ``on`` returns its own unsubscribe, so an app
 * can wire a listener and drop it in the teardown without bookkeeping.
 *
 * The bus is symmetric — the host pushes state down and an entry reports
 * selections up through the same object — so ``allowed`` is the app's whole
 * event vocabulary, not one direction of it.
 *
 * ``allowed`` is the app's manifest ``capabilities.events`` list. When it is
 * given, a subscription outside it is REFUSED rather than registered: nothing
 * will ever deliver such an event, so registering the listener would leave the
 * subscriber waiting on something that cannot arrive. The refusal is loud —
 * a typo in an event name is otherwise indistinguishable from an event that
 * simply never fires. Pass ``undefined`` (the default) to skip the check, which
 * is what a test harness or a host with no manifest in hand does.
 */
export function createEventBus({ allowed, onRefused } = {}) {
  const listeners = new Map()
  const allowList = Array.isArray(allowed) ? new Set(allowed) : null
  for (const reserved of RESERVED_EVENTS) allowList?.add(reserved)
  const refuse =
    onRefused ??
    ((name) =>
      console.error(
        `[app-sdk] event "${name}" is not in this app's capabilities.events — the subscription was refused. ` +
          `Declare it in app.json, or fix the name.`,
      ))
  return {
    /** True when *name* may be subscribed to under the current allow-list. */
    canSubscribe(name) {
      return allowList === null || allowList.has(name)
    },
    on(name, fn) {
      if (!this.canSubscribe(name)) {
        refuse(name)
        return () => {}
      }
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(fn)
      return () => this.off(name, fn)
    },
    off(name, fn) {
      listeners.get(name)?.delete(fn)
    },
    emit(name, payload) {
      for (const fn of listeners.get(name) ?? []) fn(payload)
    },
  }
}

/**
 * Build the SDK handed to an app's ``mount``. The host owns this object; an
 * app only reads it. ``theme.mode`` describes the host's current color mode —
 * the host also mirrors it as ``data-hs-theme`` on the container so plain CSS
 * can react without JS. ``props`` carries whatever context the host has for
 * this mount; when it changes, the host replaces ``sdk.props`` and emits the
 * same object as a ``"props"`` event, so entries never poll.
 *
 * @returns {AppSdk}
 */
export function createAppSdk({
  name,
  fetch: fetchImpl = globalThis.fetch,
  api,
  // `allowedEvents` is the app's manifest `capabilities.events`. Passing it is
  // what makes the declaration load-bearing: a subscription the host will never
  // deliver is refused at `on()` instead of waiting forever.
  allowedEvents,
  events = createEventBus({ allowed: allowedEvents }),
  theme = { mode: 'dark' },
  props = {},
} = {}) {
  if (typeof name !== 'string' || !name) {
    throw new TypeError('createAppSdk requires an app name')
  }
  return {
    contract: APP_CONTRACT_VERSION,
    name,
    api: api ?? createAppApi({ name, fetch: fetchImpl }),
    events,
    theme,
    props,
  }
}

/**
 * @typedef {object} AppSdk
 * @property {number} contract  APP_CONTRACT_VERSION the host speaks.
 * @property {string} name      The app's manifest name.
 * @property {object} api       App API client; see ``createAppApi``.
 * @property {object} events    Host event bus; see ``createEventBus``.
 * @property {{mode: 'light' | 'dark'}} theme  Host color mode.
 * @property {object} props     Host-supplied context for this mount; updates
 *                              arrive as the ``"props"`` event.
 */

/**
 * @typedef {(container: HTMLElement, sdk: AppSdk) => (void | (() => void))} AppMount
 * The default export of an app's UI entry: mount into ``container``, return an
 * optional teardown.
 */
