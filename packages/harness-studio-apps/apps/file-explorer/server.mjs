/**
 * File Explorer backend for the Kiro Crew Node host — the Node twin of
 * ``kiro_crew.apps.builtins.file_explorer.server``.
 *
 * A stdlib-only HTTP server exposing a READ-ONLY filesystem API. The host
 * proxies ``/apps/file-explorer/api/*`` to this process; the process sees the
 * request at ``/api/<path>`` and strips the prefix itself, exactly like the
 * Python backend. Every non-health request must carry a fresh
 * ``X-KiroCrew-Proxy`` HMAC signed with ``KIROCREW_PROXY_SECRET``.
 *
 * Endpoints (same shapes as the official backend):
 *   GET /health                                    -> { status, allowedRoots, home, ... }
 *   GET /resolve?path=<p>                          -> { path, exists, type, size, mtime }
 *   GET /tree?path=<p>&depth=<1..4>&ignore=<0|1>   -> { path, entries, truncated }
 *   GET /read?path=<p>&max_bytes=<n>               -> { path, size, mtime, mime, encoding, content, truncated, binary }
 *   GET /search?path=<p>&q=&include=&exclude=      -> { results, engine, truncated }
 *   GET /git-status?path=<p>                       -> { repoRoot, branch, statuses }
 *   GET /complete?path=<p>&kind=<dir|all>&limit=   -> { parent, prefix, entries }
 *
 * Path safety: callers may only reach paths under the user's home dir or the
 * system temp dir (plus ``/home`` and ``/opt`` on POSIX), after symlink
 * resolution; credential directories and the Kiro Crew data home (except its
 * explicitly safe subdirs) are denied. Anything else answers 403.
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import * as fsSync from 'node:fs'
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  lstatSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { verifyProxyRequest } from '../../lib/proxyAuth.mjs'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 9100)
const HOST = process.env.HOST || '127.0.0.1'
const APP_NAME = process.env.KIROCREW_APP_NAME || 'file-explorer'
const VERSION = '0.2.1'

const MAX_READ_BYTES = Number(process.env.FE_MAX_READ_BYTES || 4 * 1024 * 1024) // 4 MB
const MAX_TREE_ENTRIES = Number(process.env.FE_MAX_TREE_ENTRIES || 5000)
const MAX_SEARCH_RESULTS = Number(process.env.FE_MAX_SEARCH_RESULTS || 500)
const SEARCH_TIMEOUT_MS = Number(process.env.FE_SEARCH_TIMEOUT_SEC || 15) * 1000
const GIT_TIMEOUT_MS = Number(process.env.FE_GIT_TIMEOUT_SEC || 5) * 1000

function resolvedDirOrNull(p) {
  try {
    if (!existsSync(p)) return null
    return realpathSync(p)
  } catch {
    return null
  }
}

// Ordered allow-list of browsing roots: home, tmp, then POSIX conventions.
const HOME = resolvedDirOrNull(homedir()) ?? resolvedDirOrNull(tmpdir())
const TMP = resolvedDirOrNull(tmpdir())
const ALLOWED_ROOTS = [...new Set(
  [HOME, TMP, ...(process.platform === 'win32' ? [] : [resolvedDirOrNull('/home'), resolvedDirOrNull('/opt')])]
    .filter(Boolean),
)]

const IGNORE_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache', 'venv', '.venv',
  'env', '.env', 'dist', 'build', 'out', '.next', 'target', '.gradle', '.idea', '.vscode',
  '.cache', 'bower_components', '.tox', '.eggs', 'htmlcov', '.coverage', '.DS_Store',
])

// Credential directories — filtered from tree/search/complete (DENY-list: folded).
const SENSITIVE_DIRS = new Set([
  '.ssh', '.aws', '.gnupg', '.docker', '.kube', '.npmrc', '.pypirc', '.netrc',
  '.git-credentials',
])
const SENSITIVE_DIRS_CF = new Set([...SENSITIVE_DIRS].map((d) => d.toLowerCase()))

// Individual credential file names that must never be served even inside an
// otherwise-allowed directory (subset of the gateway's is_sensitive_path()).
const SENSITIVE_FILES_CF = new Set([
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'credentials', 'token_signing.key',
  'sel_hmac.key', 'memory.db', 'security_policy.json', 'admission_policy.json',
  'computer_use.json',
])

// Kiro Crew data-home subdirectories that stay accessible; everything else
// under the data home is denied by default.
const KIROCREW_SAFE_SUBDIRS = new Set([
  'workspace', 'uploads', 'skills', 'artifacts', 'apps', 'app-sources',
  'workflows', 'pods', 'logs', 'crons',
])

// Matched case-insensitively; the segment AFTER the marker is the policy subject.
const CREW_HOME_MARKERS = [
  ['.kiro', 'crew'],
  ['.kirocrew'],
]

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff', '.pdf', '.zip', '.tar',
  '.gz', '.bz2', '.7z', '.rar', '.so', '.dylib', '.dll', '.exe', '.class', '.jar', '.war',
  '.o', '.a', '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.webm', '.sqlite', '.db',
  '.duckdb', '.ttf', '.otf', '.woff', '.woff2', '.eot',
])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg'])

const MIME_OVERRIDES = {
  '.md': 'text/markdown', '.markdown': 'text/markdown', '.ts': 'text/typescript',
  '.tsx': 'text/jsx', '.jsx': 'text/jsx', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
}

const MIME_BY_EXT = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.yml': 'text/yaml', '.yaml': 'text/yaml', '.sh': 'text/x-shellscript', '.py': 'text/x-python',
  '.txt': 'text/plain', '.log': 'text/plain', '.toml': 'text/plain', '.xml': 'text/xml',
}

// ---------------------------------------------------------------------------
// Logging / audits
// ---------------------------------------------------------------------------

function log(level, ...args) {
  console.log(`[${APP_NAME}] ${level}`, ...args)
}
function audit(operation, resources, outcome = 'granted') {
  // The official backend writes SEL audit records; the compat host keeps the
  // same signal on stdout (there is no kiro_crew SEL service to call).
  log('AUDIT', `${operation} ${outcome} ${resources}`)
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

class PathError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

function expandPath(raw) {
  if (!raw) throw new PathError('path is required', 400)
  let p = raw
  if (p === '~') p = homedir()
  else if (p.startsWith('~/')) p = join(homedir(), p.slice(2))
  return resolve(p)
}

function isWithin(candidate, root) {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function crewHomeIndex(parts) {
  const cf = parts.map((p) => p.toLowerCase())
  for (const marker of CREW_HOME_MARKERS) {
    for (let i = 0; i + marker.length <= cf.length; i += 1) {
      let hit = true
      for (let j = 0; j < marker.length; j += 1) {
        if (cf[i + j] !== marker[j]) {
          hit = false
          break
        }
      }
      if (hit) return i + marker.length
    }
  }
  return -1
}

const isCrewHomeRoot = (p) => crewHomeIndex(p.split(sep)) === p.split(sep).length

function isSensitive(p) {
  const parts = p.split(sep)
  if (parts.some((part) => SENSITIVE_DIRS_CF.has(part.toLowerCase()))) return true
  const name = basename(p).toLowerCase()
  if (SENSITIVE_FILES_CF.has(name)) return true
  const after = crewHomeIndex(parts)
  if (after !== -1) {
    if (after >= parts.length) return true // the data-home root itself
    if (!KIROCREW_SAFE_SUBDIRS.has(parts[after])) return true
  }
  return false
}

function safePath(raw, { mustExist = true } = {}) {
  const p = expandPath(raw)
  const inAllow = ALLOWED_ROOTS.some((root) => isWithin(p, root))
  if (!inAllow) throw new PathError(`path not allowed: ${p}`, 403)
  if (isSensitive(p)) throw new PathError('access denied: sensitive path', 403)
  if (mustExist && !existsSync(p)) throw new PathError(`not found: ${p}`, 404)
  return p
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function fileKind(p) {
  try {
    const st = statSync(p) // follows symlinks: a symlink to a dir behaves like a dir
    if (st.isDirectory()) return 'dir'
    if (st.isFile()) return 'file'
  } catch {
    /* fall through */
  }
  try {
    if (lstatSync(p).isSymbolicLink()) return 'symlink'
  } catch {
    /* fall through */
  }
  return 'other'
}

function entryMeta(p) {
  let st
  try {
    st = statSync(p)
  } catch {
    return { name: basename(p), path: p, type: 'missing', size: 0, mtime: 0 }
  }
  const kind = fileKind(p)
  const info = { name: basename(p), path: p, type: kind, mtime: Math.trunc(st.mtimeMs / 1000) }
  if (kind === 'file') info.size = st.size
  else if (kind === 'dir') {
    info.size = 0
    try {
      if (existsSync(join(p, '.git'))) info.isGitRoot = true
    } catch {
      /* unreadable dir */
    }
  } else info.size = 0
  return info
}

function listDir(root, depth = 1, ignore = true) {
  let count = 0
  let truncated = false

  function walk(dir, remaining) {
    if (count >= MAX_TREE_ENTRIES) {
      truncated = true
      return []
    }
    let children
    try {
      children = readdirSync(dir, { withFileTypes: true }).map((d) => join(dir, d.name))
    } catch (err) {
      return [{ name: basename(dir), path: dir, type: 'error', error: String(err.message || err) }]
    }
    children.sort((a, b) => {
      const aDir = fileKind(a) === 'dir' ? 0 : 1
      const bDir = fileKind(b) === 'dir' ? 0 : 1
      if (aDir !== bDir) return aDir - bDir
      return basename(a).toLowerCase().localeCompare(basename(b).toLowerCase())
    })
    const items = []
    for (const child of children) {
      if (count >= MAX_TREE_ENTRIES) {
        truncated = true
        items.push({ name: '...', path: dir, type: 'truncated', size: 0, mtime: 0 })
        break
      }
      const name = basename(child)
      if (SENSITIVE_DIRS_CF.has(name.toLowerCase())) continue
      if (isCrewHomeRoot(dir) && !KIROCREW_SAFE_SUBDIRS.has(name)) continue
      if (ignore && IGNORE_DIRS.has(name)) continue
      count += 1
      const meta = entryMeta(child)
      if (remaining > 1 && meta.type === 'dir' && !isSensitive(child)) {
        try {
          const resolvedChild = realpathSync(child)
          if (ALLOWED_ROOTS.some((root) => isWithin(resolvedChild, root))) {
            meta.children = walk(child, remaining - 1)
          }
        } catch {
          /* dangling symlink */
        }
      }
      items.push(meta)
    }
    return items
  }

  return { entries: walk(root, depth), truncated }
}

function isBinaryFile(p) {
  if (BINARY_EXTS.has(extname(p).toLowerCase())) return true
  try {
    const fd = readFileSync(p, { encoding: null })
    return fd.subarray(0, 8192).includes(0)
  } catch {
    return false
  }
}

/** Read at most the first `maxBytes` bytes without loading the whole file. */
function readPrefix(p, maxBytes) {
  const { openSync, readSync, closeSync } = fsSync
  const fd = openSync(p, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    const bytesRead = readSync(fd, buffer, 0, maxBytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    closeSync(fd)
  }
}

function guessMime(p) {
  const ext = extname(p).toLowerCase()
  return MIME_OVERRIDES[ext] || MIME_BY_EXT[ext] || 'text/plain'
}

// ---------------------------------------------------------------------------
// Git status
// ---------------------------------------------------------------------------

function runGit(args, timeoutMs) {
  return new Promise((resolvePromise) => {
    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill('SIGKILL')
        resolvePromise({ ok: false, stdout, stderr: 'timed out', code: null })
      }
    }, timeoutMs)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ ok: false, stdout, stderr: String(err.message || err), code: null })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ ok: code === 0, stdout, stderr, code })
    })
  })
}

function gitRepoRoot(start) {
  let dir = start
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

async function gitStatus(repoRoot) {
  const out = { repoRoot, branch: '', statuses: {} }
  const branch = await runGit(['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], GIT_TIMEOUT_MS)
  if (branch.ok) out.branch = branch.stdout.trim()
  else if (branch.stderr) out.branch_error = branch.stderr.trim()

  const status = await runGit(['-C', repoRoot, 'status', '--porcelain=1', '-z'], GIT_TIMEOUT_MS)
  if (!status.ok) {
    out.status_error = status.stderr.trim() || `git exit ${status.code}`
    return out
  }
  // -z output: NUL-delimited records "XY path"; renames carry a second path.
  const parts = status.stdout.split('\0')
  for (let i = 0; i < parts.length; i += 1) {
    const record = parts[i]
    if (!record || record.length < 3) continue
    const code = record.slice(0, 2).trim() || record.slice(0, 2)
    out.statuses[record.slice(3)] = code
    if (record[0] === 'R' || record[0] === 'C') i += 1 // skip rename source
  }
  return out
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function hasRg() {
  const paths = (process.env.PATH || '').split(sep === '\\' ? ';' : ':')
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  return paths.some((dir) => dir && exts.some((ext) => existsSync(join(dir, `rg${ext}`))))
}

const TCC_DIRS_AT_HOME = ['Desktop', 'Documents', 'Downloads', 'Movies', 'Music', 'Pictures']

async function search(root, query, include, exclude) {
  if (!query) return { results: [], engine: hasRg() ? 'rg' : 'python' }
  if (hasRg()) {
    const viaRg = await searchRg(root, query, include, exclude)
    if (viaRg) return viaRg
  }
  return { results: searchFallback(root, query, include, exclude), engine: 'python' }
}

function globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`(^|/)${escaped}$`)
}

async function searchRg(root, query, include, exclude) {
  const args = ['--json', '--max-count', '20', '--no-messages', '--smart-case', '--hidden']
  for (const ig of IGNORE_DIRS) args.push('--glob', `!**/${ig}`)
  for (const g of (include || '').split(',').map((s) => s.trim()).filter(Boolean)) args.push('--glob', g)
  for (const g of (exclude || '').split(',').map((s) => s.trim()).filter(Boolean)) args.push('--glob', `!${g}`)
  // Sensitive exclusions LAST and case-insensitive — always enforced.
  for (const sd of SENSITIVE_DIRS) args.push('--iglob', `!**/${sd}`)
  if (crewHomeIndex(root.split(sep)) === -1) {
    args.push('--iglob', '!**/.kiro/crew/**', '--iglob', '!**/.kirocrew/**')
  }
  if (root === HOME && process.platform === 'darwin') {
    for (const name of TCC_DIRS_AT_HOME) args.push('--glob', `!/${name}`)
  }
  args.push('--', query, root)

  const result = await runChild('rg', args, SEARCH_TIMEOUT_MS)
  if (!result) return null // spawn failed or timed out → fall back

  const out = []
  for (const line of result.split('\n')) {
    if (!line.trim()) continue
    if (out.length >= MAX_SEARCH_RESULTS) break
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (obj.type !== 'match') continue
    const file = obj.data?.path?.text || ''
    if (file.split(sep).some((part) => SENSITIVE_DIRS_CF.has(part.toLowerCase()))) continue
    const sub = (obj.data?.submatches || [])[0]
    out.push({
      file,
      line: Number(obj.data?.line_number || 0),
      col: sub ? Number(sub.start) + 1 : 0,
      preview: String(obj.data?.lines?.text || '').replace(/\n$/, '').slice(0, 400),
    })
  }
  return { results: out, engine: 'rg' }
}

function runChild(cmd, args, timeoutMs) {
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolvePromise(null)
      return
    }
    let stdout = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      resolvePromise(null)
    }, timeoutMs)
    child.stdout.on('data', (d) => (stdout += d))
    child.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(null)
    })
    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(stdout)
    })
  })
}

function searchFallback(root, query, include, exclude) {
  const deadline = Date.now() + SEARCH_TIMEOUT_MS
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  const incGlobs = (include || '').split(',').map((s) => s.trim()).filter(Boolean).map(globToRegex)
  const excGlobs = (exclude || '').split(',').map((s) => s.trim()).filter(Boolean).map(globToRegex)
  const out = []
  const queue = [root]
  while (queue.length) {
    if (Date.now() > deadline || out.length >= MAX_SEARCH_RESULTS) break
    const dir = queue.shift()
    let children
    try {
      children = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      const full = join(dir, child.name)
      if (child.isDirectory()) {
        if (IGNORE_DIRS.has(child.name) || SENSITIVE_DIRS_CF.has(child.name.toLowerCase())) continue
        if (isCrewHomeRoot(dir) && !KIROCREW_SAFE_SUBDIRS.has(child.name)) continue
        if (dir === HOME && process.platform === 'darwin' && TCC_DIRS_AT_HOME.includes(child.name)) continue
        queue.push(full)
        continue
      }
      if (out.length >= MAX_SEARCH_RESULTS) break
      const ext = extname(child.name).toLowerCase()
      if (BINARY_EXTS.has(ext)) continue
      if (incGlobs.length && !incGlobs.some((re) => re.test(full))) continue
      if (excGlobs.some((re) => re.test(full))) continue
      if (isSensitive(full)) continue
      let text
      try {
        text = readFileSync(full, 'utf-8')
      } catch {
        continue
      }
      const lines = text.split(/\r?\n/)
      for (let n = 0; n < lines.length; n += 1) {
        const match = pattern.exec(lines[n])
        if (match) {
          out.push({ file: full, line: n + 1, col: match.index + 1, preview: lines[n].slice(0, 400) })
          break // one match per file is enough for the list
        }
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function authorized(req, pathname) {
  // Health stays unauthenticated: the host's liveness probe hits it unsigned.
  const route = pathname.replace(/\/+$/, '')
  if (route === '' || route === '/health' || route === '/api' || route === '/api/health') return true
  const body = Buffer.alloc(0) // every endpoint here is a bodyless GET
  return verifyProxyRequest(req.headers['x-kirocrew-proxy'] || '', {
    method: req.method,
    target: req.url,
    body,
  })
}

function one(qs, key, fallback = '') {
  const value = qs.get(key)
  return value === null ? fallback : value
}

function intParam(qs, key, fallback) {
  const value = Number(one(qs, key, String(fallback)))
  return Number.isFinite(value) ? value : fallback
}

async function handleGet(req, res, url) {
  let route = url.pathname.replace(/\/+$/, '')
  if (route.startsWith('/api/')) route = route.slice(4) || '/'
  else if (route === '/api') route = '/'
  const qs = url.searchParams

  if (route === '' || route === '/health') {
    return sendJson(res, 200, {
      status: 'ok',
      app: APP_NAME,
      version: VERSION,
      rg: hasRg(),
      allowedRoots: ALLOWED_ROOTS,
      home: HOME,
      maxReadBytes: MAX_READ_BYTES,
    })
  }

  if (route === '/resolve') {
    const p = safePath(one(qs, 'path'), { mustExist: false })
    audit('resolve', p)
    const meta = existsSync(p)
      ? entryMeta(p)
      : { name: basename(p), path: p, type: 'missing', size: 0, mtime: 0 }
    meta.exists = existsSync(p)
    return sendJson(res, 200, meta)
  }

  if (route === '/tree') {
    const raw = one(qs, 'path')
    const depth = Math.max(1, Math.min(intParam(qs, 'depth', 1), 4))
    const ignore = !['0', 'false'].includes(one(qs, 'ignore', '1'))
    const expanded = expandPath(raw)

    // Data-home root: deny-by-default, but expose ONLY the safe subdirs.
    if (isCrewHomeRoot(expanded)) {
      const inAllow = ALLOWED_ROOTS.some((root) => isWithin(expanded, root))
      if (!inAllow) throw new PathError(`path not allowed: ${expanded}`, 403)
      if (existsSync(expanded) && statSync(expanded).isDirectory()) {
        audit('tree_list', expanded)
        const entries = readdirSync(expanded, { withFileTypes: true })
          .filter((d) => d.isDirectory() && KIROCREW_SAFE_SUBDIRS.has(d.name))
          .map((d) => entryMeta(join(expanded, d.name)))
          .sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name))
        return sendJson(res, 200, { path: expanded, entries, truncated: false })
      }
    }

    const p = safePath(raw, { mustExist: true })
    if (!statSync(p).isDirectory()) throw new PathError(`not a directory: ${p}`, 400)
    audit('tree_list', p)
    const { entries, truncated } = listDir(p, depth, ignore)
    return sendJson(res, 200, { path: p, entries, truncated })
  }

  if (route === '/read') {
    const p = safePath(one(qs, 'path'), { mustExist: true })
    const maxBytes = Math.max(1, Math.min(intParam(qs, 'max_bytes', MAX_READ_BYTES), MAX_READ_BYTES))
    if (!statSync(p).isFile()) throw new PathError(`not a regular file: ${p}`, 400)
    audit('file_read', p)
    const st = statSync(p)
    const mime = guessMime(p)
    const isImage = IMAGE_EXTS.has(extname(p).toLowerCase())
    const isBinary = isBinaryFile(p) && !isImage
    const body = {
      path: p,
      size: st.size,
      mtime: Math.trunc(st.mtimeMs / 1000),
      mime,
      binary: isBinary,
      truncated: false,
      encoding: 'utf-8',
      content: '',
    }
    if (isBinary) return sendJson(res, 200, body)
    if (isImage) {
      if (st.size <= maxBytes) {
        body.encoding = 'base64'
        body.content = readFileSync(p).toString('base64')
      } else {
        body.binary = true // too large to inline
      }
      return sendJson(res, 200, body)
    }
    const truncated = st.size > maxBytes
    body.truncated = truncated
    body.content = readPrefix(p, maxBytes).toString('utf-8')
    return sendJson(res, 200, body)
  }

  if (route === '/search') {
    const p = safePath(one(qs, 'path'), { mustExist: true })
    const q = one(qs, 'q')
    if (!statSync(p).isDirectory()) throw new PathError(`not a directory: ${p}`, 400)
    if (!q.trim()) return sendJson(res, 200, { results: [], engine: hasRg() ? 'rg' : 'python' })
    audit('file_search', `${p} q=${q}`)
    const { results, engine } = await search(p, q, one(qs, 'include'), one(qs, 'exclude'))
    return sendJson(res, 200, { results, engine, truncated: results.length >= MAX_SEARCH_RESULTS })
  }

  if (route === '/git-status') {
    const p = safePath(one(qs, 'path'), { mustExist: true })
    audit('git_status', p)
    const start = statSync(p).isDirectory() ? p : dirname(p)
    const repo = gitRepoRoot(start)
    if (!repo) return sendJson(res, 200, { repoRoot: '', branch: '', statuses: {} })
    if (!ALLOWED_ROOTS.some((root) => isWithin(repo, root))) {
      throw new PathError(`git repo root not allowed: ${repo}`, 403)
    }
    return sendJson(res, 200, await gitStatus(repo))
  }

  if (route === '/complete') {
    const raw = one(qs, 'path')
    const kind = one(qs, 'kind', 'dir')
    const limit = Math.max(1, Math.min(intParam(qs, 'limit', 30), 200))
    if (!raw) return sendJson(res, 200, { entries: [] })

    const expanded = raw === '~' ? HOME : raw.startsWith('~/') ? join(HOME, raw.slice(2)) : raw
    const trailingSlash = expanded.endsWith('/')
    let parentStr = trailingSlash ? expanded.replace(/\/+$/, '') || '/' : dirname(expanded) || '/'
    let prefix = trailingSlash ? '' : basename(expanded)

    const containedParent = (candidate) => {
      const p = resolve(candidate)
      if (!ALLOWED_ROOTS.some((root) => isWithin(p, root))) return null
      return p
    }
    let parent = containedParent(parentStr)
    if (!parent) {
      // A bare allowed root reduces to its dirname — legitimately outside the
      // allow-list. Retry the input itself, completing it like its slash form.
      if (trailingSlash) return sendJson(res, 200, { entries: [] })
      const retry = containedParent(expanded)
      if (!retry) return sendJson(res, 200, { entries: [] })
      parent = retry
      prefix = ''
    }
    if (isSensitive(parent)) return sendJson(res, 200, { entries: [] })
    if (!existsSync(parent) || !statSync(parent).isDirectory()) {
      return sendJson(res, 200, { entries: [] })
    }
    audit('complete', parent)

    const plower = prefix.toLowerCase()
    const entries = []
    const children = readdirSync(parent, { withFileTypes: true })
      .map((d) => join(parent, d.name))
      .sort((a, b) => {
        const aDir = fileKind(a) === 'dir' ? 0 : 1
        const bDir = fileKind(b) === 'dir' ? 0 : 1
        return aDir - bDir || basename(a).toLowerCase().localeCompare(basename(b).toLowerCase())
      })
    for (const child of children) {
      if (entries.length >= limit) break
      const name = basename(child)
      if (IGNORE_DIRS.has(name)) continue
      if (SENSITIVE_DIRS_CF.has(name.toLowerCase())) continue
      if (isCrewHomeRoot(parent) && !KIROCREW_SAFE_SUBDIRS.has(name)) continue
      if (plower && !name.toLowerCase().startsWith(plower)) continue
      const isDir = fileKind(child) === 'dir'
      if (kind === 'dir' && !isDir) continue
      entries.push({ name, path: child + (isDir ? '/' : ''), type: isDir ? 'dir' : fileKind(child) })
    }
    return sendJson(res, 200, { parent, prefix, entries })
  }

  sendJson(res, 404, { error: `${req.method} ${route} not found` })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: `method ${req.method} not allowed` })
  }
  if (!authorized(req, url.pathname)) {
    audit('proxy_auth_failed', req.url, 'denied')
    return sendJson(res, 401, { error: 'unauthorized' })
  }
  try {
    await handleGet(req, res, url)
  } catch (err) {
    if (err instanceof PathError) {
      if (err.status === 403) audit('access_denied', url.pathname + url.search, 'denied')
      return sendJson(res, err.status, { error: err.message })
    }
    const id = Math.random().toString(16).slice(2, 14)
    log('ERROR', `GET ${req.url} failed [${id}]`, err)
    sendJson(res, 500, { error: 'internal error', id })
  }
})

server.listen(PORT, HOST, () => {
  log('INFO', `listening on http://${HOST}:${PORT}  rg=${hasRg()}  allowed=${ALLOWED_ROOTS.join(', ')}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('INFO', 'shutting down')
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1000).unref()
  })
}
