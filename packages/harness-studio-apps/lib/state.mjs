/**
 * Persisted host state: which apps are enabled, and the per-app proxy secret
 * the gateway signs forwarded requests with.
 *
 * The official platform keeps these per app under the data home; this host
 * keeps one JSON file under ``.state/`` because it maintains no data-home
 * app layout of its own. The secret contract is identical to the official
 * one: the host injects ``KIROCREW_PROXY_SECRET`` into the backend process and
 * signs with the same value (see ``lib/proxyAuth.mjs``).
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export class HostState {
  constructor(stateDir) {
    this.stateDir = stateDir
    this.file = join(stateDir, 'state.json')
    this.data = { enabledApps: {}, secrets: {} }
    this.load()
  }

  load() {
    if (!existsSync(this.file)) return
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8'))
      this.data.enabledApps = parsed.enabledApps || {}
      this.data.secrets = parsed.secrets || {}
    } catch {
      // A corrupt state file is a dev inconvenience, not a data loss: start fresh.
    }
  }

  save() {
    mkdirSync(this.stateDir, { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.data, null, 2) + '\n', 'utf-8')
  }

  /** `undefined` = never decided; the caller applies the manifest/platform default. */
  isEnabled(name) {
    const value = this.data.enabledApps[name]
    return typeof value === 'boolean' ? value : undefined
  }

  setEnabled(name, enabled) {
    this.data.enabledApps[name] = Boolean(enabled)
    this.save()
  }

  /** Per-app proxy secret, created on first use and stable across restarts. */
  secretFor(name) {
    if (!this.data.secrets[name]) {
      this.data.secrets[name] = randomBytes(32).toString('hex')
      this.save()
    }
    return this.data.secrets[name]
  }
}
