// Keeps every folder (and the workspace file) in sync: watches the files, runs the engine
// one change at a time per folder, asks where changed settings go, and remembers answers.
// Nothing is written and git never runs in Restricted Mode.
import { existsSync, promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as core from './core/index';
import type { Change, Context, LayerEdit, Route, SyncResult, Target, TargetState } from './core/index';
import type { TargetView } from './protocol';

export const WCP = 'swellaby.workspace-config-plus';
const OFF = (id: string) => `localWorkspaceSettings.off:${id}`;
const STATE = (id: string) => `localWorkspaceSettings.state:${id}`;
const REMEMBERED = 'localWorkspaceSettings.remembered';
const QUIET = 'localWorkspaceSettings.quietMoves';
const DEBOUNCE_MS = 250;
// File watchers miss changes on some remote and WSL file systems, and stop working when
// the system runs out of them; a cheap poll of a few file sizes and times backs them up.
const POLL_MS = 2000;

export interface Entry {
  t: Target;
  st?: TargetState;
  last?: SyncResult;
  upstream?: boolean;
  /** Answers for settings waiting to be sorted, used by the next run. */
  decisions: Map<string, Exclude<Route, 'defer'>>;
  /** A question about these settings is on screen, or was dismissed: don't ask again until asked to. */
  asked: Set<string>;
  chain: Promise<unknown>;
  timer?: ReturnType<typeof setTimeout>;
  lastError?: string;
  watchers: vscode.Disposable[];
  gitWatch?: vscode.Disposable;
  gitDir?: string;
  /** Size and time of each watched file at the last poll. */
  seen?: string;
  seenGit?: string;
}

export const cfg = () => vscode.workspace.getConfiguration('localWorkspaceSettings');

export class Manager implements vscode.Disposable {
  readonly entries = new Map<string, Entry>();
  readonly backups: core.Backups;
  readonly log: vscode.LogOutputChannel;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subs: vscode.Disposable[] = [];
  private disposed = false;
  private readonly poll: ReturnType<typeof setInterval>;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.backups = new core.Backups(path.join(ctx.globalStorageUri.fsPath, 'backups'), () => cfg().get<number>('backups', 20));
    this.log = vscode.window.createOutputChannel('Local Workspace Settings', { log: true });
    this.subs.push(
      this.log,
      this.changed,
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.discover()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        this.discover();
        // Folders found in Restricted Mode were never merged and have no Git watch yet.
        for (const e of this.active()) {
          this.schedule(e, 0);
          void this.watchGit(e);
        }
        this.changed.fire();
      }),
      // A setting written through VS Code's API lands in settings.json; the file watcher
      // usually sees it, but not always on remote file systems.
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('git.path')) this.useGitPath();
        if (e.affectsConfiguration('localWorkspaceSettings')) this.changed.fire();
        this.scheduleAll();
      }),
      vscode.workspace.onDidSaveTextDocument((d) => {
        for (const e of this.entries.values()) if ([e.t.settingsFile, e.t.localFile, e.t.sharedFile].includes(d.uri.fsPath)) this.schedule(e);
      }),
      vscode.window.onDidChangeWindowState((w) => {
        if (w.focused) this.scheduleAll(true);
      }),
    );
    this.poll = setInterval(() => void this.pollAll(), POLL_MS);
    this.useGitPath();
  }

  /** VS Code's git.path (a path or a list to try), so a Git that isn't on PATH is found too. */
  private useGitPath() {
    const v = vscode.workspace.getConfiguration('git').get<string | string[] | null>('path');
    const list = (Array.isArray(v) ? v : v ? [v] : []).filter((x): x is string => typeof x === 'string' && x.trim() !== '');
    core.git.setGitBinary(list.find((x) => existsSync(x)));
  }

  private async pollAll() {
    if (!this.trusted || this.disposed) return;
    for (const e of this.active()) {
      const sig = await signature(e);
      if (e.seen !== undefined && sig !== e.seen) this.schedule(e);
      e.seen = sig;
      if (e.gitDir) {
        const [index, head, fetch] = await Promise.all(['index', 'HEAD', 'FETCH_HEAD'].map((f) => stamp(path.join(e.gitDir!, f))));
        const g = `${index}|${head}`;
        if (e.seenGit !== undefined && g !== e.seenGit.split('#')[0]) this.schedule(e);
        if (e.seenGit !== undefined && fetch !== e.seenGit.split('#')[1]) void this.checkUpstream(e, true);
        e.seenGit = `${g}#${fetch}`;
      }
    }
  }

  get trusted() {
    return vscode.workspace.isTrusted;
  }

  /** For one folder: arrayMerge is resource-scoped, so a folder's own rule counts in a multi-root workspace. */
  context(e?: Entry): Context {
    const scoped = e?.t.kind === 'folder' ? vscode.workspace.getConfiguration('localWorkspaceSettings', vscode.Uri.file(e.t.root)) : cfg();
    return { backups: this.backups, rules: scoped.get<core.ArrayRules>('arrayMerge') ?? undefined, header: cfg().get<boolean>('header', true) };
  }

  // ---- Targets -----------------------------------------------------------------------

  /** Every folder on disk and the saved workspace file, set up or not. */
  discover() {
    const want = new Map<string, Target>();
    for (const f of vscode.workspace.workspaceFolders ?? []) if (f.uri.scheme === 'file') want.set(core.folderTarget(f.uri.fsPath, f.name).id, core.folderTarget(f.uri.fsPath, f.name));
    const wf = vscode.workspace.workspaceFile;
    if (wf?.scheme === 'file' && wf.fsPath.endsWith('.code-workspace')) {
      const t = core.workspaceTarget(wf.fsPath);
      want.set(t.id, t);
    }
    for (const [id, e] of this.entries) if (!want.has(id)) this.drop(e);
    for (const [id, t] of want) {
      if (this.entries.has(id)) continue;
      const e: Entry = { t, st: this.ctx.workspaceState.get<TargetState>(STATE(id)), decisions: new Map(), asked: new Set(), chain: Promise.resolve(), watchers: [] };
      this.entries.set(id, e);
      this.watch(e);
      void this.adopt(e);
    }
    void this.updateContext();
    this.changed.fire();
  }

  /** A folder whose team already uses settings.shared.json is merged without setup. */
  private async adopt(e: Entry) {
    if (!e.st && e.t.kind === 'folder' && !this.ctx.workspaceState.get<boolean>(OFF(e.t.id)) && (await exists(e.t.sharedFile))) {
      // A settings.shared.json the repository commits as a link could point at any file
      // of the user's; it is never read, let alone merged without asking.
      if (await isLink(e.t.sharedFile)) return void this.log.warn(`${e.t.name}: .vscode/settings.shared.json is a symbolic link; not merging it.`);
      // Workspace Config+ uses the same two file names with other merge rules (lists
      // concatenated); running both, each rewrites the other's settings.json.
      if (vscode.extensions.getExtension(WCP)) return void this.warnWcp(e);
      e.st = { mode: 'generated' };
    }
    if (e.st) {
      this.schedule(e, 0);
      await this.watchGit(e);
    }
    void this.updateContext();
  }

  private warnedWcp = false;
  private warnWcp(e: Entry) {
    if (this.warnedWcp) return;
    this.warnedWcp = true;
    this.log.warn(`${e.t.name}: Workspace Config+ is installed; not merging settings.shared.json automatically.`);
    void vscode.window.showWarningMessage(`${e.t.name} has .vscode/settings.shared.json, and Workspace Config+ is installed, which manages the same file with different rules (it joins lists). Local Workspace Settings leaves this folder alone. Disable one of the two for this workspace; once Workspace Config+ is off, this folder is merged after the window reloads.`);
  }

  private watch(e: Entry) {
    const dir = path.dirname(e.t.settingsFile);
    const pattern = e.t.kind === 'folder' ? '{settings,settings.shared,settings.local}.json' : `${path.basename(e.t.settingsFile)}{,.local.json}`;
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), pattern));
    const on = () => {
      if (!e.st && e.t.kind === 'folder') void this.adopt(e);
      else this.schedule(e);
    };
    e.watchers.push(w, w.onDidChange(on), w.onDidCreate(on), w.onDidDelete(on));
  }

  /** committed mode: the index changes on commit, pull and checkout; FETCH_HEAD on fetch. */
  private async watchGit(e: Entry) {
    if (e.st?.mode !== 'committed' || e.gitWatch || !this.trusted) return;
    const repo = await core.git.locate(e.t.settingsFile).catch(() => undefined);
    const dir = repo && (await core.git.gitDir(repo.root));
    if (!dir) return;
    e.gitDir = dir;
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), '{index,HEAD,FETCH_HEAD}'));
    const on = (u: vscode.Uri) => {
      if (u.fsPath.endsWith('FETCH_HEAD')) void this.checkUpstream(e, true);
      else this.schedule(e);
    };
    e.gitWatch = vscode.Disposable.from(w, w.onDidChange(on), w.onDidCreate(on));
  }

  private drop(e: Entry) {
    clearTimeout(e.timer);
    for (const d of e.watchers) d.dispose();
    e.gitWatch?.dispose();
    this.entries.delete(e.t.id);
  }

  active(): Entry[] {
    return [...this.entries.values()].filter((e) => e.st);
  }

  async saveState(e: Entry, st: TargetState | undefined) {
    e.st = st;
    await this.ctx.workspaceState.update(STATE(e.t.id), st);
    if (st) await this.ctx.workspaceState.update(OFF(e.t.id), undefined);
    else {
      e.decisions.clear();
      e.asked.clear();
      e.last = undefined;
      e.upstream = false;
      e.gitWatch?.dispose();
      e.gitWatch = undefined;
      e.gitDir = undefined;
    }
  }

  /** Local settings turned off for a folder on purpose: its settings.shared.json is no longer merged on its own. */
  async turnOff(e: Entry) {
    await this.saveState(e, undefined);
    await this.ctx.workspaceState.update(OFF(e.t.id), true);
    void this.updateContext();
    this.changed.fire();
  }

  async updateContext() {
    await vscode.commands.executeCommand('setContext', 'localWorkspaceSettings.active', this.active().length > 0);
    await vscode.commands.executeCommand('setContext', 'localWorkspaceSettings.committed', this.active().some((e) => e.st?.mode === 'committed'));
  }

  // ---- Running -----------------------------------------------------------------------

  schedule(e: Entry, delay = DEBOUNCE_MS) {
    if (!this.trusted || !e.st || this.disposed) return;
    clearTimeout(e.timer);
    e.timer = setTimeout(() => void this.enqueue(e, () => this.run(e)), delay);
  }

  /** On focus, a cheap check: only folders whose files changed get a run. */
  scheduleAll(quietly = false) {
    for (const e of this.active()) {
      if (quietly) void this.changedOnDisk(e).then((c) => c && this.schedule(e));
      else this.schedule(e);
    }
  }

  private async changedOnDisk(e: Entry): Promise<boolean> {
    const s = await core.readState(e.t.settingsFile).catch(() => undefined);
    return !!s && s.hash !== e.st?.written;
  }

  /** Runs `fn` after everything already queued for this folder. */
  enqueue<T>(e: Entry, fn: () => Promise<T>): Promise<T> {
    const next = e.chain.then(fn, fn);
    e.chain = next.catch(() => undefined);
    return next;
  }

  /** One merge (plus moves from the overview), then the bookkeeping. */
  async run(e: Entry, edit?: LayerEdit[], extra: { hide?: boolean; reason?: string } = {}): Promise<SyncResult | undefined> {
    if (!this.trusted || !e.st) return undefined;
    let r: SyncResult;
    try {
      r = await core.sync(e.t, e.st, this.context(e), { router: this.router(e), edit, ...extra });
    } catch (err) {
      r = { status: 'error', state: e.st, wrote: [], routed: [], message: (err as Error).message };
    }
    e.last = r;
    // What the files look like after this run: the poll compares against it.
    e.seen = await signature(e);
    if (r.status !== 'error') {
      await this.saveState(e, r.state);
      e.lastError = undefined;
    }
    if (r.wrote.length) this.log.info(`${e.t.name}: wrote ${r.wrote.map((f) => core.short(e.t, f)).join(', ')}${r.routed.length ? ` (${r.routed.map((x) => `${x.key} → ${x.to}`).join(', ')})` : ''}`);
    if (r.status === 'error' && r.message !== e.lastError) {
      e.lastError = r.message;
      this.log.warn(`${e.t.name}: ${r.message}`);
      void this.reportError(e, r);
    }
    if (r.status === 'ok') {
      for (const x of r.routed) {
        e.decisions.delete(x.key);
        e.asked.delete(x.key);
      }
      this.announce(e, r);
      if (r.rehid) void vscode.window.showInformationMessage(`${e.t.name}: your personal settings are applied to ${core.short(e.t, e.t.settingsFile)} again, and hidden from Git.`);
    }
    if (r.notice) void vscode.window.showWarningMessage(`${e.t.name}: ${r.notice}`);
    if (e.st?.mode === 'committed') {
      await this.watchGit(e);
      void this.checkUpstream(e, false);
    }
    void this.updateContext();
    this.changed.fire();
    return r;
  }

  private async reportError(e: Entry, r: SyncResult) {
    const open = r.file ? 'Open File' : undefined;
    const a = await vscode.window.showWarningMessage(`Local Workspace Settings: ${r.message}`, ...(open ? [open] : []));
    if (a === open && r.file) {
      const f = [e.t.settingsFile, e.t.localFile, e.t.sharedFile].find((x) => x && core.short(e.t, x) === r.file);
      if (f) await vscode.window.showTextDocument(vscode.Uri.file(f));
    }
  }

  async checkUpstream(e: Entry, _fromFetch: boolean) {
    if (!this.trusted || e.st?.mode !== 'committed' || e.st.unhidden) {
      e.upstream = false;
      return;
    }
    const was = e.upstream;
    e.upstream = await core.upstreamChanged(e.t).catch(() => false);
    if (e.upstream !== was) this.changed.fire();
    // Once per upstream change: with autofetch on, every fetch would ask again otherwise.
    // The status bar and the overview keep showing it.
    if (e.upstream && !was) {
      const a = await vscode.window.showWarningMessage(
        `${e.t.name}: the team changed ${core.short(e.t, e.t.settingsFile)} upstream. Git can't pull it while your personal settings are hidden in it. Unhide it, pull, and they come back on their own.`,
        'Unhide to Pull',
      );
      if (a) await vscode.commands.executeCommand('localWorkspaceSettings.unhideForPull', e.t.id);
    }
  }

  // ---- Routing -----------------------------------------------------------------------

  private remembered(): Record<string, Route> {
    return this.ctx.workspaceState.get<Record<string, Route>>(REMEMBERED) ?? {};
  }

  async remember(pattern: string, route: Route) {
    await this.ctx.workspaceState.update(REMEMBERED, { ...this.remembered(), [pattern]: route });
  }

  /** Where a changed setting goes without asking, if anywhere. */
  ruleFor(mode: core.Mode | undefined, key: string): { route: Route | 'ask'; source: 'remembered' | 'routes' | 'default' } {
    // In committed mode "shared" means a commit: never without asking.
    const fix = (r: string): Route | 'ask' => (r === 'shared' && mode === 'committed' ? 'ask' : r === 'local' || r === 'shared' ? r : 'ask');
    const rem = core.lookup(this.remembered(), key);
    if (rem) return { route: fix(rem.value), source: 'remembered' };
    const rule = core.lookup(cfg().get<Record<string, string>>('routes') ?? {}, key);
    if (rule) return { route: fix(rule.value), source: 'routes' };
    return { route: fix(cfg().get<string>('defaultRoute', 'local')), source: 'default' };
  }

  private router(e: Entry): core.Router {
    return async (changes) => {
      const routes: Route[] = [];
      const ask: Change[] = [];
      for (const c of changes) {
        const d = e.decisions.get(c.key);
        if (d) routes.push(d);
        else if (c.unknown || c.conflict) {
          ask.push(c);
          routes.push('defer');
        } else {
          const r = this.ruleFor(e.st?.mode, c.key).route;
          if (r === 'ask') {
            ask.push(c);
            routes.push('defer');
          } else routes.push(r);
        }
      }
      if (ask.length) void this.ask(e, ask);
      return routes;
    };
  }

  /** Asks where settings go, without blocking: the answer feeds the next run. */
  private async ask(e: Entry, changes: Change[]) {
    const fresh = changes.filter((c) => !e.asked.has(c.key));
    if (!fresh.length) return;
    for (const c of fresh) e.asked.add(c.key);
    const settings = core.short(e.t, e.t.settingsFile);
    const local = core.short(e.t, e.t.localFile);
    const committed = e.st?.mode === 'committed';
    const names = (cs: Change[]) => cs.map((c) => c.key).slice(0, 4).join(', ') + (cs.length > 4 ? ` and ${cs.length - 4} more` : '');
    const conflicts = fresh.filter((c) => c.conflict);
    const decide = (cs: Change[], r: Exclude<Route, 'defer'>) => {
      for (const c of cs) {
        e.decisions.set(c.key, r);
        e.asked.delete(c.key);
      }
      this.schedule(e, 0);
    };
    if (conflicts.length) {
      const c = conflicts[0];
      const where = c.conflict!.layer === 'local' ? local : committed ? 'the commit' : core.short(e.t, e.t.sharedFile);
      // Compared whole: "Keep p.code-workspace's" is the start of "Keep p.code-workspace.local.json's".
      const keepSettings = `Keep ${path.basename(settings)}'s`;
      const keepOther = `Keep ${path.basename(where)}'s`;
      const a = await vscode.window.showWarningMessage(
        `${e.t.name}: ${c.key} was changed in ${settings} (to ${brief(c.value)}) and in ${where} (to ${brief(c.conflict!.value)}). Which one should stay? The other is kept in the backups.`,
        keepSettings,
        keepOther,
      );
      if (a === keepSettings) decide([c], 'local');
      else if (a === keepOther) decide([c], 'discard');
      this.changed.fire();
      if (fresh.length > 1) void this.ask(e, fresh.filter((x) => x !== c).map((x) => (e.asked.delete(x.key), x)));
      return;
    }
    const unknown = fresh.filter((c) => c.unknown);
    const cs = unknown.length ? unknown : fresh;
    const msg = unknown.length
      ? `${e.t.name}: ${settings} has ${cs.length === 1 ? 'a setting' : `${cs.length} settings`} that ${cs.length === 1 ? "isn't" : "aren't"} in ${committed ? 'the commit' : core.short(e.t, e.t.sharedFile)} or ${local}: ${names(cs)}. Keep ${cs.length === 1 ? 'it' : 'them'} for yourself?`
      : `${e.t.name}: ${names(cs)} changed in ${settings}. Keep ${cs.length === 1 ? 'it' : 'them'} for yourself, or share with the team?`;
    const pattern = cs.length === 1 ? patternFor(cs[0].key) : undefined;
    const buttons = ['Just Me', committed ? 'Share (Unhide to Commit)' : 'Share with Team', unknown.length ? 'Discard' : pattern ? `Always Just Me for ${pattern}` : undefined].filter((b): b is string => !!b);
    this.changed.fire();
    const a = await vscode.window.showInformationMessage(msg, ...buttons);
    if (a === 'Just Me') decide(cs, 'local');
    else if (a?.startsWith('Share')) decide(cs, 'shared');
    else if (a === 'Discard') decide(cs, 'discard');
    else if (a && pattern) {
      await this.remember(pattern, 'local');
      decide(cs, 'local');
    }
    // Dismissed: the settings stay unsorted (status bar and overview say so) until sorted there.
  }

  /** After moving settings to the local file on the default route, say so once, with a way back. */
  private announce(e: Entry, r: SyncResult) {
    const changes = r.routed.filter((x) => x.to === 'local' && this.ruleFor(e.st?.mode, x.key).source === 'default');
    const moved = changes.map((x) => x.key);
    if (!moved.length || this.ctx.globalState.get<boolean>(QUIET)) return;
    const local = core.short(e.t, e.t.localFile);
    const share = e.st?.mode === 'committed' ? 'Share (Unhide to Commit)' : 'Move to Shared';
    void vscode.window.showInformationMessage(`${moved.join(', ')} ${moved.length === 1 ? 'was' : 'were'} saved to ${local}, so only you have ${moved.length === 1 ? 'it' : 'them'}.`, share, "Don't Show Again").then(async (a) => {
      // Only the change itself is shared: the rest of a personal value (an entry of
      // files.exclude, a word of a list) stays in the local file.
      if (a === share) await this.move(e, changes.map((x) => ({ op: 'shareChange' as const, key: x.key, before: x.previous, after: x.value })));
      else if (a) await this.ctx.globalState.update(QUIET, true);
    });
  }

  /** Answers for unsorted settings from the overview. */
  async sort(e: Entry, key: string, route: Exclude<Route, 'defer'>) {
    e.decisions.set(key, route);
    e.asked.delete(key);
    return this.enqueue(e, () => this.run(e));
  }

  /** Moves from the overview or the commands. Committed mode asks before unhiding the file. */
  async move(e: Entry, edit: LayerEdit[]): Promise<SyncResult | undefined> {
    if (!this.guard()) return undefined;
    if (e.st?.mode === 'committed' && edit.some((x) => x.op !== 'removeOverride')) {
      const a = await vscode.window.showInformationMessage(
        `Changing what the team gets means changing the committed ${core.short(e.t, e.t.settingsFile)}. It will show the committed settings with this change, ready for you to commit; your personal settings come back once it is committed.`,
        { modal: true },
        'Unhide and Change',
      );
      if (!a) return undefined;
    }
    const reason = edit.map((x) => `${x.op === 'toLocal' ? 'Moved' : x.op === 'toShared' || x.op === 'shareChange' ? 'Shared' : 'Removed the override of'} ${x.key}`).join(', ');
    const r = await this.enqueue(e, () => this.run(e, edit, { reason }));
    // Moves wait while a changed setting is unsorted: the merge would overwrite it.
    if (r?.status === 'pending') void vscode.window.showWarningMessage(`${e.t.name}: sort the changed settings first, then move. ${r.message ?? ''}`.trim());
    return r;
  }

  /** In Restricted Mode, explains why nothing happens. */
  guard(): boolean {
    if (this.trusted) return true;
    void vscode.window.showWarningMessage('Local Workspace Settings does nothing in Restricted Mode: merging writes .vscode/settings.json and runs git, and this folder is not trusted yet. Trust it to use local settings here.', 'Manage Workspace Trust').then((a) => {
      if (a) void vscode.commands.executeCommand('workbench.trust.manage');
    });
    return false;
  }

  // ---- For the overview and the status bar --------------------------------------------

  async view(e: Entry): Promise<TargetView> {
    const t = e.t;
    const files = { settings: core.short(t, t.settingsFile), shared: t.kind === 'folder' && e.st?.mode !== 'committed' ? core.short(t, t.sharedFile) : `committed ${core.short(t, t.settingsFile)}`, local: core.short(t, t.localFile) };
    const base: TargetView = { id: t.id, name: t.name, kind: t.kind, mode: e.st?.mode, status: 'off', keys: [], unsorted: [], files, hasLocalFile: false };
    if (!e.st) return base;
    if (!this.trusted) {
      if (e.st.mode === 'committed') return { ...base, status: 'restricted', message: 'Restricted Mode: the committed settings are read with git, which does not run in an untrusted folder.' };
      const i = await core.inspect(t, e.st, this.context(e), { git: false });
      return { ...base, status: 'restricted', keys: i.keys, hasLocalFile: i.hasLocalFile, message: i.problem?.message };
    }
    const i = await core.inspect(t, e.st, this.context(e));
    const current = await core.readState(t.settingsFile).catch(() => undefined);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = current?.exists ? core.parseBlock(current.text, t.block) : {};
    } catch {
      /* reported as a problem */
    }
    const status: TargetView['status'] = i.problem || e.last?.status === 'error' ? 'error' : e.st.unhidden ? 'unhidden' : i.unsorted.length ? 'pending' : 'ok';
    const notIgnored: string[] = [];
    if (i.ignored && !i.ignored.local && !(i.tracked?.local ?? false)) notIgnored.push(files.local);
    if (e.st.mode === 'generated' && i.ignored && !i.ignored.settings) notIgnored.push(files.settings);
    return {
      ...base,
      status,
      message: i.problem?.message ?? (e.last?.status === 'error' ? e.last.message : e.st.unhidden ? e.last?.message ?? `${files.settings} shows the committed settings so Git can ${e.st.unhidden.reason === 'pull' ? 'pull' : 'commit'} it.` : undefined),
      keys: i.keys,
      unsorted: i.unsorted.map((key) => ({ key, value: parsed[key] })),
      hasLocalFile: i.hasLocalFile,
      git: i.tracked ? { hidden: i.hidden, unhidden: e.st.unhidden?.reason, upstreamChanged: e.upstream, notIgnored, settingsTracked: e.st.mode === 'generated' ? i.tracked.settings : undefined } : undefined,
    };
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.poll);
    for (const e of [...this.entries.values()]) this.drop(e);
    for (const s of this.subs) s.dispose();
  }
}

export function patternFor(key: string): string {
  const i = key.indexOf('.');
  return i > 0 && !key.startsWith('[') ? `${key.slice(0, i)}.*` : key;
}

export function brief(v: unknown): string {
  if (v === undefined) return 'removed';
  const s = JSON.stringify(v);
  return s.length > 40 ? s.slice(0, 37) + '…' : s;
}

const signature = async (e: Entry) => (await Promise.all([e.t.settingsFile, e.t.localFile, e.t.sharedFile].filter(Boolean).map(stamp))).join('|');

async function stamp(f: string): Promise<string> {
  try {
    const s = await fs.stat(f);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return '-';
  }
}

async function isLink(f: string) {
  return fs.lstat(f).then(
    (s) => s.isSymbolicLink(),
    () => false,
  );
}

async function exists(f: string) {
  return fs.stat(f).then(
    () => true,
    () => false,
  );
}
