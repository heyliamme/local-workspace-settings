// The overview webview. Builds the DOM with textContent only (no HTML from data).
import type { KeyInfo } from '../src/core/merge';
import type { HostCommand, State, TargetView, ToHost, ToWebview } from '../src/protocol';

declare function acquireVsCodeApi(): { postMessage(m: ToHost): void; getState(): any; setState(s: any): void };
const vscode = acquireVsCodeApi();
const post = (m: ToHost) => vscode.postMessage(m);

type Children = (Node | string | null | undefined | false)[];
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...children: Children): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (el instanceof HTMLButtonElement && !('type' in attrs)) el.type = 'button';
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k in el && typeof v !== 'string') (el as any)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(c));
  return el;
}
const icon = (name: string) => h('span', { class: `codicon codicon-${name}`, 'aria-hidden': 'true' });

let state: State | undefined;
const saved = vscode.getState() ?? {};
let filter: string = saved.filter ?? '';
let origin: 'all' | 'shared' | 'local' | 'overridden' = saved.origin ?? 'all';
let busy = false;
let announcedError: string | undefined;

const live = h('div', { id: 'live', class: 'sr-only', role: 'status', 'aria-live': 'polite' });
document.body.append(live);
function announce(msg: string) {
  live.textContent = '';
  setTimeout(() => (live.textContent = msg), 60);
}

const remember = () => vscode.setState({ filter, origin });
const command = (c: HostCommand, target?: string) => post({ type: 'command', command: c, target });

function short(v: unknown): string {
  if (v === undefined) return '';
  const s = JSON.stringify(v);
  return s.length > 72 ? s.slice(0, 69) + '…' : s;
}
const full = (v: unknown) => (v === undefined ? '' : JSON.stringify(v, null, 2));

function value(v: unknown, cls = '') {
  if (v === undefined) return h('span', { class: 'none' }, '—');
  return h('code', { class: `val ${cls}`, title: full(v) }, short(v));
}

const ORIGIN: Record<KeyInfo['origin'], { label: string; icon: string; help: string }> = {
  shared: { label: 'Shared', icon: 'organization', help: "The team's value" },
  local: { label: 'Local', icon: 'person', help: 'Only in your local file' },
  overridden: { label: 'Overridden', icon: 'arrow-swap', help: 'Your local value wins over the team’s' },
  removed: { label: 'Removed', icon: 'circle-slash', help: 'Your local file removes the team’s value (null)' },
};

// Every render rebuilds the page; focus goes back to the same control, or to what took the
// place of a control that went away (a row's other button, the next unsorted setting).
// While busy the buttons are disabled and can't hold focus, so the last real focus is kept.
let lastFocus: { id?: string; key?: string; area?: string } | undefined;
function noteFocus() {
  const a = document.activeElement as HTMLElement | null;
  if (!document.hasFocus() || !a || a === document.body || !document.getElementById('app')!.contains(a)) return;
  lastFocus = { id: a.id || undefined, key: a.closest<HTMLElement>('[data-key]')?.dataset.key, area: a.closest('#unsorted') ? 'unsorted' : a.closest('#keys') ? 'keys' : undefined };
}
function restoreFocus() {
  const a = document.activeElement;
  // While busy the buttons are disabled; focus comes back with the render that ends it.
  // Never pulls focus into the overview while the person works elsewhere in VS Code.
  if (busy || !lastFocus || !document.hasFocus() || (a && a !== document.body)) return;
  const usable = (el: Element | null | undefined): el is HTMLElement => el instanceof HTMLElement && !(el as HTMLButtonElement).disabled;
  const inArea = (sel: string) => [...document.querySelectorAll(`${sel} [data-key]`)].find((r) => (r as HTMLElement).dataset.key === lastFocus!.key);
  const candidates: (Element | null | undefined)[] = [
    lastFocus.id ? document.getElementById(lastFocus.id) : undefined,
    lastFocus.key && lastFocus.area === 'unsorted' ? inArea('#unsorted')?.querySelector('button') : undefined,
    lastFocus.key && lastFocus.area === 'keys' ? inArea('#keys')?.querySelector('button') : undefined,
    lastFocus.area === 'unsorted' ? document.querySelector('#unsorted button') : undefined,
    lastFocus.area ? document.getElementById('filter') : undefined,
  ];
  const el = candidates.find(usable);
  el?.focus();
}

function render() {
  const app = document.getElementById('app')!;
  noteFocus();
  app.replaceChildren();
  if (!state) return;
  const t = state.targets.find((x) => x.id === state!.selected) ?? state.targets[0];
  app.append(header(t));
  if (!state.trusted) app.append(banner('warn', 'shield', 'Restricted Mode: read-only.', 'Merging writes .vscode/settings.json and keeping files out of Git runs git, so nothing happens until you trust this folder.', [btn('Manage Workspace Trust', () => command('manageTrust'), 'shield', 'trust')]));
  if (!t) {
    app.append(h('div', { class: 'empty' }, h('p', {}, 'Open a folder to use local workspace settings.')));
    return;
  }
  if (!t.mode) {
    app.append(setup(t));
    restoreFocus();
    return;
  }
  for (const b of banners(t)) app.append(b);
  app.append(toolbar(t));
  app.append(table(t));
  restoreFocus();
}

function header(t: TargetView | undefined) {
  const targets = state!.targets;
  const sel =
    targets.length > 1
      ? h(
          'select',
          { id: 'target', 'aria-label': 'Folder', onchange: (e: Event) => post({ type: 'select', id: (e.target as HTMLSelectElement).value }) },
          ...targets.map((x) => h('option', { value: x.id, selected: x.id === t?.id }, `${x.name}${x.kind === 'workspace' ? ' (workspace file)' : ''}${x.mode ? '' : ' (not set up)'}`)),
        )
      : t
        ? h('span', { class: 'folder' }, t.name)
        : null;
  const mode = t?.mode ? h('span', { class: `chip mode-${t.mode}`, id: 'mode' }, icon(t.mode === 'generated' ? 'file-code' : 'eye-closed'), t.mode === 'generated' ? 'Generated settings.json' : 'settings.json committed, personal settings hidden') : null;
  return h('header', { class: 'top' }, h('h1', {}, 'Workspace Settings'), sel, mode, t?.mode ? statusChip(t) : null);
}

/** The status as shown, and as announced: an upstream change outranks "in sync". */
function statusOf(t: TargetView): { cls: string; icon: string; label: string } {
  if (t.status === 'ok' && t.git?.upstreamChanged) return { cls: 'pending', icon: 'repo-pull', label: 'Team change to pull' };
  const [ic, label] = {
    ok: ['pass', 'In sync'],
    error: ['error', 'Can’t merge'],
    pending: ['warning', `${t.unsorted.length} unsorted`],
    unhidden: ['eye', 'Unhidden for Git'],
    restricted: ['shield', 'Paused'],
    off: ['circle-outline', 'Not set up'],
  }[t.status];
  return { cls: t.status, icon: ic, label };
}

function statusChip(t: TargetView) {
  const s = statusOf(t);
  return h('span', { class: `chip status-${s.cls}`, id: 'status' }, icon(s.icon), s.label);
}

function btn(label: string, onclick: () => void, ic?: string, id?: string, opts: { primary?: boolean; disabled?: boolean; title?: string } = {}) {
  return h('button', { id, class: opts.primary ? 'primary' : undefined, onclick, disabled: opts.disabled || busy, title: opts.title }, ic ? icon(ic) : null, label);
}

function banner(kind: 'warn' | 'error' | 'info', ic: string, title: string, text: string, actions: HTMLElement[] = [], id?: string) {
  // No live role: the page is rebuilt on every refresh and would announce it again each
  // time. A new error is announced once through #live instead.
  return h('div', { class: `banner ${kind}`, id }, icon(ic), h('div', { class: 'btext' }, h('strong', {}, title), ' ', text, actions.length ? h('div', { class: 'row' }, ...actions) : null));
}

function setup(t: TargetView) {
  const trusted = state!.trusted;
  return h(
    'section',
    { class: 'setup' },
    h('h2', {}, `${t.name} isn’t set up yet`),
    h('p', {}, 'VS Code reads one settings file per folder. To give the team a committed file and you a private one, this extension writes their merge into the file VS Code reads, and moves settings changed there to the right file.'),
    h(
      'div',
      { class: 'modes' },
      t.kind === 'folder'
        ? h('div', { class: 'mode' }, h('h3', {}, icon('file-code'), ' Generated settings.json ', h('span', { class: 'muted' }, '(recommended)')), h('p', {}, 'The team commits settings.shared.json. settings.json is generated from it and your settings.local.json, and Git ignores both. git status stays clean; teammates without the extension copy settings.shared.json to settings.json.'))
        : null,
      h('div', { class: 'mode' }, h('h3', {}, icon('eye-closed'), ' Keep settings.json committed'), h('p', {}, 'The committed file stays the team’s. Your settings.local.json is applied to it and Git skips the file (skip-worktree), so personal values never show in git status. A pull that changes it needs one click to unhide first.')),
    ),
    h('div', { class: 'row' }, btn('Set Up…', () => command('initialise', t.id), 'add', 'setup', { primary: true, disabled: !trusted })),
  );
}

function banners(t: TargetView): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (t.status === 'error' && t.message) out.push(banner('error', 'error', 'Nothing was written.', t.message, [btn('Open settings.json', () => command('openSettings', t.id), 'go-to-file'), btn('Open local file', () => command('openLocal', t.id), 'go-to-file')], 'problem'));
  if (t.status === 'restricted' && t.message) out.push(banner('warn', 'shield', 'Paused.', t.message));
  if (t.unsorted.length && t.status !== 'error') {
    const list = h(
      'ul',
      { class: 'unsorted', id: 'unsorted' },
      ...t.unsorted.map((u) =>
        h(
          'li',
          { 'data-key': u.key },
          h('code', {}, u.key),
          ' ',
          value(u.value),
          h(
            'span',
            { class: 'row' },
            btn('Just me', () => post({ type: 'sort', target: t.id, key: u.key, route: 'local' }), 'person', `sort-local-${u.key}`, { title: `Save ${u.key} to ${t.files.local}` }),
            btn(t.mode === 'committed' ? 'Team (unhide to commit)' : 'Team', () => post({ type: 'sort', target: t.id, key: u.key, route: 'shared' }), 'organization', `sort-shared-${u.key}`, { title: `Save ${u.key} to ${t.files.shared}` }),
            btn('Discard', () => post({ type: 'sort', target: t.id, key: u.key, route: 'discard' }), 'discard', `sort-discard-${u.key}`, { title: 'Drop this change; it stays in the backups' }),
          ),
        ),
      ),
    );
    const b = banner('warn', 'warning', `Changed in ${t.files.settings}, not sorted yet.`, 'These settings were changed in the file VS Code reads (by the Settings editor, another extension or by hand). Say where each one goes; until then nothing is merged.');
    b.querySelector('.btext')!.append(list);
    out.push(b);
  }
  if (t.git?.upstreamChanged) out.push(banner('warn', 'repo-pull', 'The team changed settings.json upstream.', 'Git can’t pull it while your personal settings are hidden in it. Unhide, pull, and they come back on their own.', [btn('Unhide to Pull', () => command('unhideForPull', t.id), 'eye', 'unhide-pull', { primary: true })], 'upstream'));
  if (t.status === 'unhidden')
    out.push(
      banner('info', 'eye', `${t.files.settings} shows the committed settings.`, t.git?.unhidden === 'pull' ? 'Pull now; your personal settings come back once the pull is done.' : 'Commit your team change; your personal settings come back once it is committed.', [btn('Hide Personal Settings Again', () => command('hide', t.id), 'eye-closed', 'hide')], 'unhidden'),
    );
  if (t.git?.notIgnored.length) out.push(banner('info', 'info', 'Not ignored by Git yet:', `${t.git.notIgnored.join(' and ')}. Git would offer to commit your personal settings.`, [btn('Keep Out of Git…', () => command('gitIgnore', t.id), 'git-commit', 'ignore')], 'not-ignored'));
  if (t.git?.settingsTracked) out.push(banner('info', 'info', `${t.files.settings} is still committed.`, 'In this mode it is generated and holds your settings; stop tracking it and commit settings.shared.json instead.', [btn('Keep Out of Git…', () => command('gitIgnore', t.id), 'git-commit')]));
  return out;
}

function toolbar(t: TargetView) {
  const ro = !state!.trusted;
  const git = t.mode === 'committed' ? [btn('Unhide to Commit a Team Change', () => command('unhideForTeamChange', t.id), 'git-commit', 'unhide-team', { disabled: ro || t.status === 'unhidden' })] : [];
  const search = h('input', {
    id: 'filter',
    type: 'search',
    placeholder: 'Filter settings',
    'aria-label': 'Filter settings',
    value: filter,
    oninput: (e: Event) => {
      filter = (e.target as HTMLInputElement).value;
      remember();
      renderRows(t);
    },
  });
  const choices = ['all', 'shared', 'local', 'overridden'] as const;
  const choose = (o: (typeof choices)[number], focus = false) => {
    origin = o;
    remember();
    render();
    if (focus) document.getElementById(`show-${o}`)?.focus();
  };
  // A radio group: one tab stop (the checked one), arrow keys move the choice.
  const seg = h(
    'div',
    {
      class: 'seg',
      role: 'radiogroup',
      'aria-label': 'Show',
      onkeydown: (e: KeyboardEvent) => {
        const i = choices.indexOf(origin);
        const n = choices.length;
        const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1 + n, ArrowUp: i - 1 + n, Home: 0, End: n - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        choose(choices[to % n], true);
      },
    },
    ...choices.map((o) =>
      h(
        'button',
        {
          role: 'radio',
          'aria-checked': String(origin === o),
          tabindex: origin === o ? '0' : '-1',
          class: origin === o ? 'on' : undefined,
          id: `show-${o}`,
          title: o === 'local' ? 'Settings your local file sets: your own, overrides and removals' : undefined,
          onclick: () => choose(o),
        },
        { all: 'All', shared: 'Shared', local: 'Yours', overridden: 'Overridden' }[o],
      ),
    ),
  );
  return h(
    'div',
    { class: 'toolbar' },
    h(
      'div',
      { class: 'row' },
      btn('Merge Now', () => command('regenerate', t.id), 'sync', 'regenerate', { disabled: ro }),
      btn(t.mode === 'committed' ? 'Committed settings' : 'Shared file', () => command('openShared', t.id), 'organization', 'open-shared'),
      btn('Your local file', () => command('openLocal', t.id), 'person', 'open-local'),
      btn('What local changes', () => command('showDiff', t.id), 'diff', 'show-diff'),
      btn('Undo', () => command('undo', t.id), 'discard', 'undo', { disabled: ro }),
      btn('Backups…', () => command('restoreBackup', t.id), 'history', 'backups', { disabled: ro }),
      ...git,
    ),
    h('div', { class: 'row filters' }, search, seg),
  );
}

let tbody: HTMLTableSectionElement | undefined;
let countEl: HTMLElement | undefined;

function table(t: TargetView) {
  tbody = h('tbody', {});
  countEl = h('p', { class: 'muted small', id: 'count' });
  const wrap = h(
    'div',
    { class: 'tablewrap' },
    h(
      'table',
      { id: 'keys' },
      h('caption', { class: 'sr-only' }, `Settings of ${t.name}`),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Setting'), h('th', { scope: 'col' }, 'From'), h('th', { scope: 'col' }, 'Team', h('span', { class: 'file' }, t.files.shared)), h('th', { scope: 'col' }, 'Yours', h('span', { class: 'file' }, t.files.local)), h('th', { scope: 'col' }, 'Effective'), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions')))),
      tbody,
    ),
  );
  renderRows(t);
  return h('section', {}, wrap, countEl);
}

function renderRows(t: TargetView) {
  if (!tbody) return;
  const ro = !state!.trusted;
  const f = filter.trim().toLowerCase();
  const rows = t.keys.filter((k) => (origin === 'all' || (origin === 'local' ? k.origin !== 'shared' : origin === 'overridden' ? k.origin === 'overridden' || k.origin === 'removed' : k.origin === origin)) && (!f || k.key.toLowerCase().includes(f) || short(k.effective).toLowerCase().includes(f)));
  tbody.replaceChildren(
    ...rows.map((k) => {
      const o = ORIGIN[k.origin];
      const acts: HTMLElement[] = [];
      // The accessible name starts with the visible word, so "click Reset" works by voice.
      const act = (op: 'toLocal' | 'toShared' | 'removeOverride', text: string, help: string, ic: string) =>
        h('button', { id: `act-${op}-${k.key}`, 'data-op': op, 'data-key': k.key, title: help, 'aria-label': `${text} ${k.key}: ${help}`, disabled: ro || busy, onclick: () => post({ type: 'move', target: t.id, op, key: k.key }) }, icon(ic), text);
      if (k.origin === 'shared') acts.push(act('toLocal', 'Local', `move it to your local file, only you get it${t.mode === 'committed' ? ' (a team change)' : ''}`, 'arrow-down'));
      if (k.origin === 'local' || k.origin === 'overridden') acts.push(act('toShared', 'Shared', `move it to the shared settings, the whole team gets your value${t.mode === 'committed' ? ' (a team change)' : ''}`, 'arrow-up'));
      if (k.origin === 'overridden' || k.origin === 'removed') acts.push(act('removeOverride', 'Reset', 'remove your override and use the team’s value again', 'discard'));
      return h(
        'tr',
        { 'data-key': k.key, 'data-origin': k.origin },
        h('th', { scope: 'row' }, h('code', { class: 'key' }, k.key)),
        h('td', {}, h('span', { class: `origin o-${k.origin}`, title: o.help }, icon(o.icon), o.label)),
        h('td', { class: k.origin === 'overridden' || k.origin === 'removed' ? 'struck' : undefined }, value(k.shared)),
        h('td', {}, k.local === null ? h('code', { class: 'val', title: 'null removes the shared value' }, 'null') : value(k.local)),
        h('td', {}, value(k.effective, 'eff')),
        h('td', { class: 'acts' }, ...acts),
      );
    }),
  );
  if (!rows.length) tbody.append(h('tr', {}, h('td', { colspan: 6, class: 'muted' }, t.keys.length ? 'No settings match.' : t.status === 'restricted' && t.mode === 'committed' ? 'Settings can’t be read in Restricted Mode.' : 'No settings yet. Add some to the shared or local file.')));
  const local = t.keys.filter((k) => k.origin !== 'shared').length;
  if (countEl) countEl.textContent = `${t.keys.length} settings · ${local} from your local file${rows.length !== t.keys.length ? ` · ${rows.length} shown` : ''}`;
}

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  const m = e.data;
  if (m.type === 'state') {
    const before = state?.targets.find((x) => x.id === state!.selected);
    state = m.state;
    const after = state.targets.find((x) => x.id === state!.selected);
    if (after && after.status === 'error' && after.message && after.message !== announcedError) announce(`Can’t merge: ${after.message}`);
    else if (before && after && statusOf(before).label !== statusOf(after).label) announce(`Status: ${statusOf(after).label}`);
    announcedError = after?.status === 'error' ? after.message : undefined;
    render();
  } else if (m.type === 'busy') {
    busy = m.busy;
    render();
  }
});

post({ type: 'ready' });
