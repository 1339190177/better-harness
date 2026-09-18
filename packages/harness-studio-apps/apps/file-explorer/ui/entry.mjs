/**
 * File Explorer app UI — the reference implementation of the app-UI contract.
 *
 * Served at /apps/file-explorer/ui/entry.mjs (declared as ``ui.entry`` in
 * app.json). A host imports this module and calls the default export with the
 * container element and an SDK built by ``createAppSdk`` (client.mjs).
 *
 * Everything the UI needs comes from ``sdk.api``: calls run through
 * ``/apps/file-explorer/api/*`` and the host proxy signs them in transit — the
 * app never sees a secret. The UI is deliberately plain DOM: no build step, no
 * framework, no imports, so the contract stays the only coupling.
 *
 * Backend endpoints this file uses (see apps/file-explorer/server.mjs):
 *   GET tree?path=<p>&depth=1  -> { path, entries, truncated }
 *   GET read?path=<p>          -> { path, size, mime, content, binary, truncated }
 */
export default function mount(container, sdk) {
  const style = document.createElement('style')
  style.textContent = `
    .fe-root { display: flex; flex-direction: column; height: 100%; min-height: 0;
      font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #d5d9e0; background: #14161a; }
    .fe-bar { display: flex; gap: 8px; align-items: center; padding: 8px 10px;
      border-bottom: 1px solid #2a2e35; }
    .fe-bar input { flex: 1; min-width: 0; padding: 4px 8px; border-radius: 6px;
      border: 1px solid #2a2e35; background: #1b1e23; color: inherit; font: inherit; }
    .fe-bar button { display: inline-flex; align-items: center; justify-content: center;
      min-width: 26px; height: 24px; padding: 0 4px; border: 0; border-radius: 6px;
      background: transparent; color: #8b93a1; font: inherit; cursor: pointer; }
    .fe-bar button:hover { background: #23272e; color: #d5d9e0; }
    .fe-bar button svg { flex: none; }
    .fe-status { padding: 4px 10px; color: #8b93a1; border-bottom: 1px solid #2a2e35; }
    .fe-body { display: grid; grid-template-columns: minmax(220px, 320px) 1fr;
      flex: 1; min-height: 0; }
    .fe-list { overflow: auto; border-right: 1px solid #2a2e35; padding: 4px 0; }
    .fe-list div { padding: 3px 10px; cursor: pointer; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; }
    .fe-list div:hover { background: #23272e; }
    .fe-list .fe-dir { font-weight: 600; }
    .fe-list .fe-size { float: right; color: #8b93a1; font-weight: 400; }
    .fe-preview { overflow: auto; margin: 0; padding: 10px 12px; }
    .fe-preview[data-kind="message"] { color: #8b93a1; }
    /* The host mirrors its color mode on the container as data-hs-theme, so
       the light overrides match any ancestor — a runtime theme switch keeps
       working without the entry re-rendering. */
    [data-hs-theme="light"] .fe-root { color: #23262b; background: #ffffff; }
    [data-hs-theme="light"] .fe-bar { border-color: #e3e6ea; }
    [data-hs-theme="light"] .fe-bar input { border-color: #d8dce1; background: #f7f8fa; }
    [data-hs-theme="light"] .fe-bar button { color: #6b7280; }
    [data-hs-theme="light"] .fe-bar button:hover { background: #eceef1; color: #23262b; }
    [data-hs-theme="light"] .fe-status { border-color: #e3e6ea; color: #6b7280; }
    [data-hs-theme="light"] .fe-list { border-color: #e3e6ea; }
    [data-hs-theme="light"] .fe-list div:hover { background: #f1f3f5; }
    .fe-status[data-kind="error"] { color: #e5534b; }
    [data-hs-theme="light"] .fe-status[data-kind="error"] { color: #d93025; }
  `

  const root = document.createElement('div')
  root.className = 'fe-root'
  root.dataset.hsTheme = sdk.theme?.mode ?? 'dark'

  // The browsing root: the backend's home allow-list entry, learned from
  // /health. Every tree call needs an explicit path, and the allow-list
  // starts at home — so home is both the initial view and the ceiling.
  let homePath = ''

  const bar = document.createElement('div')
  bar.className = 'fe-bar'
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'path…'
  input.spellcheck = false
  const up = document.createElement('button')
  up.insertAdjacentHTML('afterbegin', '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 256 256" fill="currentColor"><path d="M205.66,117.66a8,8,0,0,1-11.32,0L136,59.31V216a8,8,0,0,1-16,0V59.31L61.66,117.66a8,8,0,0,1-11.32-11.32l72-72a8,8,0,0,1,11.32,0l72,72A8,8,0,0,1,205.66,117.66Z"/></svg>')
  up.title = 'Go up one level'
  up.setAttribute('aria-label', 'Go up one level')
  const home = document.createElement('button')
  home.insertAdjacentHTML('afterbegin', '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 256 256" fill="currentColor"><path d="M219.31,108.68l-80-80a16,16,0,0,0-22.62,0l-80,80A15.87,15.87,0,0,0,32,120v96a8,8,0,0,0,8,8h64a8,8,0,0,0,8-8V160h32v56a8,8,0,0,0,8,8h64a8,8,0,0,0,8-8V120A15.87,15.87,0,0,0,219.31,108.68ZM208,208H160V152a8,8,0,0,0-8-8H104a8,8,0,0,0-8,8v56H48V120l80-80,80,80Z"/></svg>')
  home.title = 'Go to home'
  home.setAttribute('aria-label', 'Go to home')
  bar.append(up, home, input)

  const status = document.createElement('div')
  status.className = 'fe-status'

  const body = document.createElement('div')
  body.className = 'fe-body'
  const list = document.createElement('div')
  list.className = 'fe-list'
  const preview = document.createElement('pre')
  preview.className = 'fe-preview'
  body.append(list, preview)

  root.append(bar, status, body)
  container.replaceChildren(style, root)

  const setStatus = (text, kind = 'info') => {
    status.textContent = text
    status.dataset.kind = kind
  }
  const setPreview = (text, kind = 'content') => {
    preview.textContent = text
    preview.dataset.kind = kind
  }
  const failure = (err) => setStatus(`${err.name === 'AppApiError' ? 'HTTP' : 'Error'} ${err.message}`, 'error')

  const prettySize = (size) => {
    if (typeof size !== 'number' || size <= 0) return ''
    if (size < 1024) return `${size} B`
    if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
    return `${(size / 1024 / 1024).toFixed(1)} MB`
  }

  async function open(path) {
    if (!path) {
      failure(new Error('no path to open'))
      return
    }
    try {
      const data = await sdk.api.get(`tree?depth=1&path=${encodeURIComponent(path)}`)
      input.value = data.path ?? path ?? ''
      list.replaceChildren()
      for (const entry of data.entries ?? []) {
        const row = document.createElement('div')
        const dir = entry.type === 'dir'
        row.className = dir ? 'fe-dir' : 'fe-file'
        row.textContent = `${dir ? '▸' : '·'} ${entry.name}`
        const size = document.createElement('span')
        size.className = 'fe-size'
        size.textContent = dir ? '' : prettySize(entry.size)
        row.append(size)
        row.title = entry.path ?? entry.name
        if (dir && entry.path) row.addEventListener('click', () => open(entry.path))
        else if (entry.path) row.addEventListener('click', () => read(entry.path))
        list.append(row)
      }
      setStatus(`${data.entries?.length ?? 0} entries${data.truncated ? ' (truncated)' : ''}`)
      setPreview('Select a file…', 'message')
    } catch (err) {
      failure(err)
    }
  }

  async function read(path) {
    try {
      const data = await sdk.api.get(`read?path=${encodeURIComponent(path)}`)
      if (data.binary) setPreview(`${data.mime || 'binary file'} — ${prettySize(data.size)}, not rendered`, 'message')
      else if (data.truncated) setPreview(`${data.content ?? ''}\n… truncated at ${prettySize(data.size)}`, 'content')
      else setPreview(data.content ?? '', 'content')
      setStatus(`${data.path} — ${prettySize(data.size) || '0 B'}${data.truncated ? ' (partial)' : ''}`)
    } catch (err) {
      failure(err)
    }
  }

  const goUp = () => {
    const current = input.value.replace(/\/+$/, '')
    // Home is the ceiling: one level above it is outside the allow-list and
    // only earns a 400.
    if (!current || !homePath || current === homePath || !current.startsWith(homePath + '/')) return
    open(current.slice(0, current.lastIndexOf('/')))
  }
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') open(input.value.trim())
  })
  up.addEventListener('click', goUp)
  home.addEventListener('click', () => open(homePath))
  setPreview('Loading…', 'message')
  void (async () => {
    try {
      const health = await sdk.api.get('health')
      homePath = health.home ?? health.allowedRoots?.[0] ?? ''
      await open(homePath)
    } catch (err) {
      failure(err)
    }
  })()

  return () => container.replaceChildren()
}
