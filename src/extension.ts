// Commands, setup and the Git helpers. The sync itself lives in manager.ts and the engine
// in core/.
import * as path from 'path';
import * as vscode from 'vscode';
import * as core from './core/index';
import type { Mode } from './core/index';
import { Manager, WCP, type Entry } from './manager';
import { OverviewPanel, VIEW_TYPE } from './panel';
import { Previews } from './preview';
import { StatusBar } from './statusBar';

let mgr: Manager;
let previews: Previews;

export function activate(ctx: vscode.ExtensionContext) {
  mgr = new Manager(ctx);
  previews = new Previews();
  const bar = new StatusBar(mgr);
  let pending: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      void bar.update();
      OverviewPanel.current?.refresh();
    }, 100);
  };
  ctx.subscriptions.push(mgr, previews, bar, mgr.onDidChange(refresh), { dispose: () => clearTimeout(pending) });

  const cmd = (id: string, fn: (...a: any[]) => unknown) =>
    ctx.subscriptions.push(
      vscode.commands.registerCommand(id, async (...a: unknown[]) => {
        try {
          return await fn(...a);
        } catch (e) {
          void vscode.window.showErrorMessage(`Local Workspace Settings: ${e instanceof Error ? e.message : String(e)}`);
        }
      }),
    );

  cmd('localWorkspaceSettings.initialise', (id?: string) => initialise(id));
  // From the editor title the argument is the open file: show the folder it belongs to.
  cmd('localWorkspaceSettings.openView', (id?: string | vscode.Uri) => OverviewPanel.show(ctx, mgr, actions, typeof id === 'string' ? id : id instanceof vscode.Uri ? entryForFile(id)?.t.id : undefined));
  cmd('localWorkspaceSettings.regenerate', () => regenerate());
  cmd('localWorkspaceSettings.openShared', (id?: string) => openShared(id));
  cmd('localWorkspaceSettings.openLocal', (id?: string) => openLocal(id));
  cmd('localWorkspaceSettings.showDiff', (id?: string) => showDiff(id));
  cmd('localWorkspaceSettings.undo', (id?: string) => undo(id));
  cmd('localWorkspaceSettings.restoreBackup', (id?: string) => restoreBackup(id));
  cmd('localWorkspaceSettings.moveToLocal', (id?: string, key?: string) => moveCmd('toLocal', id, key));
  cmd('localWorkspaceSettings.moveToShared', (id?: string, key?: string) => moveCmd('toShared', id, key));
  cmd('localWorkspaceSettings.removeOverride', (id?: string, key?: string) => moveCmd('removeOverride', id, key));
  cmd('localWorkspaceSettings.gitIgnore', (id?: string) => withEntry(id, 'Keep local settings out of Git in which folder?', (e) => gitIgnore(e, true)));
  cmd('localWorkspaceSettings.unhideForPull', (id?: string) => unhideCmd('pull', id));
  cmd('localWorkspaceSettings.unhideForTeamChange', (id?: string) => unhideCmd('team', id));
  cmd('localWorkspaceSettings.hide', (id?: string) => hideCmd(id));
  cmd('localWorkspaceSettings.stop', (id?: string) => stop(id));

  ctx.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel) {
        new OverviewPanel(panel, ctx, mgr, actions);
      },
    }),
  );

  mgr.discover();
  void bar.update();
}

export function deactivate() {}

const actions = {
  openSettings: (id?: string) => withEntry(id, 'Open which settings.json?', (e) => vscode.window.showTextDocument(vscode.Uri.file(e.t.settingsFile))),
};

// ---- Picking a folder ----------------------------------------------------------------

type EntryPick = vscode.QuickPickItem & { e: Entry };

async function pickEntry(id: string | undefined, title: string, filter: (e: Entry) => boolean = (e) => !!e.st): Promise<Entry | undefined> {
  if (typeof id === 'string') return mgr.entries.get(id);
  const list = [...mgr.entries.values()].filter(filter);
  if (!list.length) {
    const a = await vscode.window.showInformationMessage('Local settings are not set up in this workspace yet.', 'Set Up…');
    if (a) await vscode.commands.executeCommand('localWorkspaceSettings.initialise');
    return undefined;
  }
  if (list.length === 1) return list[0];
  const pick = await vscode.window.showQuickPick<EntryPick>(
    list.map((e) => ({ label: e.t.name, description: e.st ? modeLabel(e.st.mode) : 'not set up', detail: e.t.settingsFile, e })),
    { title },
  );
  return pick?.e;
}

async function withEntry(id: string | undefined, title: string, fn: (e: Entry) => unknown, filter?: (e: Entry) => boolean) {
  const e = await pickEntry(id, title, filter);
  if (e) await fn(e);
}

/** The folder (or workspace file) whose settings, shared or local file this is. */
function entryForFile(uri: vscode.Uri): Entry | undefined {
  const f = uri.fsPath;
  return [...mgr.entries.values()].find((e) => [e.t.settingsFile, e.t.localFile, e.t.sharedFile].includes(f)) ?? [...mgr.entries.values()].find((e) => e.t.kind === 'folder' && path.dirname(f) === path.dirname(e.t.settingsFile));
}

const modeLabel = (m: Mode) => (m === 'generated' ? 'generated settings.json' : 'settings.json committed, personal settings hidden');

// ---- Setup ---------------------------------------------------------------------------

type ModePick = vscode.QuickPickItem & { mode?: Mode };
type KeyPick = vscode.QuickPickItem & { key: string };

/** Settings that are usually one person's: paths, colours, zoom, interpreters. */
export function looksPersonal(key: string, value: unknown): boolean {
  const rule = mgr.ruleFor('generated', key);
  if (rule.route === 'local' && rule.source !== 'default') return true;
  if (/^peacock\.|colorCustomizations$|^window\.zoomLevel$|interpreterpath$|defaultinterpreter|\.java\.home$|\.jdt\.ls\.java\.home$|\.(sdk|jdk)path$|^terminal\.integrated\.(env|cwd)/i.test(key)) return true;
  return typeof value === 'string' && /^(\/home\/|\/Users\/|[A-Za-z]:\\Users\\|~\/)/.test(value);
}

async function initialise(id?: string) {
  if (!mgr.guard()) return;
  if (typeof id !== 'string') {
    const all = [...mgr.entries.values()];
    if (!all.length) return void vscode.window.showInformationMessage('Open a folder first: local settings are set up per folder.');
    if (all.every((x) => x.st)) {
      const a = await vscode.window.showInformationMessage(all.length === 1 ? `${all[0].t.name} is already set up (${modeLabel(all[0].st!.mode)}).` : 'Every folder in this workspace is already set up.', 'Show Overview');
      if (a) await vscode.commands.executeCommand('localWorkspaceSettings.openView');
      return;
    }
  }
  const e = await pickEntry(id, 'Set up local settings for which folder?', (x) => !x.st);
  if (!e) return;
  if (e.st) {
    void vscode.window.showInformationMessage(`${e.t.name} is already set up (${modeLabel(e.st.mode)}).`);
    return;
  }
  const t = e.t;
  let repo: core.git.RepoFile | undefined;
  let noGit: string | undefined;
  try {
    repo = await core.git.locate(t.settingsFile);
  } catch (err) {
    if (!(err instanceof core.git.GitUnavailable)) throw err;
    noGit = err.message;
  }
  const tracked = !!repo && (await core.git.isTracked(repo));
  // Workspace Config+ manages settings.shared.json and settings.local.json too, with other
  // rules (lists joined): both would keep rewriting settings.json.
  const wcp = t.kind === 'folder' && !!vscode.extensions.getExtension(WCP);
  const wcpText = `Workspace Config+ is installed, and it manages the same .vscode/settings.shared.json and settings.local.json with other rules (it joins lists), so both extensions would keep rewriting settings.json. Disable Workspace Config+ for this workspace and reload the window to use a generated settings.json here${(await core.readState(t.sharedFile)).exists ? ': this folder’s settings.shared.json is then merged on its own' : ''}.`;
  const items: ModePick[] = [];
  if (t.kind === 'folder')
    items.push({
      label: '$(file-code) Generated settings.json',
      description: wcp ? 'turn off Workspace Config+ first' : 'recommended',
      mode: wcp ? undefined : 'generated',
      detail: wcp ? wcpText : 'The team commits .vscode/settings.shared.json. settings.json is generated from it and your settings.local.json, and Git ignores both. Teammates without this extension copy settings.shared.json to settings.json.',
    });
  items.push({
    label: '$(eye-closed) Keep settings.json committed',
    description: tracked ? (t.kind === 'workspace' ? 'for a .code-workspace file' : 'nothing changes for the team') : noGit ? 'needs Git' : 'needs a committed file',
    mode: tracked ? 'committed' : undefined,
    detail: tracked
      ? `${path.basename(t.settingsFile)} stays the team's file in Git. Your settings.local.json is applied to it and Git is told to skip the file (skip-worktree), so personal values never show in git status. A pull that changes it needs one click to unhide first.`
      : (noGit ?? `${path.basename(t.settingsFile)} is not committed to Git here, so there is nothing to hide personal settings from.`),
  });
  const choice = await vscode.window.showQuickPick(items, { title: `Set up local settings: ${t.name}`, placeHolder: 'How should the settings file live in Git?', ignoreFocusOut: true });
  if (!choice) return;
  if (!choice.mode) {
    if (wcp && choice === items[0]) return void vscode.window.showWarningMessage(wcpText, { modal: true });
    if (noGit) return void vscode.window.showWarningMessage(noGit);
    void vscode.window.showInformationMessage(`${path.basename(t.settingsFile)} needs to be committed before its personal settings can be hidden. Commit it first, or choose a generated settings.json.`);
    return;
  }
  const mode = choice.mode;
  let personal: string[] = [];
  if (mode === 'generated') {
    const st = await core.readState(t.settingsFile);
    const current = core.parseBlock(st.text, t.block, core.short(t, t.settingsFile));
    const keys = Object.keys(current);
    if (keys.length) {
      const picks = await vscode.window.showQuickPick<KeyPick>(
        keys.map((key) => ({ label: key, description: brief(current[key]), key, picked: looksPersonal(key, current[key]) })),
        { title: 'Which of these settings are just yours?', placeHolder: 'Ticked settings go to settings.local.json; the rest become settings.shared.json for the team', canPickMany: true, ignoreFocusOut: true },
      );
      if (!picks) return;
      personal = picks.map((p) => p.key);
    }
  }
  const plan = await core.planInit(t, mode, personal, mgr.context(e));
  if (plan.files.length) {
    await showPlan(`Set up ${t.name}`, t, plan.files);
    const n = plan.files.length;
    const a = await vscode.window.showInformationMessage(
      `Set up ${t.name}: write ${n === 1 ? '1 file' : `${n} files`} (${plan.files.map((f) => core.short(t, f.path)).join(', ')})${mode === 'committed' ? ` and hide ${path.basename(t.settingsFile)} from git status` : ''}? A copy of each is kept first.${plan.note ? ` ${plan.note}` : ''}`,
      'Set Up',
      'Cancel',
    );
    await previews.closeAll();
    if (a !== 'Set Up') return;
  } else if (plan.note) {
    const a = await vscode.window.showWarningMessage(`Set up ${t.name}? ${plan.note}`, 'Set Up', 'Cancel');
    if (a !== 'Set Up') return;
  }
  await mgr.enqueue(e, () => core.commitInit(t, plan, mgr.context(e)));
  await mgr.saveState(e, plan.state);
  await mgr.enqueue(e, () => mgr.run(e));
  void vscode.window.showInformationMessage(
    mode === 'generated'
      ? `${t.name}: settings.json is now generated from settings.shared.json (commit it) and settings.local.json (just yours).`
      : `${t.name}: personal settings now live in ${core.short(t, t.localFile)} and are hidden from Git.`,
  );
  await gitIgnore(e, false);
}

async function showPlan(title: string, t: core.Target, files: core.FilePlan[]) {
  // A new file has no "before": the multi-file diff shows it as added, in full.
  const rows = files.map((f) => ({ f, before: f.before === undefined ? undefined : previews.put('before', f.path, f.before), after: previews.put('after', f.path, f.after) }));
  try {
    await vscode.commands.executeCommand(
      'vscode.changes',
      title,
      rows.map((r) => [vscode.Uri.file(r.f.path), r.before, r.after]),
    );
  } catch {
    const r = rows[rows.length - 1];
    await vscode.commands.executeCommand('vscode.diff', r.before ?? previews.put('before', r.f.path, ''), r.after, `${title}: ${core.short(t, r.f.path)}`, { preview: true });
  }
}

// ---- Git ignore ----------------------------------------------------------------------

type IgnorePick = vscode.QuickPickItem & { where?: 'gitignore' | 'exclude' };

async function gitIgnore(e: Entry, explicit: boolean) {
  if (!mgr.guard() || !e.st) return;
  const t = e.t;
  const files = e.st.mode === 'generated' ? [t.settingsFile, t.localFile] : [t.localFile];
  const need: { file: string; repo: core.git.RepoFile }[] = [];
  let root: string | undefined;
  for (const f of files) {
    let r: core.git.RepoFile | undefined;
    try {
      r = await core.git.locate(f);
    } catch (err) {
      if (!(err instanceof core.git.GitUnavailable)) throw err;
      if (explicit) void vscode.window.showWarningMessage(err.message);
      return;
    }
    if (!r) continue;
    root = r.root;
    if (!(await core.git.isIgnored(r))) need.push({ file: f, repo: r });
  }
  if (!root) {
    if (explicit) void vscode.window.showInformationMessage(`${t.name} is not in a Git repository, so there is nothing to keep out of it.`);
    return;
  }
  if (need.length) {
    const lines = need.map((n) => core.git.ignorePattern(n.repo.rel));
    const pick = await vscode.window.showQuickPick<IgnorePick>(
      [
        { label: 'Add to .gitignore', description: 'for the whole team: commit it', detail: lines.join('  '), where: 'gitignore' },
        { label: 'Add to .git/info/exclude', description: 'this clone only, never committed', detail: lines.join('  '), where: 'exclude' },
        { label: 'Not now', description: 'Keep Local Settings Out of Git… asks again' },
      ],
      { title: `Keep ${need.map((n) => path.basename(n.file)).join(' and ')} out of Git?`, placeHolder: 'Git would otherwise offer to commit your personal settings', ignoreFocusOut: true },
    );
    if (pick?.where) {
      const file = await core.git.ignoreFile(root, pick.where);
      if (file) {
        // .gitignore is a file of the repository: never followed through a link.
        await core.git.addIgnoreRules(file, lines, 'Local Workspace Settings: personal settings and the generated settings.json', pick.where === 'gitignore' ? root : undefined);
        mgr.log.info(`Added ${lines.join(', ')} to ${file}`);
        const still: string[] = [];
        for (const n of need) if (!(await core.git.isIgnored(n.repo))) still.push(n.repo.rel);
        if (still.length) void vscode.window.showWarningMessage(`Git still does not ignore ${still.join(' and ')} after adding the rules to ${path.basename(file)}. Check that file for a rule that un-ignores it (a line starting with "!").`);
      }
    }
  } else if (explicit) void vscode.window.showInformationMessage(`Git already ignores ${files.map((f) => core.short(t, f)).join(' and ')}.`);

  if (e.st.mode === 'generated') {
    const r = await core.git.locate(t.settingsFile);
    if (r && (await core.git.isTracked(r))) {
      const a = await vscode.window.showWarningMessage(
        `${core.short(t, t.settingsFile)} is still committed, so the generated file (with your settings in it) would show up in git status. Stop tracking it? The file stays on disk; the next commit removes it from the repository, and settings.shared.json takes its place.`,
        { modal: true },
        'Stop Tracking settings.json',
      );
      if (a) {
        await core.git.untrack(r);
        void vscode.window.showInformationMessage(`${core.short(t, t.settingsFile)} is no longer tracked. Commit that together with settings.shared.json and the ignore rules.`);
      }
    }
  }
  OverviewPanel.current?.refresh();
}

// ---- Everyday commands -----------------------------------------------------------------

async function regenerate() {
  if (!mgr.guard()) return;
  const list = mgr.active();
  if (!list.length) return void (await pickEntry(undefined, ''));
  for (const e of list) {
    e.asked.clear();
    const r = await mgr.enqueue(e, () => mgr.run(e));
    if (r?.status === 'ok') vscode.window.setStatusBarMessage(`$(check) ${e.t.name}: ${r.wrote.length ? `wrote ${r.wrote.map((f) => core.short(e.t, f)).join(', ')}` : 'already in sync'}`, 4000);
  }
}

async function openShared(id?: string) {
  await withEntry(id, 'Open the shared settings of which folder?', async (e) => {
    if (e.st?.mode === 'committed') {
      if (!mgr.guard()) return;
      const repo = await core.git.locate(e.t.settingsFile);
      const text = repo ? await core.git.indexText(repo) : undefined;
      const uri = previews.put('committed', e.t.settingsFile, text ?? '');
      await vscode.window.showTextDocument(uri, { preview: true });
      void vscode.window.setStatusBarMessage(`The committed ${core.short(e.t, e.t.settingsFile)}, read-only. To change it, use Unhide settings.json to Commit a Team Change.`, 6000);
    } else await vscode.window.showTextDocument(vscode.Uri.file(e.t.sharedFile));
  });
}

async function openLocal(id?: string) {
  await withEntry(id, 'Open the local settings of which folder?', async (e) => {
    const st = await core.readState(e.t.localFile);
    if (!st.exists) {
      if (!mgr.guard()) return;
      await core.atomicWrite(e.t.localFile, core.newDocument({}, core.LOCAL_HEADER(e.st!.mode)), e.t.root);
    }
    await vscode.window.showTextDocument(vscode.Uri.file(e.t.localFile));
  });
}

async function showDiff(id?: string) {
  await withEntry(id, 'Show the local changes of which folder?', async (e) => {
    if (e.st?.mode === 'committed' && !mgr.guard()) return;
    const d = await core.overlayDiff(e.t, e.st!, mgr.context(e));
    const left = previews.put('shared', 'shared.jsonc', d.shared);
    const right = previews.put('merged', 'with-local.jsonc', d.merged);
    await vscode.commands.executeCommand('vscode.diff', left, right, `${e.t.name}: what ${path.basename(e.t.localFile)} changes`, { preview: true });
  });
}

type BackupPick = vscode.QuickPickItem & { b: core.BackupEntry; e: Entry };

async function backupsFor(id?: string): Promise<BackupPick[]> {
  const ids = typeof id === 'string' ? [id] : mgr.active().map((e) => e.t.id);
  const out: BackupPick[] = [];
  for (const tid of ids) {
    const e = mgr.entries.get(tid);
    if (!e) continue;
    for (const b of await mgr.backups.list(tid)) out.push({ label: b.reason, description: `${e.t.name} · ${when(b.at)}`, detail: b.files.map((f) => `${core.short(e.t, f.path)}${f.absent ? ' (did not exist)' : ''}`).join(', '), b, e });
  }
  return out.sort((x, y) => y.b.at - x.b.at);
}

async function restoreEntry(p: BackupPick) {
  const a = await vscode.window.showWarningMessage(`Undo "${p.b.reason}" (${when(p.b.at)})? This puts back ${p.detail}. The current files are backed up first.`, { modal: true }, 'Restore');
  if (!a) return;
  const st = await mgr.enqueue(p.e, async () => {
    const st = await core.restore(p.e.t, p.e.st!, p.b, mgr.context(p.e));
    await mgr.saveState(p.e, st);
    return st;
  });
  if (!st) {
    // The setup itself was undone: the folder is back as it was, with nothing to merge.
    void mgr.updateContext();
    OverviewPanel.current?.refresh();
    return void vscode.window.showInformationMessage(`Restored the files from before "${p.b.reason}". Local settings are off for ${p.e.t.name} again.`);
  }
  await mgr.enqueue(p.e, () => mgr.run(p.e));
  void vscode.window.showInformationMessage(`Restored the files from before "${p.b.reason}".`);
}

async function undo(id?: string) {
  if (!mgr.guard()) return;
  const list = await backupsFor(id);
  if (!list.length) return void vscode.window.showInformationMessage('Nothing to undo yet. A copy of the files is kept before every change this extension makes.');
  await restoreEntry(list[0]);
}

async function restoreBackup(id?: string) {
  if (!mgr.guard()) return;
  const list = await backupsFor(id);
  if (!list.length) return void vscode.window.showInformationMessage('No backups yet. A copy of the files is kept before every change this extension makes.');
  const pick = await vscode.window.showQuickPick(list, { title: 'Restore the files from before…', matchOnDescription: true, matchOnDetail: true });
  if (pick) await restoreEntry(pick);
}

async function moveCmd(op: core.LayerEdit['op'], id?: string, key?: string) {
  if (!mgr.guard()) return;
  const e = await pickEntry(id, 'In which folder?');
  if (!e) return;
  if (!key) {
    const v = await mgr.view(e);
    const keys = v.keys.filter((k) => (op === 'toLocal' ? k.origin === 'shared' : op === 'toShared' ? k.origin !== 'shared' : k.origin === 'overridden' || k.origin === 'removed'));
    if (!keys.length) return void vscode.window.showInformationMessage(op === 'toLocal' ? 'No shared settings to move.' : op === 'toShared' ? 'Your local file has no settings.' : 'Nothing in your local file overrides a shared setting.');
    const pick = await vscode.window.showQuickPick(
      keys.map((k) => ({ label: k.key, description: `${k.origin} · ${brief(k.effective)}` })),
      { title: op === 'toLocal' ? 'Move which setting to your local file?' : op === 'toShared' ? 'Share which setting with the team?' : 'Remove which override?' },
    );
    if (!pick) return;
    key = pick.label;
  }
  await mgr.move(e, [{ op, key }]);
}

async function unhideCmd(reason: 'pull' | 'team', id?: string) {
  if (!mgr.guard()) return;
  const e = await pickEntry(id, 'Unhide settings.json in which folder?', (x) => x.st?.mode === 'committed');
  if (!e) return;
  const r = await mgr.enqueue(e, () => core.unhide(e.t, e.st!, mgr.context(e), reason, async (cs) => cs.map(() => 'defer')));
  if (r.status === 'unhidden') {
    await mgr.saveState(e, r.state);
    e.upstream = false;
    if (r.message) void vscode.window.showWarningMessage(`${e.t.name}: ${r.message}`);
    if (reason === 'team') await vscode.window.showTextDocument(vscode.Uri.file(e.t.settingsFile));
    void vscode.window.showInformationMessage(
      reason === 'pull'
        ? `${core.short(e.t, e.t.settingsFile)} shows the committed settings again and Git can see it. Pull now: your personal settings come back on their own once the pull is done.`
        : `Edit ${core.short(e.t, e.t.settingsFile)} and commit it: those edits go to the team. Your personal settings come back once it is committed (or with Hide Personal Settings Again).`,
    );
  } else if (r.status === 'pending') void vscode.window.showWarningMessage(`${e.t.name}: sort the changed settings first (${r.message})`);
  else if (r.status === 'error') void vscode.window.showWarningMessage(`${e.t.name}: ${r.message}`);
  await mgr.updateContext();
  OverviewPanel.current?.refresh();
}

async function hideCmd(id?: string) {
  if (!mgr.guard()) return;
  const e = await pickEntry(id, 'Hide personal settings in which folder?', (x) => x.st?.mode === 'committed');
  if (!e) return;
  if (!e.st?.unhidden) {
    await mgr.enqueue(e, () => mgr.run(e));
    return void vscode.window.showInformationMessage(`${e.t.name}: personal settings are already hidden from Git.`);
  }
  const r = await mgr.enqueue(e, () => mgr.run(e, undefined, { hide: true, reason: 'Hid personal settings again' }));
  if (r?.status === 'ok') void vscode.window.showInformationMessage(`${e.t.name}: personal settings are applied again and hidden from Git.`);
}

async function stop(id?: string) {
  if (!mgr.guard()) return;
  const e = await pickEntry(id, 'Stop using local settings in which folder?');
  if (!e?.st) return;
  const t = e.t;
  const settings = core.short(t, t.settingsFile);
  let keep: 'mine' | 'commit' = 'mine';
  if (e.st.mode === 'generated') {
    const a = await vscode.window.showWarningMessage(
      `Stop using local settings in ${t.name}? ${settings} stays as it is now, a plain file without the generated comment, and is no longer merged. ${core.short(t, t.sharedFile)} and ${core.short(t, t.localFile)} stay on disk, and the ignore rules stay in place.`,
      { modal: true },
      'Stop',
    );
    if (!a) return;
  } else {
    const mine = 'Keep My Settings in It';
    const commit = 'Put Back the Committed File';
    const a = await vscode.window.showWarningMessage(
      `Stop using local settings in ${t.name}? Git sees ${settings} again (skip-worktree is cleared). It can keep your personal settings, which then show in git status, or go back to the committed content; ${core.short(t, t.localFile)} stays on disk either way.`,
      { modal: true },
      mine,
      commit,
    );
    if (!a) return;
    keep = a === commit ? 'commit' : 'mine';
  }
  await mgr.enqueue(e, async () => {
    await core.teardown(t, e.st!, mgr.context(e), keep);
    await mgr.turnOff(e);
  });
  OverviewPanel.current?.refresh();
  void vscode.window.showInformationMessage(`${t.name}: local settings are off. Set Up in This Workspace… turns them on again.`);
}

function brief(v: unknown): string {
  if (v === undefined) return 'removed';
  const s = JSON.stringify(v);
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}

function when(at: number) {
  const d = new Date(at);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
