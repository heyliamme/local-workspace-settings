// The sync engine: reads the shared and local layers, notices edits made to the file VS
// Code reads (by the Settings editor, another extension or by hand) and asks where they
// go, writes the merge, and keeps the committed-file mode's skip-worktree flag. No VS Code
// here: the router (who to ask) and the backups folder are passed in.
//
// Every run reads all files, decides, re-reads to make sure nothing changed in between,
// backs up what it is about to change, then writes atomically. A run that would write
// the same text writes nothing, so its own writes never trigger another write.
import * as path from 'path';
import { assertConfined, atomicWrite, readState, removeFile, sha, type BackupEntry, type Backups, type FileState } from './files';
import * as G from './git';
import { detectFormat, dropHeader, newDocument, parseBlock, parseObject, setBlock, SyntaxProblem, withHeader } from './jsonc';
import { afterSharing, changedKeys, describe, merge, routeToLocal, shareChange, type ArrayRules, type KeyInfo } from './merge';
import { clone, isObj, same, type Json, type JsonObject } from './value';

export type Mode = 'generated' | 'committed';

export interface Target {
  /** The settings file VS Code reads; also the target's identity. */
  id: string;
  kind: 'folder' | 'workspace';
  /** Folder name or workspace file name, for messages. */
  name: string;
  /** Writes stay inside this folder, never through a symbolic link. */
  root: string;
  settingsFile: string;
  /** Where the settings object sits in the file: [] for settings.json, ["settings"] in a .code-workspace. */
  block: string[];
  /** generated mode only. */
  sharedFile: string;
  localFile: string;
}

export function folderTarget(folder: string, name = path.basename(folder)): Target {
  const dir = path.join(folder, '.vscode');
  const settingsFile = path.join(dir, 'settings.json');
  return { id: settingsFile, kind: 'folder', name, root: folder, settingsFile, block: [], sharedFile: path.join(dir, 'settings.shared.json'), localFile: path.join(dir, 'settings.local.json') };
}

/** A .code-workspace file: its "settings" block, with overrides in "<file>.local.json" next to it. Committed mode only. */
export function workspaceTarget(file: string): Target {
  return { id: file, kind: 'workspace', name: path.basename(file), root: path.dirname(file), settingsFile: file, block: ['settings'], sharedFile: '', localFile: `${file}.local.json` };
}

export const short = (t: Target, file: string) => (t.kind === 'folder' ? path.relative(t.root, file).split(path.sep).join('/') : path.basename(file));

export interface TargetState {
  mode: Mode;
  /** Hash of the settings file as last written or accepted. */
  written?: string;
  /** Its settings as last written or accepted. */
  effective?: JsonObject;
  /** The layers as last merged, to tell which side changed a key. */
  shared?: JsonObject;
  local?: JsonObject;
  /** committed: the index blob at the last merge. */
  blob?: string;
  /** committed: settings.json shows the committed content so Git can pull or commit it. */
  unhidden?: { reason: 'pull' | 'team'; blob?: string; at: number; /** HEAD when it was unhidden. */ head?: string };
}

export interface Change {
  key: string;
  /** The value in the settings file now; undefined when it was removed. */
  value: Json | undefined;
  /** The value that was written there before. */
  previous: Json | undefined;
  /** The layer files changed the same setting since the last merge (to this value). */
  conflict?: { layer: 'local' | 'shared'; value: Json | undefined };
  /** Nothing records what was written (a fresh clone, or a settings.json from before setup). */
  unknown?: boolean;
}

/** local / shared: where the change goes. discard: drop it (it stays in the backup). defer: decide later, write nothing. */
export type Route = 'local' | 'shared' | 'discard' | 'defer';
export type Router = (changes: Change[]) => Promise<Route[]>;

/**
 * toLocal / toShared move the whole setting (the overview's buttons). shareChange shares
 * only what one routed change did (from `before` to `after`), so the rest of a personal
 * value stays personal: the "Move to Shared" button of the notice after a routed change.
 */
export type LayerEdit = { op: 'toLocal' | 'toShared' | 'removeOverride'; key: string } | { op: 'shareChange'; key: string; before?: Json; after?: Json };

export interface Context {
  backups: Backups;
  /** Array merge rules from the user's settings; the shared layer's own rules win. */
  rules?: ArrayRules;
  header?: boolean;
}

export interface SyncOptions {
  router: Router;
  edit?: LayerEdit[];
  /** committed mode: hide personal settings again even though settings.json differs from the commit. */
  hide?: boolean;
  reason?: string;
}

export interface SyncResult {
  status: 'ok' | 'error' | 'pending' | 'unhidden';
  state: TargetState;
  /** Files written, in order. */
  wrote: string[];
  /** Where each changed setting went, with the change itself. */
  routed: { key: string; to: Route; previous?: Json; value?: Json }[];
  message?: string;
  /** Something the user should know although the run went through. */
  notice?: string;
  /** The file that can't be read, for an error. */
  file?: string;
  /** committed mode: personal settings were hidden again by this run. */
  rehid?: boolean;
  backup?: BackupEntry;
}

export const HEADER_MARK = 'Generated by Local Workspace Settings';
export const GENERATED_HEADER = [
  `${HEADER_MARK} from settings.shared.json (the team's,`,
  'committed) and settings.local.json (yours, not committed). Edit those two files.',
  'A change made here, by hand or in the Settings editor, is moved to one of them.',
];
export const LOCAL_HEADER = (mode: Mode) => [
  `Your own settings, kept out of Git. They win over ${mode === 'generated' ? 'settings.shared.json' : 'the committed settings'}.`,
  'null removes a shared setting; { "$replace": value } replaces instead of merging.',
];
export const SHARED_HEADER = ["The team's workspace settings, committed. settings.json is generated from this file", 'and your settings.local.json by the Local Workspace Settings extension.'];

class Retry extends Error {}

interface Layers {
  settings: FileState;
  local: FileState;
  shared: FileState;
  /** The shared layer: settings.shared.json, or the committed settings. */
  base: JsonObject;
  baseText: string;
  localObj: JsonObject;
  current?: JsonObject;
  repo?: G.RepoFile;
  blob?: string;
  rules?: ArrayRules;
}

function rulesFrom(base: JsonObject, user?: ArrayRules): ArrayRules | undefined {
  const own = base['localWorkspaceSettings.arrayMerge'];
  return isObj(own) ? { ...user, ...(own as ArrayRules) } : user;
}

/**
 * A layer file, or the settings file, that is a symbolic link (or sits behind one) is not
 * read: a repository could commit settings.shared.json as a link to any file of the user's
 * and have its content merged into settings.json, where Git would offer to commit it.
 */
export class Refused extends Error {
  constructor(
    readonly file: string,
    detail: string,
  ) {
    super(`${detail} Settings are not read through links; nothing was merged.`);
  }
}

async function confineReads(t: Target, files: string[]) {
  for (const f of files.filter(Boolean)) {
    try {
      await assertConfined(f, t.root);
    } catch (e) {
      throw new Refused(short(t, f), (e as Error).message.replace(/ Settings are not written through links; nothing was written\.$/, ''));
    }
  }
}

async function readLayers(t: Target, mode: Mode, ctx: Context): Promise<Layers> {
  await confineReads(t, [t.settingsFile, t.localFile, ...(mode === 'generated' ? [t.sharedFile] : [])]);
  const [settings, local, shared] = await Promise.all([readState(t.settingsFile), readState(t.localFile), mode === 'generated' ? readState(t.sharedFile) : Promise.resolve<FileState>({ path: '', exists: false, text: '', hash: 'absent' })]);
  const localObj = parseObject(local.text, short(t, t.localFile));
  let base: JsonObject;
  let baseText: string;
  let repo: G.RepoFile | undefined;
  let blob: string | undefined;
  if (mode === 'generated') {
    baseText = shared.text;
    base = parseObject(shared.text, short(t, t.sharedFile));
  } else {
    repo = await G.locate(t.settingsFile);
    if (!repo || !(await G.isTracked(repo))) throw new NotCommitted(t);
    baseText = (await G.indexText(repo)) ?? '';
    blob = await G.indexBlob(repo);
    base = parseBlock(baseText, t.block, `The committed ${short(t, t.settingsFile)}`);
  }
  const current = settings.exists ? parseBlock(settings.text, t.block, short(t, t.settingsFile)) : undefined;
  return { settings, local, shared, base, baseText, localObj, current, repo, blob, rules: rulesFrom(base, ctx.rules) };
}

export class NotCommitted extends Error {
  constructor(t: Target) {
    super(`${short(t, t.settingsFile)} is not committed to Git, so there is nothing to hide personal settings from. Commit it first, or use a generated settings.json.`);
  }
}

/** The text of the settings file for a merge. */
function render(t: Target, mode: Mode, L: Layers, sharedText: string, effective: JsonObject, ctx: Context): string {
  if (mode === 'generated') {
    const body = dropHeader(sharedText, SHARED_HEADER);
    const fmt = detectFormat(sharedText || L.settings.text);
    const out = setBlock(body, [], effective, fmt);
    return ctx.header === false ? out : withHeader(out, GENERATED_HEADER, fmt.eol);
  }
  const start = L.settings.exists && L.current ? L.settings.text : L.baseText;
  return setBlock(start, t.block, effective);
}

function layerText(existing: FileState, obj: JsonObject, header: string[], fmtFrom?: string): string {
  if (existing.exists && existing.text.trim()) return setBlock(existing.text, [], obj);
  return newDocument(obj, header, fmtFrom ? detectFormat(fmtFrom) : {});
}

/** Runs one merge. See the file comment. */
export async function sync(t: Target, st: TargetState, ctx: Context, opts: SyncOptions): Promise<SyncResult> {
  for (let i = 0; i < 4; i++) {
    try {
      return await once(t, clone(st), ctx, opts);
    } catch (e) {
      if (e instanceof Retry) continue;
      if (e instanceof Paused) return { status: 'error', state: st, wrote: [], routed: [], message: e.message };
      if (e instanceof SyntaxProblem || e instanceof Refused) return { status: 'error', state: st, wrote: [], routed: [], message: e.message, file: e.file };
      if (e instanceof NotCommitted || e instanceof G.GitUnavailable) return { status: 'error', state: st, wrote: [], routed: [], message: e.message };
      throw e;
    }
  }
  return { status: 'error', state: st, wrote: [], routed: [], message: 'The settings files kept changing while they were being merged. Nothing was written; try again.' };
}

/** generated mode, paused: this checkout doesn't use local settings right now. */
export class Paused extends Error {}

/**
 * generated mode needs the team's file. Without it this checkout doesn't use local settings
 * (a branch from before the switch, say), and settings.json may be Git's own file again,
 * put back by the checkout: then nothing is merged, moved or written until it is back.
 */
async function checkSetUpHere(t: Target, st: TargetState, L: Layers) {
  if (!L.shared.exists) throw new Paused(`${short(t, t.sharedFile)} is missing, so this checkout (another branch?) doesn't use local settings. Nothing is merged or moved until it is back; ${short(t, t.localFile)} is kept as it is.`);
  if (!L.settings.exists || L.settings.hash === st.written) return;
  let repo: G.RepoFile | undefined;
  try {
    repo = await G.locate(t.settingsFile);
  } catch {
    return; // a generated settings.json needs no git
  }
  if (repo && (await G.isTracked(repo)) && G.sameText(L.settings.text, await G.indexText(repo)))
    throw new Paused(`${short(t, t.settingsFile)} is committed to Git in this checkout and shows the committed content, so it is not regenerated (that would change a file Git tracks). To generate it here, stop tracking it with Keep Local Settings Out of Git….`);
}

/** A workspace file whose working copy differs from the commit outside "settings" (folders, launch, tasks). */
export function editedOutside(t: Target, text: string, baseText: string): boolean {
  if (!t.block.length || !text) return false;
  try {
    return !G.sameText(setBlock(text, t.block, parseBlock(baseText, t.block)), baseText);
  } catch {
    return false;
  }
}

export const OUTSIDE_HIDDEN = (t: Target) =>
  `${short(t, t.settingsFile)} has uncommitted changes outside "settings" (folders, launch, tasks). Git doesn't show them while the file is hidden; to commit them, use Unhide settings.json to Commit a Team Change.`;
const OUTSIDE_SHOWN = (t: Target) => `Its uncommitted changes outside "settings" (folders, launch, tasks) show in Git now too: leave them out of the commit if they are yours alone.`;

async function once(t: Target, st: TargetState, ctx: Context, opts: SyncOptions): Promise<SyncResult> {
  const mode = st.mode;
  const L = await readLayers(t, mode, ctx);
  if (mode === 'generated') await checkSetUpHere(t, st, L);
  let base = clone(L.base);
  let local = clone(L.localObj);
  const routed: SyncResult['routed'] = [];
  const notes: string[] = [];
  let rehid = false;
  let prevEffective = st.effective;

  // committed mode, unhidden: leave the file to Git until it matches a new commit.
  if (mode === 'committed' && st.unhidden) {
    const asCommitted = G.sameText(L.settings.text, L.baseText) || (t.block.length > 0 && L.current !== undefined && same(L.current, L.base));
    let committedAgain = L.blob !== st.unhidden.blob && asCommitted;
    // Unhidden to pull, and pulled, but the pull didn't change this file: nothing is left to pull.
    if (!committedAgain && st.unhidden.reason === 'pull' && asCommitted && L.repo && st.unhidden.head) {
      const h = await G.head(L.repo.root);
      if (h && h !== st.unhidden.head && !(await G.upstreamTouches(L.repo))) committedAgain = true;
    }
    if (committedAgain || opts.hide) {
      rehid = true;
      if (!committedAgain && L.blob === st.unhidden.blob && st.effective) {
        // Hidden again without a commit: the file still shows what was written for Git (the
        // commit, or the commit with a team change that is now dropped). A dropped team change
        // keeps, for this user alone, the values it gave them; edits made since are routed.
        const shown = st.effective;
        const personal = merge(shown, local, L.rules);
        for (const k of changedKeys(L.base, shown)) if (!same(merge(base, local, L.rules)[k], personal[k])) local = routeToLocal(base, local, k, personal[k], L.rules);
        prevEffective = shown;
      } else {
        // What is in the file now and not in the commit is a change made while unhidden.
        prevEffective = L.base;
      }
      st.written = undefined;
      st.unhidden = undefined;
    } else {
      return { status: 'unhidden', state: st, wrote: [], routed: [], message: `${short(t, t.settingsFile)} shows the committed settings so Git can ${st.unhidden.reason === 'pull' ? 'pull' : 'commit'} it.` };
    }
  }

  // 1. Edits made to the settings file since the last write.
  const team: Record<string, Json | undefined> = {};
  if (L.current && (st.written === undefined || L.settings.hash !== st.written || rehid)) {
    const gitReplaced = mode === 'committed' && st.blob !== undefined && L.blob !== st.blob && G.sameText(L.settings.text, L.baseText);
    const expected = rehid ? prevEffective! : (prevEffective ?? merge(L.base, L.localObj, L.rules));
    let keys = gitReplaced ? [] : changedKeys(expected, L.current);
    // With no record of what was written (a fresh clone, a settings.json from before this
    // folder used local settings), a setting the file lacks is not an edit: the file is
    // just older than the layers, and the merge fills it in.
    if (prevEffective === undefined) keys = keys.filter((k) => k in L.current!);
    // Keys the layers' own change explains are not edits: a fresh settings.json from an
    // older merge, say, already shows a value the layers now agree with.
    const fresh = merge(L.base, local, L.rules);
    const real = keys.filter((k) => !same(L.current![k], fresh[k]));
    if (real.length) {
      const changes: Change[] = real.map((key) => {
        const c: Change = { key, value: L.current![key], previous: expected[key] };
        if (prevEffective === undefined) c.unknown = true;
        if (st.local && !same(st.local[key], L.localObj[key])) c.conflict = { layer: 'local', value: L.localObj[key] };
        else if (st.shared && !same(st.shared[key], L.base[key])) c.conflict = { layer: 'shared', value: L.base[key] };
        return c;
      });
      const routes = await opts.router(changes);
      if (routes.some((r) => r === 'defer')) {
        return { status: 'pending', state: st, wrote: [], routed: [], message: `${real.length === 1 ? `${real[0]} was` : `${real.length} settings were`} changed in ${short(t, t.settingsFile)} and not sorted yet.` };
      }
      changes.forEach((c, i) => {
        const to = routes[i] ?? 'local';
        routed.push({ key: c.key, to, previous: c.previous, value: c.value });
        if (to === 'local') local = routeToLocal(base, local, c.key, c.value, L.rules);
        else if (to === 'shared') {
          // Only the change reaches the team; the rest of a personal override stays local.
          const shared = shareChange(base[c.key], c.previous, c.value, c.key, L.rules);
          const next = mode === 'committed' ? clone(base) : base;
          if (shared === undefined) delete next[c.key];
          else next[c.key] = shared;
          if (mode === 'committed') team[c.key] = shared;
          local = routeToLocal(next, local, c.key, afterSharing(next, local, c.key, c.value, L.rules), L.rules);
        }
      });
    }
  }

  // 2. Moves asked for from the overview, or from the notice after a routed change.
  for (const e of opts.edit ?? []) {
    const eff = merge(base, local, L.rules);
    const value = eff[e.key];
    if (e.op === 'removeOverride') delete local[e.key];
    else if (e.op === 'toLocal') {
      if (mode === 'committed') team[e.key] = undefined;
      else delete base[e.key];
      if (value === undefined) delete local[e.key];
      else local[e.key] = clone(value);
    } else if (e.op === 'shareChange') {
      // Only what that change did reaches the team, as when it is shared right away.
      const teamNow = mode === 'committed' && e.key in team ? team[e.key] : base[e.key];
      const shared = shareChange(teamNow, e.before, e.after, e.key, L.rules);
      const next = mode === 'committed' ? clone(base) : base;
      if (shared === undefined) delete next[e.key];
      else next[e.key] = shared;
      if (mode === 'committed') team[e.key] = shared;
      local = routeToLocal(next, local, e.key, afterSharing(next, local, e.key, value, L.rules), L.rules);
    } else {
      if (mode === 'committed') team[e.key] = value;
      else if (value === undefined) delete base[e.key];
      else base[e.key] = clone(value);
      delete local[e.key];
    }
  }

  // 3. The new texts.
  const writes: { state: FileState; text: string | undefined }[] = [];
  const localChanged = !same(local, L.localObj) || (!L.local.exists && Object.keys(local).length > 0);
  if (localChanged) writes.push({ state: L.local, text: layerText(L.local, local, LOCAL_HEADER(mode), L.settings.text || L.baseText) });
  let sharedText = L.shared.text;
  if (mode === 'generated' && !same(base, L.base)) {
    sharedText = layerText(L.shared, base, SHARED_HEADER, L.settings.text);
    writes.push({ state: L.shared, text: sharedText });
  }

  let settingsText: string;
  let unhidden: TargetState['unhidden'];
  if (mode === 'committed' && Object.keys(team).length) {
    // A team change: the file shows the commit plus the change, for Git to commit.
    const committed = clone(L.base);
    for (const [k, v] of Object.entries(team)) {
      if (v === undefined) delete committed[k];
      else committed[k] = clone(v);
    }
    // A workspace file keeps the rest of its working copy (folders, launch, tasks).
    const keepRest = t.block.length > 0 && L.settings.exists && L.current !== undefined;
    settingsText = setBlock(keepRest ? L.settings.text : L.baseText, t.block, committed);
    if (keepRest && editedOutside(t, L.settings.text, L.baseText)) notes.push(OUTSIDE_SHOWN(t));
    unhidden = { reason: 'team', blob: L.blob, at: Date.now(), head: L.repo ? await G.head(L.repo.root) : undefined };
  } else {
    settingsText = render(t, mode, L, sharedText, merge(base, local, L.rules), ctx);
  }
  const effective = parseBlock(settingsText, t.block);
  if (!L.settings.exists || settingsText !== L.settings.text) writes.push({ state: L.settings, text: settingsText });

  // 4. committed mode: Git is told to skip the file before personal values are written into
  // it, and only told to look again after the committed content (or a team change) is back.
  const want = !unhidden;
  const flagged = mode === 'committed' && L.repo ? await G.isSkipWorktree(L.repo) : undefined;
  if (L.repo && flagged === false && want) await G.setSkipWorktree(L.repo, true);
  // Hiding a workspace file hides its other uncommitted edits too: say so.
  if (L.repo && want && (rehid || flagged === false) && editedOutside(t, L.settings.text, L.baseText)) notes.push(OUTSIDE_HIDDEN(t));

  let backup: BackupEntry | undefined;
  if (writes.length) {
    const reason = opts.reason ?? (routed.length ? `Moved ${routed.map((r) => r.key).join(', ')}` : 'Merged settings');
    // The backup first; then each file is checked again just before it is replaced, so an
    // edit made while the backup was written is never overwritten unseen. Old backups are
    // removed only after the writes.
    backup = await ctx.backups.take(t.id, reason, writes.map((w) => w.state), { rotate: false });
    let done = 0;
    for (const w of writes) {
      if ((await readState(w.state.path)).hash !== w.state.hash) {
        // Nothing written yet: the backup is of no use. Otherwise it holds what was replaced.
        if (!done) await ctx.backups.remove(backup);
        else await ctx.backups.rotate(t.id);
        throw new Retry();
      }
      if (w.text === undefined) await removeFile(w.state.path, t.root);
      else await atomicWrite(w.state.path, w.text, t.root);
      done++;
    }
    await ctx.backups.rotate(t.id);
  }
  if (L.repo && flagged === true && !want) await G.setSkipWorktree(L.repo, false);

  const next: TargetState = { mode, written: sha(settingsText), effective, shared: base, local, blob: mode === 'committed' ? L.blob : undefined, unhidden };
  const note = notes.length ? notes.join(' ') : undefined;
  if (unhidden) {
    const message = `${short(t, t.settingsFile)} now shows the committed settings with your change, for you to commit. Your personal settings come back once it is committed (or with Hide Personal Settings Again).${note ? ` ${note}` : ''}`;
    return { status: 'unhidden', state: next, wrote: writes.map((w) => w.state.path), routed, rehid, backup, message, notice: note };
  }
  return { status: 'ok', state: next, wrote: writes.map((w) => w.state.path), routed, rehid, backup, notice: note };
}

// ---- Setting up -----------------------------------------------------------------------

export interface FilePlan {
  path: string;
  before: string | undefined;
  after: string;
}

export interface InitPlan {
  mode: Mode;
  files: FilePlan[];
  state: TargetState;
  /** Keys that end up in the local file. */
  personal: string[];
  /** Something to say before the files are written. */
  note?: string;
}

/**
 * What setting up a folder writes. generated: settings.json minus `personal` becomes
 * settings.shared.json, `personal` goes to settings.local.json. committed: whatever
 * settings.json has that the commit doesn't is added to settings.local.json.
 */
export async function planInit(t: Target, mode: Mode, personal: string[], ctx: Context): Promise<InitPlan> {
  await confineReads(t, [t.settingsFile, t.localFile, ...(mode === 'generated' ? [t.sharedFile] : [])]);
  const settings = await readState(t.settingsFile);
  const local = await readState(t.localFile);
  const current = parseBlock(settings.text, t.block, short(t, t.settingsFile));
  let localObj = parseObject(local.text, short(t, t.localFile));
  const files: FilePlan[] = [];
  let state: TargetState;
  let note: string | undefined;
  if (mode === 'generated') {
    if (t.kind !== 'folder') throw new Error('A workspace file keeps its settings committed; use the committed mode for it.');
    const shared = await readState(t.sharedFile);
    if (shared.exists) throw new Error(`${short(t, t.sharedFile)} already exists. Use Merge Now to merge it with your settings.`);
    const rules = rulesFrom(current, ctx.rules);
    const sharedObj: JsonObject = {};
    for (const [k, v] of Object.entries(current)) if (!personal.includes(k)) sharedObj[k] = v;
    for (const k of personal) if (k in current) localObj = routeToLocal(sharedObj, localObj, k, current[k], rules);
    const body = settings.exists ? dropHeader(settings.text, GENERATED_HEADER) : '';
    const sharedText = body.trim() ? withHeader(setBlock(body, [], sharedObj), SHARED_HEADER, detectFormat(body).eol) : newDocument(sharedObj, SHARED_HEADER);
    files.push({ path: t.sharedFile, before: undefined, after: sharedText });
    const localText = layerText(local, localObj, LOCAL_HEADER(mode), settings.text);
    if (localText !== local.text) files.push({ path: t.localFile, before: local.exists ? local.text : undefined, after: localText });
    const L: Layers = { settings, local, shared, base: sharedObj, baseText: sharedText, localObj, current, rules };
    const eff = merge(sharedObj, localObj, rules);
    const settingsText = render(t, mode, L, files[0].after, eff, ctx);
    if (settingsText !== settings.text) files.push({ path: t.settingsFile, before: settings.exists ? settings.text : undefined, after: settingsText });
    state = { mode, written: sha(settingsText), effective: parseBlock(settingsText, []), shared: sharedObj, local: localObj };
  } else {
    const repo = await G.locate(t.settingsFile);
    if (!repo || !(await G.isTracked(repo))) throw new NotCommitted(t);
    const baseText = (await G.indexText(repo)) ?? '';
    const base = parseBlock(baseText, t.block, `The committed ${short(t, t.settingsFile)}`);
    const rules = rulesFrom(base, ctx.rules);
    // An existing local file is kept; only what settings.json changes against the commit
    // is added to it (settings.json wins for those keys).
    for (const k of changedKeys(base, current)) localObj = routeToLocal(base, localObj, k, current[k], rules);
    const localText = layerText(local, localObj, LOCAL_HEADER(mode), settings.text);
    if (localText !== local.text) files.push({ path: t.localFile, before: local.exists ? local.text : undefined, after: localText });
    const L: Layers = { settings, local, shared: settings, base, baseText, localObj, current, repo };
    const settingsText = render(t, mode, L, '', merge(base, localObj, rules), ctx);
    if (settingsText !== settings.text) files.push({ path: t.settingsFile, before: settings.text, after: settingsText });
    state = { mode, written: sha(settingsText), effective: parseBlock(settingsText, t.block), shared: base, local: localObj, blob: await G.indexBlob(repo) };
    if (editedOutside(t, settings.text, baseText)) note = OUTSIDE_HIDDEN(t);
  }
  return { mode, files, state, personal: Object.keys(localObj), note };
}

/** Writes a plan, after checking that none of its files changed since it was made. */
export async function commitInit(t: Target, plan: InitPlan, ctx: Context): Promise<BackupEntry | undefined> {
  const states = await Promise.all(plan.files.map((f) => readState(f.path)));
  states.forEach((s, i) => {
    const before = plan.files[i].before;
    if ((before === undefined ? 'absent' : sha(before)) !== s.hash) throw new Error(`${short(t, s.path)} changed since the preview was made. Nothing was written; run the setup again.`);
  });
  let backup: BackupEntry | undefined;
  if (plan.files.length) {
    backup = await ctx.backups.take(t.id, `Set up (${plan.mode === 'generated' ? 'generated settings.json' : 'committed settings.json'})`, states, { setup: plan.mode });
    for (const f of plan.files) await atomicWrite(f.path, f.after, t.root);
  }
  if (plan.mode === 'committed') {
    const repo = await G.locate(t.settingsFile);
    if (repo) await G.setSkipWorktree(repo, true);
  }
  return backup;
}

// ---- committed mode: making room for Git ---------------------------------------------

/**
 * Puts the committed content back into settings.json and clears skip-worktree, so a pull
 * that changes it (or a team change) can go through. Personal settings come back on their
 * own once the file matches a newer commit, or with hide().
 */
export async function unhide(t: Target, st: TargetState, ctx: Context, reason: 'pull' | 'team', router: Router): Promise<SyncResult> {
  if (st.mode !== 'committed') throw new Error('Only a committed settings.json is hidden.');
  if (st.unhidden) return { status: 'unhidden', state: st, wrote: [], routed: [] };
  const first = await sync(t, st, ctx, { router });
  if (first.status !== 'ok') return first;
  const s = first.state;
  const repo = await G.locate(t.settingsFile);
  if (!repo) throw new NotCommitted(t);
  const baseText = (await G.indexText(repo)) ?? '';
  const settings = await readState(t.settingsFile);
  // A settings.json goes back to the commit as it is. A workspace file only gets its
  // "settings" block back: its folders, launch and tasks keep what the working copy has.
  let text = baseText;
  let kept = false;
  if (t.block.length && settings.exists) {
    text = setBlock(settings.text, t.block, parseBlock(baseText, t.block, `The committed ${short(t, t.settingsFile)}`));
    kept = !G.sameText(text, baseText);
  }
  let backup: BackupEntry | undefined;
  if (!G.sameText(settings.text, text)) {
    backup = await ctx.backups.take(t.id, reason === 'pull' ? 'Unhid settings.json to pull' : 'Unhid settings.json for a team change', [settings]);
    await atomicWrite(t.settingsFile, text, t.root);
  }
  await G.setSkipWorktree(repo, false);
  const blob = await G.indexBlob(repo);
  // effective: what the file shows now, so hiding it again without a commit routes only
  // what was edited since.
  const state: TargetState = { ...s, unhidden: { reason, blob, at: Date.now(), head: await G.head(repo.root) }, written: sha(text), effective: parseBlock(text, t.block), blob };
  const message = kept ? `${short(t, t.settingsFile)} has uncommitted changes outside "settings" (folders, launch, tasks); they stay in the file and Git now shows them. Commit or stash them${reason === 'pull' ? ' before pulling' : ''}.` : undefined;
  return { status: 'unhidden', state, wrote: backup ? [t.settingsFile] : [], routed: first.routed, backup, message };
}

export function hide(t: Target, st: TargetState, ctx: Context, router: Router): Promise<SyncResult> {
  return sync(t, st, ctx, { router, hide: true, reason: 'Hid personal settings again' });
}

/** committed mode: the upstream branch has a different settings file, so a pull would stop on it. */
export async function upstreamChanged(t: Target): Promise<boolean> {
  const repo = await G.locate(t.settingsFile).catch(() => undefined);
  if (!repo) return false;
  return G.upstreamTouches(repo);
}

// ---- Undo ----------------------------------------------------------------------------

/**
 * Puts the files of a backup back, taking a backup of the current ones first. Restoring
 * the backup taken by the setup puts the folder back as it was before it: local settings
 * are off again (undefined), and in committed mode Git sees settings.json again.
 */
export async function restore(t: Target, st: TargetState, entry: BackupEntry, ctx: Context): Promise<TargetState | undefined> {
  // Everything is read before the new backup is taken: taking it can rotate this very
  // entry away (the oldest one, or any with a small backups setting).
  const texts = await Promise.all(entry.files.map((f) => ctx.backups.content(entry, f.path)));
  const states = await Promise.all(entry.files.map((f) => readState(f.path)));
  await ctx.backups.take(t.id, `Before restoring "${entry.reason}"`, states);
  for (const [i, f] of entry.files.entries()) {
    const text = texts[i];
    if (text === undefined) await removeFile(f.path, t.root);
    else await atomicWrite(f.path, text, t.root);
  }
  if (entry.setup || entry.reason.startsWith('Set up (')) {
    if (st.mode === 'committed') await unflag(t);
    return undefined;
  }
  // The restored settings file counts as written, so it isn't taken for an edit; the next
  // merge brings it in line with the restored layers.
  const settings = await readState(t.settingsFile);
  let effective: JsonObject | undefined;
  try {
    effective = settings.exists ? parseBlock(settings.text, t.block) : undefined;
  } catch {
    effective = undefined;
  }
  return { ...st, written: settings.exists ? settings.hash : undefined, effective, local: undefined, shared: undefined };
}

async function unflag(t: Target) {
  const repo = await G.locate(t.settingsFile).catch(() => undefined);
  if (repo && (await G.isSkipWorktree(repo))) await G.setSkipWorktree(repo, false);
}

/**
 * Stops using local settings for a folder: settings.json becomes a plain file again.
 * generated: it keeps what it shows now, without the generated comment; settings.shared.json
 * and settings.local.json stay on disk. committed: Git sees the file again (skip-worktree is
 * cleared), and it either keeps the personal values (`keep: 'mine'`, so they show in git
 * status) or goes back to the commit (`keep: 'commit'`; they stay in the local file).
 */
export async function teardown(t: Target, st: TargetState, ctx: Context, keep: 'mine' | 'commit' = 'mine'): Promise<BackupEntry | undefined> {
  await confineReads(t, [t.settingsFile]);
  const settings = await readState(t.settingsFile);
  let text: string | undefined;
  if (st.mode === 'generated') {
    if (settings.exists) text = dropHeader(settings.text, GENERATED_HEADER);
  } else if (keep === 'commit') {
    const repo = await G.locate(t.settingsFile);
    const baseText = repo && (await G.isTracked(repo)) ? await G.indexText(repo) : undefined;
    if (baseText !== undefined) text = t.block.length && settings.exists ? setBlock(settings.text, t.block, parseBlock(baseText, t.block, `The committed ${short(t, t.settingsFile)}`)) : baseText;
  }
  let backup: BackupEntry | undefined;
  if (text !== undefined && text !== settings.text) {
    backup = await ctx.backups.take(t.id, 'Stopped using local settings', [settings]);
    await atomicWrite(t.settingsFile, text, t.root);
  }
  if (st.mode === 'committed') await unflag(t);
  return backup;
}

// ---- Reading for the overview --------------------------------------------------------

export interface Inspection {
  mode: Mode;
  keys: KeyInfo[];
  /** Settings in the file that don't match the merge (changed outside and not sorted yet). */
  unsorted: string[];
  problem?: { file?: string; message: string };
  unhidden?: TargetState['unhidden'];
  hidden?: boolean;
  tracked?: { settings?: boolean; local?: boolean };
  ignored?: { settings?: boolean; local?: boolean };
  hasLocalFile: boolean;
  hasSharedFile: boolean;
}

export async function inspect(t: Target, st: TargetState, ctx: Context, opts: { git?: boolean } = {}): Promise<Inspection> {
  const mode = st.mode;
  const out: Inspection = { mode, keys: [], unsorted: [], unhidden: st.unhidden, hasLocalFile: false, hasSharedFile: false };
  try {
    const L = await readLayers(t, mode, ctx);
    out.hasLocalFile = L.local.exists;
    out.hasSharedFile = mode === 'generated' ? L.shared.exists : true;
    out.keys = describe(L.base, L.localObj, L.rules);
    if (L.current && !st.unhidden) out.unsorted = changedKeys(merge(L.base, L.localObj, L.rules), L.current);
    if (opts.git !== false && L.repo) out.hidden = await G.isSkipWorktree(L.repo);
  } catch (e) {
    out.problem = { message: (e as Error).message, file: e instanceof SyntaxProblem ? e.file : undefined };
  }
  if (opts.git !== false) {
    try {
      const [rs, rl] = await Promise.all([G.locate(t.settingsFile), G.locate(t.localFile)]);
      if (rs) out.tracked = { settings: await G.isTracked(rs), local: rl ? await G.isTracked(rl) : undefined };
      if (rs) out.ignored = { settings: await G.isIgnored(rs), local: rl ? await G.isIgnored(rl) : undefined };
    } catch (e) {
      if (!(e instanceof G.GitUnavailable)) throw e;
      // A generated settings.json needs no git: only the ignore hints are missing then.
      if (mode === 'committed') out.problem ??= { message: e.message };
    }
  }
  return out;
}

/** The shared layer and the merge, as JSON text, for a diff of what the local file changes. */
export async function overlayDiff(t: Target, st: TargetState, ctx: Context): Promise<{ shared: string; merged: string }> {
  const L = await readLayers(t, st.mode, ctx);
  const sortTop = (o: JsonObject) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  return { shared: JSON.stringify(sortTop(L.base), null, 2) + '\n', merged: JSON.stringify(sortTop(merge(L.base, L.localObj, L.rules)), null, 2) + '\n' };
}
