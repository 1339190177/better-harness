/**
 * file-viewer — the artifact file tree as a hosted component.
 *
 * The host passes the data and keeps it current through the app-UI contract:
 *
 *   props (read at mount, refreshed via `sdk.events.on("props", next)`):
 *     artifacts  [{ id, label }]        the artifacts to browse
 *     scope      { kind: "all" } | { kind: "folder" | "file", value }
 *     labels     { all, treeAria, expand, collapse }  host-resolved strings
 *
 *   events (component → host):
 *     select     the next scope object, same shape as `scope`
 *
 * It ships no backend: nothing here reads the filesystem or the network. The
 * host owns the selection and what it previews; a click updates the tree's
 * own highlight immediately and tells the host, so the round trip is never
 * what the reader waits on.
 */

const SVG = {
  file: '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 256 256" fill="currentColor"><path d="M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Z"/></svg>',
  folder: '<svg aria-hidden="true" width="15" height="15" viewBox="0 0 256 256" fill="currentColor"><path d="M216,72H131.31L104,44.69A15.86,15.86,0,0,0,92.69,40H40A16,16,0,0,0,24,56V200.62A15.4,15.4,0,0,0,39.38,216H216.89A15.13,15.13,0,0,0,232,200.89V88A16,16,0,0,0,216,72ZM40,56H92.69l16,16H40ZM216,200H40V88H216Z"/></svg>',
  caretRight: '<svg aria-hidden="true" width="13" height="13" viewBox="0 0 256 256" fill="currentColor"><path d="M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z"/></svg>',
  caretDown: '<svg aria-hidden="true" width="13" height="13" viewBox="0 0 256 256" fill="currentColor"><path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"/></svg>',
};

const STYLE = `
.fv-root { display: flex; flex-direction: column; padding: var(--space-xs, 4px); overflow-y: auto; height: 100%; box-sizing: border-box; }
.fv-root button { display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 8px; border: 0; border-radius: var(--radius-xs, 6px); background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.fv-root button:hover { background: var(--color-surface-hover, rgba(127, 127, 127, 0.14)); }
.fv-root button:focus-visible { outline: 2px solid var(--color-focus, #0a5fd0); outline-offset: -2px; }
.fv-root button.selected { background: var(--color-surface-selected, rgba(127, 127, 127, 0.2)); }
.fv-root button strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: var(--weight-medium, 500); }
.fv-root button svg { flex: none; opacity: 0.7; }
.fv-root .fv-count { margin-left: auto; padding-left: 8px; opacity: 0.55; font-size: 0.85em; }
.fv-folder-row { display: flex; align-items: center; }
.fv-disclosure { flex: none; width: 22px !important; padding: 4px 0 !important; justify-content: center; }
`;

function basename(label) {
  const index = label.lastIndexOf('/');
  return index === -1 ? label : label.slice(index + 1);
}

/** Fold a flat label list into the folder tree the sidebar renders. */
function buildFolders(artifacts) {
  const root = { folders: [], files: [] };
  for (const artifact of artifacts) {
    const parts = String(artifact.label).split('/');
    if (parts.length < 2) continue;
    let current = root;
    let path = '';
    for (let i = 0; i < parts.length - 1; i += 1) {
      path = path === '' ? parts[i] : `${path}/${parts[i]}`;
      let folder = current.folders.find((candidate) => candidate.name === parts[i]);
      if (folder === undefined) {
        folder = { name: parts[i], path, folders: [], files: [] };
        current.folders.push(folder);
      }
      current = folder;
    }
    current.files.push(artifact);
  }
  return root.folders;
}

function folderCount(folder) {
  return folder.files.length + folder.folders.reduce((total, child) => total + folderCount(child), 0);
}

export default function mount(container, sdk) {
  let props = sdk.props ?? {};
  const collapsed = new Set();

  const style = document.createElement('style');
  style.textContent = STYLE;
  const root = document.createElement('nav');
  root.className = 'fv-root';
  root.setAttribute('role', 'tree');
  container.replaceChildren(style, root);

  const labels = () => ({
    all: 'All artifacts',
    treeAria: 'Artifacts',
    expand: 'Expand',
    collapse: 'Collapse',
    ...(props.labels ?? {}),
  });

  function select(next) {
    props = { ...props, scope: next };
    sdk.events.emit('select', next);
    render();
  }

  function fileButton(artifact, depth) {
    const scope = props.scope ?? {};
    const selected = scope.kind === 'file' && scope.value === artifact.id;
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'treeitem');
    button.setAttribute('aria-level', String(depth + 1));
    button.style.paddingLeft = `${8 + depth * 14}px`;
    if (selected) {
      button.classList.add('selected');
      button.setAttribute('aria-current', 'true');
    }
    button.insertAdjacentHTML('afterbegin', SVG.file);
    const name = document.createElement('strong');
    name.textContent = basename(String(artifact.label));
    button.append(name);
    button.addEventListener('click', () => select({ kind: 'file', value: artifact.id }));
    return button;
  }

  function folderRow(folder, depth) {
    const scope = props.scope ?? {};
    const isCollapsed = collapsed.has(folder.path);
    const row = document.createElement('div');
    row.className = 'fv-folder-row';
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(depth + 1));
    row.setAttribute('aria-expanded', String(!isCollapsed));
    row.style.paddingLeft = `${depth * 14}px`;
    const disclosure = document.createElement('button');
    disclosure.type = 'button';
    disclosure.className = 'fv-disclosure';
    disclosure.setAttribute('aria-label', `${isCollapsed ? labels().expand : labels().collapse}: ${folder.path}`);
    disclosure.innerHTML = isCollapsed ? SVG.caretRight : SVG.caretDown;
    disclosure.addEventListener('click', () => {
      if (isCollapsed) collapsed.delete(folder.path);
      else collapsed.add(folder.path);
      render();
    });
    const button = document.createElement('button');
    button.type = 'button';
    if (scope.kind === 'folder' && scope.value === folder.path) {
      button.classList.add('selected');
      button.setAttribute('aria-current', 'true');
    }
    button.insertAdjacentHTML('afterbegin', SVG.folder);
    const name = document.createElement('strong');
    name.textContent = folder.name;
    const count = document.createElement('span');
    count.className = 'fv-count';
    count.textContent = String(folderCount(folder));
    button.append(name, count);
    button.addEventListener('click', () => select({ kind: 'folder', value: folder.path }));
    row.append(disclosure, button);
    const children = document.createElement('div');
    children.setAttribute('role', 'group');
    if (!isCollapsed) {
      for (const child of folder.folders) children.append(folderRow(child, depth + 1));
      for (const file of folder.files) children.append(fileButton(file, depth + 1));
    }
    return children.childElementCount === 0 ? row : [row, children];
  }

  function render() {
    const l = labels();
    const artifacts = Array.isArray(props.artifacts) ? props.artifacts : [];
    const scope = props.scope ?? { kind: 'all' };
    root.setAttribute('aria-label', l.treeAria);
    const all = document.createElement('button');
    all.type = 'button';
    all.setAttribute('role', 'treeitem');
    all.setAttribute('aria-level', '1');
    if (scope.kind === 'all') {
      all.classList.add('selected');
      all.setAttribute('aria-current', 'true');
    }
    all.insertAdjacentHTML('afterbegin', SVG.folder);
    const allName = document.createElement('strong');
    allName.textContent = l.all;
    const allCount = document.createElement('span');
    allCount.className = 'fv-count';
    allCount.textContent = String(artifacts.length);
    all.append(allName, allCount);
    all.addEventListener('click', () => select({ kind: 'all' }));
    const nodes = [all];
    for (const artifact of artifacts) {
      if (!String(artifact.label).includes('/')) nodes.push(fileButton(artifact, 0));
    }
    for (const folder of buildFolders(artifacts)) {
      const rendered = folderRow(folder, 0);
      if (Array.isArray(rendered)) nodes.push(...rendered);
      else nodes.push(rendered);
    }
    root.replaceChildren(...nodes);
  }

  // The host refreshes props without remounting, so its own view state (which
  // folders are open) survives every update.
  sdk.events.on('props', (next) => {
    props = next ?? {};
    render();
  });

  render();
  return () => container.replaceChildren();
}
