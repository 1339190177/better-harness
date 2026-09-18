/**
 * Configuration resolution for the Node host.
 *
 * Three inputs:
 *
 *   - the dashboard dist (``static/dist``) — OPTIONAL here. When present it is
 *     served as the SPA shell (``/``, ``/assets/*``, extensionless routes),
 *     either copied into ``public/dist``, read from a build output, or taken
 *     from an installed Kiro Crew app. Without one the host still runs the app
 *     surface (``/apps/<name>/api/*``, ``/apps/<name>/ui/*``);
 *   - the apps directory — ``<apps>/<name>/app.json`` manifests, with a Node
 *     backend reimplementation at ``<apps>/<name>/server.mjs`` when one has
 *     been written. This package ships its own copy under ``apps/``;
 *   - the app data home (``~/.kiro/crew``) — installed-app records, consulted
 *     with the same precedence the gateway's ``list_apps()`` gives them.
 *
 * Each has a flag, an env var, and a default chain; the first existing hit
 * wins.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const DEFAULT_APP_BACKEND_DIST = '/Applications/KiroCrew.app/Contents/Resources/backend-dist'

/** Locate the ``kiro_crew`` package inside the installed Kiro Crew app. */
function detectInstalledPackage() {
  const tried = []
  try {
    for (const entry of readdirSync(DEFAULT_APP_BACKEND_DIST)) {
      const candidate = join(
        DEFAULT_APP_BACKEND_DIST,
        entry,
        'lib',
      )
      tried.push(candidate)
      if (!existsSync(candidate)) continue
      for (const py of readdirSync(candidate)) {
        if (!py.startsWith('python')) continue
        const pkg = join(candidate, py, 'site-packages', 'kiro_crew')
        if (existsSync(join(pkg, 'static', 'dist', 'index.html'))) return pkg
      }
    }
  } catch {
    // No installed app on this machine — fall back to explicit flags.
  }
  return null
}

export function parseArgs(argv) {
  const flags = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        i += 1
      } else {
        flags[key] = true
      }
    } else {
      flags._.push(arg)
    }
  }
  return flags
}

function firstExistingDirs(candidates) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate) && statSync(candidate).isDirectory()) return resolve(candidate)
  }
  return null
}

export function resolveConfig(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv)
  const installed = detectInstalledPackage()

  // Missing is a supported state, not an error: an app's own UI
  // (``apps/<name>/ui/``) and the whole API surface work without any SPA. A
  // dist only adds the dashboard shell routes, and ``server.mjs`` warns when
  // none was found.
  const distDir = firstExistingDirs([
    flags.dist,
    process.env.KIROCREW_DIST_DIR,
    join(ROOT, 'public', 'dist'),
    // A build output under the repo root, so the host can run straight out of a
    // checkout that carries one.
    join(ROOT, '..', '..', 'src', 'kiro_crew', 'static', 'dist'),
    installed && join(installed, 'static', 'dist'),
  ])

  const appsDir = firstExistingDirs([
    flags.apps,
    process.env.KIROCREW_NODE_APPS_DIR,
    join(ROOT, 'apps'),
    installed && join(installed, 'apps', 'builtins'),
  ])
  if (!appsDir) {
    throw new Error(
      'Could not locate an apps directory. Pass --apps <dir> or set KIROCREW_NODE_APPS_DIR.',
    )
  }

  return {
    distDir,
    appsDir,
    stateDir: resolve(flags['state-dir'] || process.env.KIROCREW_NODE_STATE_DIR || join(ROOT, '.state')),
    homeDir: resolve(flags.home || process.env.KIROCREW_HOME || join(homedir(), '.kiro', 'crew')),
    port: Number(flags.port || process.env.PORT || 8799),
    host: String(flags.host || process.env.HOST || '127.0.0.1'),
    // `--enable a,b` flips the named apps on at boot (an explicit state
    // write, so it survives restarts like any enable). Without it every app
    // starts in the state its installed record says, exactly as upstream.
    enableList: String(flags.enable || process.env.KIROCREW_NODE_ENABLE || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    // `--app <name>` pins the host to a single app: `/` opens that app's
    // page, and the app is enabled at boot (pinning a host to an app is an
    // explicit operator decision, same weight as `--enable`).
    app: String(flags.app || process.env.KIROCREW_NODE_APP || ''),
  }
}
