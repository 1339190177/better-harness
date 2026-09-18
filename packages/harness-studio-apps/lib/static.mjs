/**
 * Static surface of the compat host — everything the dashboard SPA fetches
 * that is not an API call.
 *
 * Routes (mirroring the gateway's static wiring):
 *   GET /                        -> dist/index.html (no-store: it is the shell),
 *                                   served with the single-app chrome injection
 *                                   (see ``injectSingleAppChrome``)
 *   GET /assets/*                -> dist/assets/* (content-hashed, immutable)
 *   GET /app-assets/*            -> dist/app-assets/* (store art, app icons)
 *   GET /vendor/*                -> dist/vendor/* (vendored frontend deps)
 *   GET /apps/<name>/ui/<entry>  -> installed apps/<name>/ui/<entry>, else the
 *                                   builtin's own ui/ dir (app UI ESM). Gated
 *                                   on enablement: a disabled app's bundle is
 *                                   404, like one that is not installed.
 *   GET /<anything-else>         -> dist/<path> when it exists, otherwise
 *                                   dist/index.html (SPA fallback, injected)
 *
 * Containment: every resolved path must stay under its root, so a `..` in the
 * URL can never escape the dist or an app directory.
 *
 * ``distDir`` is optional: without one, only the app UI bundles
 * (``/apps/<name>/ui/*``) are served and every dist-backed route falls through
 * to the caller's 404.
 */
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { sendFile, sendJson } from './httpUtil.mjs'

const IMMUTABLE = 'public, max-age=31536000, immutable'
const HASHED = /-[A-Za-z0-9_-]{8,}\.(js|css|woff2?|png|svg|webp)$/

// Official ui-file contract (apps/routes.py::_ALLOWED_EXTENSIONS): anything
// outside this set is refused with 403 before touching the filesystem.
const UI_ALLOWED_EXTENSIONS = new Set([
  '.mjs', '.js', '.css', '.json', '.svg', '.png', '.jpg', '.jpeg',
  '.gif', '.webp', '.woff', '.woff2', '.ttf', '.map',
])

// ---------------------------------------------------------------------------
// Single-app chrome injection
// ---------------------------------------------------------------------------
//
// On a route an app page owns, the dashboard chrome is hidden so the app
// fills the window — the "standalone app" reading of an app page in this
// host. The official dashboard has focus mode for a similar effect, but it is
// a per-window view state that collapses the chrome into edge hover overlays
// (a mouse at the window edge peeks it back open), so the host pins the
// layout instead of driving that state.
//
// The selectors are the stable hooks App.tsx itself renders:
//   header.topbar          — the top bar (grid area 'topbar');
//   nav.focus-chrome-rail  — the desktop nav rail (grid area 'nav'); the
//                            mobile drawer is a motion.nav that only mounts
//                            once opened, so it needs no rule;
//   #activity-bar-slot     — the right-hand activity column;
//   [data-testid="dashboard-shell"] — the grid whose track sizes React writes
//   INLINE. That inline origin is exactly what the ``!important``
//   declarations below exist to outweigh: an external rule loses to an inline
//   style unless it carries ``!important``.
const APP_CHROME_CSS = `
html.kc-app-only header.topbar,
html.kc-app-only nav.focus-chrome-rail,
html.kc-app-only #activity-bar-slot {
  display: none !important;
}
html.kc-app-only [data-testid="dashboard-shell"] {
  grid-template-areas: "content" !important;
  grid-template-columns: minmax(0, 1fr) !important;
  grid-template-rows: minmax(0, 1fr) !important;
}
`

/**
 * Route watcher that flips ``html.kc-app-only`` as the SPA navigates.
 *
 * React Router navigations are pushState/replaceState calls, which fire no
 * event of their own, so the history methods are wrapped alongside
 * ``popstate`` — without that the class goes stale on the first in-app link
 * (an app page → anything else would keep the chrome hidden, and the link
 * back would not restore it). A root route never prefix-matches, or an app
 * routed at "/" would swallow the whole dashboard.
 */
function appChromeScript(appRoutes) {
  return `(function () {
  var ROUTES = ${JSON.stringify(appRoutes)};
  function sync() {
    var path = window.location.pathname;
    var on = false;
    for (var i = 0; i < ROUTES.length; i++) {
      var r = ROUTES[i];
      if (path === r || (r !== '/' && path.indexOf(r + '/') === 0)) { on = true; break; }
    }
    document.documentElement.classList.toggle('kc-app-only', on);
  }
  var push = history.pushState, replace = history.replaceState;
  history.pushState = function () { var v = push.apply(this, arguments); sync(); return v; };
  history.replaceState = function () { var v = replace.apply(this, arguments); sync(); return v; };
  window.addEventListener('popstate', sync);
  sync();
})();`
}

/**
 * Insert the chrome-hiding style and route watcher into the SPA shell.
 * Defensive about the marker: a dist without ``</head>`` is served untouched
 * rather than mangled.
 */
function injectSingleAppChrome(html, appRoutes) {
  const at = html.indexOf('</head>')
  if (at === -1) return html
  const snippet =
    `<style id="kc-single-app">${APP_CHROME_CSS}</style>` +
    `<script>${appChromeScript(appRoutes)}</script>`
  return html.slice(0, at) + snippet + html.slice(at)
}

function contained(root, candidate) {
  const rel = resolve(candidate)
  return rel === root || rel.startsWith(root + sep)
}

export function createStaticHandler({
  distDir,
  apps,
  installedAppsDir,
  appRoutes = [],
  // The same predicate the proxy and the host API read, so what `/api/apps`
  // reports, what the proxy forwards and what this tier serves cannot diverge.
  // Defaulting to "everything is on" keeps the handler usable standalone.
  isAppEnabled = () => true,
}) {
  const root = distDir ? resolve(distDir) : null

  /** First existing candidate under the dist root, or null. */
  async function pickDistState(relative) {
    if (!root) return null
    const candidate = resolve(join(root, normalize('/' + relative)))
    if (!contained(root, candidate)) return null
    try {
      const info = await stat(candidate)
      if (info.isFile()) return { file: candidate, size: info.size }
    } catch {
      /* fall through */
    }
    return null
  }

  async function serveDist(res, relative, { cache } = {}) {
    const found = await pickDistState(relative)
    if (!found) return false
    const effectiveCache =
      cache ?? (relative.startsWith('assets/') && HASHED.test(relative) ? IMMUTABLE : 'no-store')
    return sendFile(res, found.file, { cache: effectiveCache })
  }

  /**
   * Serve the SPA shell with the single-app injection applied. Read per
   * request on purpose: the shell is ``no-store`` (it names the hashed
   * bundles), so nothing is cached to go stale, and the file is a few KB.
   */
  async function sendIndexHtml(res) {
    const found = await pickDistState('index.html')
    if (!found) return false
    const html = await readFile(found.file, 'utf-8')
    const body = Buffer.from(injectSingleAppChrome(html, appRoutes), 'utf-8')
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    })
    res.end(body)
    return true
  }

  /**
   * Handle a static request. Returns true when a response was written.
   * `apiPrefixes` are refused here because API routing owns them.
   */
  async function handle(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    const pathname = decodeURIComponent(url.pathname)

    if (pathname.startsWith('/api/') || pathname === '/api') return false

    // Federated app UI bundles: /apps/<name>/ui/<entry>.
    // Contract mirrors the official route (apps/routes.py::handle_app_ui_file):
    //   400 {"error":"invalid path"} for `..`/absolute escapes,
    //   403 {"error":"file type '<ext>' not allowed"} for a blocked extension,
    //   404 {"error":"not found"} for everything else — an uninstalled app and
    //   an app without a ui/ tree answer the same way, exactly as upstream.
    // The official root is the INSTALLED app under the data home
    // (<home>/apps/<name>/ui); a builtin that the Node host ships its own ui/
    // for is served from its module dir as a fallback.
    // Match the ui route against the RAW request target rather than the
    // normalized pathname: WHATWG URL collapses percent-encoded dot segments
    // (%2e%2e) exactly like literal ones, but aiohttp/yarl (the official
    // gateway) does not — upstream's handler still sees `../..` in match_info
    // and answers 400. Matching raw lets us answer the same, and the literal
    // `..` form is refused too rather than silently falling back to the SPA.
    // A malformed escape (bad %) is refused the same way aiohttp refuses it.
    let rawPath
    try {
      rawPath = decodeURIComponent((req.url || pathname).split('?')[0])
    } catch {
      sendJson(res, 400, { error: 'invalid path' })
      return true
    }
    const uiMatch = rawPath.match(/^\/apps\/([^/]+)\/ui\/(.+)$/)
    if (uiMatch) {
      const [, name, entry] = uiMatch
      if (entry.includes('..') || entry.startsWith('/')) {
        sendJson(res, 400, { error: 'invalid path' })
        return true
      }
      // Enablement gates the BUNDLE, not only the API. Serving a disabled
      // app's entry let any page import and mount it, so the switch the app
      // list offers only held for half the app. The refusal is the same 404 an
      // app that is not installed gets: whether a disabled app exists is not
      // this tier's to disclose.
      if (!isAppEnabled(name)) {
        sendJson(res, 404, { error: 'not found' })
        return true
      }
      const ext = extname(entry).toLowerCase()
      if (!UI_ALLOWED_EXTENSIONS.has(ext)) {
        sendJson(res, 403, { error: `file type '${ext}' not allowed` })
        return true
      }
      const roots = []
      if (installedAppsDir) roots.push(join(installedAppsDir, name, 'ui'))
      const record = apps.get(name)
      if (record?.dir) roots.push(join(record.dir, 'ui'))
      for (const uiRoot of roots) {
        const rootResolved = resolve(uiRoot)
        const candidate = resolve(join(rootResolved, normalize(entry)))
        if (!contained(rootResolved, candidate)) continue
        const served = await sendFile(res, candidate, {
          cache: 'no-cache',
          headers: {
            'Content-Security-Policy': "default-src 'none'; sandbox",
            'X-Content-Type-Options': 'nosniff',
          },
        })
        if (served) return true
      }
      sendJson(res, 404, { error: 'not found' })
      return true
    }

    // /apps/<name>/api/* belongs to the proxy, not to static serving.
    if (/^\/apps\/[^/]+\/api(\/|$)/.test(pathname)) return false

    const relative = pathname.replace(/^\/+/, '')

    // /logo.png: the gateway serves it from the package's static/ dir, which
    // sits next to (one level above) dist/. Fall back to the dist icon so the
    // PoC works from a bare dist copy too.
    if (relative === 'logo.png') {
      if (root) {
        const pkgStatic = resolve(join(root, '..'))
        const pkgLogo = resolve(join(pkgStatic, 'kirocrew-logo.png'))
        if (contained(pkgStatic, pkgLogo) && (await sendFile(res, pkgLogo, { cache: 'no-store' }))) {
          return true
        }
      }
      if (await serveDist(res, 'icon-512.png')) return true
      return false
    }

    // Exact dist file (index.html, hashed assets, app-assets, vendor, ...).
    // The shell itself goes through the injector so the app-page chrome-hiding
    // rule ships with every copy the SPA boots from.
    if (relative === 'index.html') return sendIndexHtml(res)
    if (relative !== '' && (await serveDist(res, relative))) return true

    // SPA fallback: extensionless paths are client-side routes.
    if (!extname(relative)) {
      if (await sendIndexHtml(res)) return true
    }
    return false
  }

  return { handle }
}
