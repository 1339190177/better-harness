/**
 * App backend process manager.
 *
 *   start(name, spec, secret)  spawn ``node <spec.script>`` with PORT /
 *                              KIROCREW_APP_NAME / KIROCREW_PROXY_SECRET /
 *                              KIROCREW_HOME in the environment, then poll the
 *                              manifest's health route until it answers.
 *   stop(name)                 terminate the process GROUP and drop the record.
 *   status(name)               { running, healthy, port, pid, restarts }.
 *
 * Ports are allocated by binding :0, closing, and handing the number to the
 * child. Every timing and retry number comes from the app's manifest
 * (``backend.startupTimeoutMs``, ``backend.restart``) — the spawner has no
 * policy of its own, so what the manifest says is what happens.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

const HEALTH_POLL_MS = 250
const HEALTH_PROBE_TIMEOUT_MS = 1000
/** Grace between SIGTERM and SIGKILL for a backend that ignores the first. */
const KILL_ESCALATION_MS = 3000

const DEFAULT_RESTART = { policy: 'on-failure', maxRetries: 3, backoffMs: 1000 }

export function allocPort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, host, () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function healthOk(url, timeoutMs = HEALTH_PROBE_TIMEOUT_MS) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

/**
 * Terminate a child and anything it spawned.
 *
 * The child is started in its own process group (``detached``), so a signal to
 * the negated pid reaches the whole tree. Without that a backend that shells
 * out leaves its grandchildren holding the port after the host exits. Windows
 * has no process groups; there the child itself is signalled, which is what
 * Node offers.
 */
function killTree(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch {
    // Already gone, or the group vanished between the check and the signal.
    try {
      child.kill(signal)
    } catch {
      /* already gone */
    }
  }
}

export class BackendManager {
  constructor({ homeDir, logger, host = '127.0.0.1' }) {
    this.homeDir = homeDir
    this.host = host
    this.logger = logger
    this.procs = new Map() // name -> record
  }

  status(name) {
    const proc = this.procs.get(name)
    if (!proc) return null
    return {
      running: proc.running,
      healthy: proc.healthy,
      port: proc.port,
      pid: proc.pid,
      restarts: proc.restarts,
    }
  }

  /** Spawn one process for *record* and wire its logging and exit handling. */
  async #spawnOnce(name, record) {
    const port = await allocPort(this.host)
    const log = this.logger
    const child = spawn(process.execPath, [record.spec.script], {
      cwd: record.spec.dir ?? undefined,
      // Own process group, so stop() can take the whole tree down with it.
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        PORT: String(port),
        HOST: this.host,
        KIROCREW_APP_NAME: name,
        KIROCREW_PROXY_SECRET: record.secret,
        KIROCREW_HOME: this.homeDir,
        KIROCREW_COMPAT_HOST: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    record.child = child
    record.pid = child.pid
    record.port = port
    record.running = true
    record.healthy = false
    log.info(`app "${name}" backend spawned  pid=${child.pid} port=${port}`)

    const prefix = `[app:${name}]`
    const pipe = (stream, level) => {
      let buffer = ''
      stream.setEncoding('utf-8')
      stream.on('data', (chunk) => {
        buffer += chunk
        const lines = buffer.split('\n')
        buffer = lines.pop()
        for (const line of lines) {
          if (line.trim()) log[level](`${prefix} ${line}`)
        }
      })
    }
    pipe(child.stdout, 'info')
    pipe(child.stderr, 'warn')

    child.on('exit', (code, signal) => {
      record.running = false
      record.healthy = false
      log.warn(`app "${name}" backend exited  code=${code} signal=${signal}`)
      this.#considerRestart(name, record, code)
    })

    await this.#awaitHealth(name, record)
  }

  /** Poll the manifest's health route until it answers or the budget runs out. */
  async #awaitHealth(name, record) {
    const healthPath = record.spec.healthCheck || '/health'
    const budget = record.spec.startupTimeoutMs ?? 10_000
    const deadline = Date.now() + budget
    while (Date.now() < deadline) {
      if (!record.running) break
      if (await healthOk(`http://${this.host}:${record.port}${healthPath}`)) {
        record.healthy = true
        break
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS))
    }
    if (record.healthy) {
      this.logger.info(`app "${name}" backend healthy on ${healthPath}`)
    } else if (record.running) {
      this.logger.warn(`app "${name}" backend did not pass ${healthPath} within ${budget}ms`)
    }
  }

  /**
   * Restart after an exit the app's manifest asked us to recover from.
   *
   * An explicit ``stop()`` never restarts (``record.stopping``), and the retry
   * budget is per record: a backend that keeps dying gives up and stays down
   * with the reason logged, rather than respawning forever.
   */
  #considerRestart(name, record, code) {
    if (record.stopping) return
    if (this.procs.get(name) !== record) return
    const { policy, maxRetries, backoffMs } = { ...DEFAULT_RESTART, ...(record.spec.restart ?? {}) }
    if (policy === 'never') return
    if (policy === 'on-failure' && code === 0) return
    if (record.restarts >= maxRetries) {
      this.logger.error(
        `app "${name}" backend exited ${record.restarts} time(s) and reached its restart budget — staying down`,
      )
      return
    }
    record.restarts += 1
    const delay = backoffMs * record.restarts
    this.logger.warn(`app "${name}" backend restarting in ${delay}ms (attempt ${record.restarts}/${maxRetries})`)
    record.restartTimer = setTimeout(() => {
      record.restartTimer = undefined
      if (record.stopping || this.procs.get(name) !== record) return
      this.#spawnOnce(name, record).catch((err) => {
        this.logger.error(`app "${name}" backend restart failed: ${err.message}`)
      })
    }, delay)
    record.restartTimer.unref()
  }

  /**
   * @param {string} name
   * @param {{script: string, dir?: string, healthCheck?: string,
   *          startupTimeoutMs?: number, restart?: object}} spec
   * @param {string} secret  the per-app proxy secret, injected into the child
   */
  async start(name, spec, secret) {
    const existing = this.procs.get(name)
    if (existing && existing.running) return this.status(name)

    const record = {
      spec,
      secret,
      child: null,
      pid: undefined,
      port: undefined,
      running: false,
      healthy: false,
      stopping: false,
      restarts: 0,
      restartTimer: undefined,
    }
    this.procs.set(name, record)
    await this.#spawnOnce(name, record)
    return this.status(name)
  }

  stop(name) {
    const record = this.procs.get(name)
    if (!record) return
    record.stopping = true
    record.running = false
    record.healthy = false
    if (record.restartTimer) clearTimeout(record.restartTimer)
    this.procs.delete(name)
    const child = record.child
    if (!child) return
    killTree(child, 'SIGTERM')
    setTimeout(() => killTree(child, 'SIGKILL'), KILL_ESCALATION_MS).unref()
    this.logger.info(`app "${name}" backend stopped  pid=${record.pid}`)
  }

  stopAll() {
    for (const name of [...this.procs.keys()]) this.stop(name)
  }
}
