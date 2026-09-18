/**
 * App discovery — ``<apps>/<name>/app.json`` from the package's own apps
 * directory, plus INSTALLED apps from the data home.
 *
 * Every manifest goes through ``validateManifest`` before it becomes a record.
 * An app whose manifest does not validate is NOT loaded, and the reason is
 * logged with the offending field: a manifest that cannot be trusted would
 * otherwise reach the proxy and the spawner as a set of half-honoured
 * promises. Warnings do not block the load — they are the author's signal that
 * something declared will not do what they expect.
 *
 * The record published on ``GET /api/apps`` carries the NORMALIZED manifest
 * (defaults applied, unknown fields dropped), so the shell and the host never
 * read two different shapes of the same field.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { formatFinding, validateManifest } from './manifest.mjs'

/** Logger used when a caller passes none — discovery must never be silent. */
const CONSOLE_LOGGER = {
  info: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * Validate one manifest and report. Returns the normalized manifest, or null
 * when the app must not load.
 */
function acceptManifest(raw, { appDir, name, logger, source }) {
  const { ok, errors, warnings, manifest } = validateManifest(raw, { appDir })
  for (const warning of warnings) {
    logger.warn(`app "${name}" (${source}) manifest warning — ${formatFinding(warning)}`)
  }
  if (!ok) {
    logger.error(
      `app "${name}" (${source}) was NOT loaded: ${errors.length} manifest error${errors.length === 1 ? '' : 's'}`,
    )
    for (const error of errors) logger.error(`  ${formatFinding(error)}`)
    return null
  }
  return manifest
}

/**
 * Load every ``<appsDir>/<dir>/app.json`` as an app record.
 *
 * ``record.backendScript`` is the absolute path the spawner uses. It comes from
 * the manifest's ``backend.entry`` — never from probing the directory for a
 * file — so what the manifest says runs and what actually runs cannot diverge.
 */
export function loadApps(appsDir, { logger = CONSOLE_LOGGER } = {}) {
  const root = resolve(appsDir)
  const apps = new Map()
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry)
    let info
    try {
      info = statSync(dir)
    } catch {
      continue
    }
    if (!info.isDirectory()) continue
    if (entry.startsWith('__') || entry.startsWith('.')) continue
    const manifestPath = join(dir, 'app.json')
    if (!existsSync(manifestPath)) continue

    const raw = readJson(manifestPath)
    if (raw === null) {
      logger.error(`app "${entry}" was NOT loaded: ${manifestPath} is not valid JSON`)
      continue
    }
    const manifest = acceptManifest(raw, {
      appDir: dir,
      name: typeof raw?.name === 'string' && raw.name ? raw.name : entry,
      logger,
      source: 'builtin',
    })
    if (manifest === null) continue
    if (apps.has(manifest.name)) {
      logger.error(`app "${manifest.name}" was NOT loaded: another app in ${root} already claims that name`)
      continue
    }

    apps.set(manifest.name, {
      name: manifest.name,
      dir,
      manifest,
      backendScript: manifest.backend ? join(dir, manifest.backend.entry) : null,
      record: {
        name: manifest.name,
        version: manifest.version,
        displayName: manifest.displayName,
        enabled: false, // resolved from state at request time
        installedAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        source: 'builtin',
        origin: 'builtin',
        lifecycle: 'locked',
        schemaVersion: manifest.schemaVersion,
        manifest,
      },
    })
  }
  return apps
}

/**
 * Load every INSTALLED app from the data home (``<home>/apps/<dir>``).
 * ``installed.json`` carries the settled lifecycle fields (the real ``enabled``
 * flag, timestamps, source) and ``app.json`` the manifest. A directory without
 * an ``installed.json`` is skipped — that is what "not installed" means — and
 * so is one whose manifest does not validate.
 */
export function loadInstalledApps(installedAppsDir, { logger = CONSOLE_LOGGER } = {}) {
  const root = resolve(installedAppsDir)
  const apps = new Map()
  let entries
  try {
    entries = readdirSync(root)
  } catch {
    return apps
  }
  for (const entry of entries) {
    const dir = join(root, entry)
    let info
    try {
      info = statSync(dir)
    } catch {
      continue
    }
    if (!info.isDirectory()) continue
    const installedMeta = readJson(join(dir, 'installed.json'))
    if (!installedMeta || typeof installedMeta.name !== 'string') continue

    const raw = readJson(join(dir, 'app.json'))
    if (raw === null) {
      logger.error(`app "${installedMeta.name}" (installed) was NOT loaded: app.json is missing or not valid JSON`)
      continue
    }
    const manifest = acceptManifest(raw, {
      appDir: dir,
      name: installedMeta.name,
      logger,
      source: 'installed',
    })
    if (manifest === null) continue
    if (manifest.name !== installedMeta.name) {
      logger.error(
        `app "${installedMeta.name}" (installed) was NOT loaded: app.json declares the name "${manifest.name}"`,
      )
      continue
    }

    apps.set(manifest.name, {
      name: manifest.name,
      dir,
      manifest,
      installedMeta,
      backendScript: manifest.backend ? join(dir, manifest.backend.entry) : null,
      record: { ...installedMeta, schemaVersion: manifest.schemaVersion, manifest },
    })
  }
  return apps
}
