// Committed mode against real temporary Git repositories: skip-worktree keeps personal
// settings out of git status, upstream changes are noticed, and the unhide flows let a
// pull or a team change through.
import assert from 'node:assert/strict';
import path from 'path';
import { test } from 'node:test';
import { core, folder, git, read, readJson, repo, router, tmp, write } from './helpers.mjs';

const { sync, planInit, commitInit, unhide, hide, upstreamChanged } = core;
const ctx = () => ({ backups: new core.Backups(path.join(tmp('lws-b-'), 'b'), () => 20) });
const status = (dir) => git(dir, 'status', '--porcelain');

async function committed(settings, edit) {
  const r = repo(settings);
  if (edit) write(r.t.settingsFile, edit);
  const c = ctx();
  const plan = await planInit(r.t, 'committed', [], c);
  await commitInit(r.t, plan, c);
  return { ...r, c, plan, st: plan.state };
}

test('setup: uncommitted changes in settings.json become the local file, and git status is clean', async () => {
  const { me, t, plan } = await committed('{\n  // team\n  "editor.tabSize": 2\n}\n', '{\n  // team\n  "editor.tabSize": 2,\n  "peacock.color": "#abcdef"\n}\n');
  assert.deepEqual(plan.files.map((f) => path.basename(f.path)), ['settings.local.json']);
  assert.deepEqual(readJson(t.localFile), { 'peacock.color': '#abcdef' });
  assert.match(read(t.settingsFile), /\/\/ team/);
  assert.match(git(me, 'ls-files', '-v', '.vscode/settings.json'), /^S /);
  assert.equal(status(me), '?? .vscode/settings.local.json\n', 'settings.json is hidden; the local file still needs an ignore rule');
});

test('the local file is applied into settings.json without git noticing', async () => {
  const { me, t, c, st } = await committed({ 'editor.tabSize': 2 });
  write(path.join(me, '.git', 'info', 'exclude'), '.vscode/settings.local.json\n');
  write(t.localFile, { 'editor.tabSize': 4, 'python.defaultInterpreterPath': '/opt/py' });
  const r = await sync(t, st, c, { router: router() });
  assert.equal(r.status, 'ok');
  assert.deepEqual(readJson(t.settingsFile), { 'editor.tabSize': 4, 'python.defaultInterpreterPath': '/opt/py' });
  assert.equal(status(me), '');
  // A change made through the Settings editor goes to the local file.
  write(t.settingsFile, { 'editor.tabSize': 4, 'python.defaultInterpreterPath': '/opt/py', 'peacock.color': '#111111' });
  const r2 = await sync(t, r.state, c, { router: router() });
  assert.deepEqual(r2.routed.map(({ key, to }) => ({ key, to })), [{ key: 'peacock.color', to: 'local' }]);
  assert.equal(readJson(t.localFile)['peacock.color'], '#111111');
  assert.equal(status(me), '');
  assert.deepEqual((await sync(t, r2.state, c, { router: router() })).wrote, [], 'no write loop');
});

test('an upstream change to settings.json is noticed; unhide, pull, and personal settings come back', async () => {
  const { me, t, c, st, commitUp } = await committed({ 'editor.tabSize': 2 });
  write(t.localFile, { 'peacock.color': '#222222' });
  let s = (await sync(t, st, c, { router: router() })).state;
  commitUp('.vscode/settings.json', { 'editor.tabSize': 2, 'editor.rulers': [100] });
  git(me, 'fetch', '-q');
  assert.equal(await upstreamChanged(t), true);
  // Pulling now would stop on the hidden file: that is what unhide is for.
  const u = await unhide(t, s, c, 'pull', router());
  assert.equal(u.status, 'unhidden');
  assert.deepEqual(readJson(t.settingsFile), { 'editor.tabSize': 2 });
  assert.doesNotMatch(git(me, 'ls-files', '-v', '.vscode/settings.json'), /^S /);
  s = u.state;
  // While unhidden, nothing is merged or routed.
  const idle = await sync(t, s, c, { router: router('defer') });
  assert.equal(idle.status, 'unhidden');
  assert.deepEqual(idle.wrote, []);
  git(me, 'pull', '-q', '--ff-only');
  const back = await sync(t, s, c, { router: router('defer') });
  assert.equal(back.status, 'ok');
  assert.equal(back.rehid, true);
  assert.deepEqual(readJson(t.settingsFile), { 'editor.tabSize': 2, 'editor.rulers': [100], 'peacock.color': '#222222' });
  assert.match(git(me, 'ls-files', '-v', '.vscode/settings.json'), /^S /);
  assert.equal(await upstreamChanged(t), false);
});

test('a team change: the file shows the commit plus the change, and personal settings return after it is committed', async () => {
  const { me, t, c, st } = await committed({ 'editor.tabSize': 2 });
  write(path.join(me, '.git', 'info', 'exclude'), '.vscode/settings.local.json\n');
  write(t.localFile, { 'peacock.color': '#333333', 'editor.formatOnSave': true });
  let s = (await sync(t, st, c, { router: router() })).state;
  const r = await sync(t, s, c, { router: router(), edit: [{ op: 'toShared', key: 'editor.formatOnSave' }] });
  assert.equal(r.status, 'unhidden');
  assert.deepEqual(readJson(t.settingsFile), { 'editor.tabSize': 2, 'editor.formatOnSave': true });
  assert.deepEqual(readJson(t.localFile), { 'peacock.color': '#333333' });
  assert.equal(status(me), ' M .vscode/settings.json\n');
  git(me, 'commit', '-qam', 'format on save');
  const back = await sync(t, r.state, c, { router: router('defer') });
  assert.equal(back.rehid, true);
  assert.deepEqual(readJson(t.settingsFile), { 'editor.tabSize': 2, 'editor.formatOnSave': true, 'peacock.color': '#333333' });
  assert.equal(status(me), '');
});

test('hiding again by hand sorts what changed while the file was unhidden', async () => {
  const { t, c, st } = await committed({ a: 1 });
  const u = await unhide(t, st, c, 'team', router());
  write(t.settingsFile, { a: 1, mine: true });
  const asked = router('local');
  const r = await hide(t, u.state, c, asked);
  assert.deepEqual(asked.asked.map((x) => x.key), ['mine']);
  assert.deepEqual(readJson(t.localFile), { mine: true });
  assert.equal(r.status, 'ok');
});

test('a checkout that replaces the file is not mistaken for a personal edit', async () => {
  const { me, t, c, st, commitUp } = await committed({ a: 1 });
  commitUp('.vscode/settings.json', { a: 2 });
  git(me, 'fetch', '-q');
  // As if git had replaced the file and the index (here: by hand, flag cleared first).
  git(me, 'update-index', '--no-skip-worktree', '.vscode/settings.json');
  git(me, 'reset', '-q', '--hard', 'origin/main');
  const asked = router();
  const r = await sync(t, st, c, { router: asked });
  assert.equal(asked.asked.length, 0);
  assert.deepEqual(readJson(t.settingsFile), { a: 2 });
  assert.equal(r.status, 'ok');
});

test('committed mode needs a committed file', async () => {
  const f = folder({ 'settings.json': { a: 1 } });
  await assert.rejects(planInit(f.t, 'committed', [], f.ctx), /not committed to Git/);
  const r = await sync(f.t, { mode: 'committed' }, f.ctx, { router: router() });
  assert.equal(r.status, 'error');
});

test('a .code-workspace file: overrides go into its settings block, folders and comments stay', async () => {
  const dir = tmp('lws-ws-');
  git(dir, 'init', '-q', '-b', 'main');
  const file = path.join(dir, 'team.code-workspace');
  write(file, '{\n  // our folders\n  "folders": [{ "path": "a" }, { "path": "b" }],\n  "settings": {\n    "editor.tabSize": 2\n  }\n}\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'ws');
  const t = core.workspaceTarget(file);
  assert.equal(path.basename(t.localFile), 'team.code-workspace.local.json');
  const c = ctx();
  const plan = await planInit(t, 'committed', [], c);
  await commitInit(t, plan, c);
  write(t.localFile, { 'window.zoomLevel': 1 });
  const r = await sync(t, plan.state, c, { router: router() });
  assert.equal(r.status, 'ok');
  const text = read(file);
  assert.match(text, /\/\/ our folders/);
  assert.deepEqual(core.parseObject(text), { folders: [{ path: 'a' }, { path: 'b' }], settings: { 'editor.tabSize': 2, 'window.zoomLevel': 1 } });
  assert.equal(git(dir, 'status', '--porcelain'), '?? team.code-workspace.local.json\n');
  await assert.rejects(planInit(t, 'generated', [], c), /workspace file/);
});

test('ignore rules: added once, under a comment, keeping line endings', () => {
  assert.equal(core.git.withIgnoreLines('node_modules\n', ['.vscode/settings.json', '.vscode/settings.local.json'], 'Local Workspace Settings'), 'node_modules\n\n# Local Workspace Settings\n.vscode/settings.json\n.vscode/settings.local.json\n');
  const once = core.git.withIgnoreLines('a\r\nb', ['x'], 'c');
  assert.equal(once, 'a\r\nb\r\n\r\n# c\r\nx\r\n');
  assert.equal(core.git.withIgnoreLines(once, ['x'], 'c'), once);
  assert.equal(core.git.withIgnoreLines('', ['x'], 'c'), '# c\nx\n');
});

test('tracked and ignored status', async () => {
  const { me, t } = repo({ a: 1 });
  const s = await core.git.locate(t.settingsFile);
  const l = await core.git.locate(t.localFile);
  assert.equal(await core.git.isTracked(s), true);
  assert.equal(await core.git.isIgnored(l), false);
  write(path.join(me, '.gitignore'), '.vscode/settings.local.json\n');
  assert.equal(await core.git.isIgnored(l), true);
  await core.git.untrack(s);
  assert.equal(await core.git.isTracked(s), false);
  assert.equal(readJson(t.settingsFile).a, 1, 'untracking keeps the file');
  assert.equal(await core.git.locate(path.join(tmp(), 'x', 'settings.json')), undefined);
});

test('sharing a Settings-editor change drops the local override, so the shared value stays after the commit', async () => {
  const { me, t, c, st } = await committed({ 'editor.fontSize': 12 });
  write(path.join(me, '.git', 'info', 'exclude'), '.vscode/settings.local.json\n');
  write(t.localFile, { 'editor.fontSize': 14 });
  const s = (await sync(t, st, c, { router: router() })).state;
  write(t.settingsFile, { 'editor.fontSize': 16 });
  const r = await sync(t, s, c, { router: router('shared') });
  assert.equal(r.status, 'unhidden');
  assert.deepEqual(readJson(t.settingsFile), { 'editor.fontSize': 16 });
  assert.deepEqual(readJson(t.localFile), {});
  git(me, 'commit', '-qam', 'font');
  const back = await sync(t, r.state, c, { router: router('defer') });
  assert.equal(back.rehid, true);
  assert.deepEqual(readJson(t.settingsFile), { 'editor.fontSize': 16 });
});

test('setup in committed mode keeps an existing settings.local.json', async () => {
  const r = repo({ 'editor.tabSize': 2 });
  write(r.t.localFile, '// mine\n{ "peacock.color": "#ff0000", "editor.tabSize": 4 }\n');
  const c = ctx();
  const plan = await planInit(r.t, 'committed', [], c);
  assert.deepEqual(plan.personal.sort(), ['editor.tabSize', 'peacock.color']);
  assert.ok(!plan.files.some((f) => f.path === r.t.localFile), 'the local file is not rewritten');
  await commitInit(r.t, plan, c);
  assert.deepEqual(readJson(r.t.settingsFile), { 'editor.tabSize': 4, 'peacock.color': '#ff0000' });
});

test('a .code-workspace file: a team change and unhiding keep uncommitted folders', async () => {
  const dir = tmp('lws-ws-');
  git(dir, 'init', '-q', '-b', 'main');
  const file = path.join(dir, 'p.code-workspace');
  write(file, { folders: [{ path: '.' }], settings: { 'editor.tabSize': 2 } });
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'ws');
  const t = core.workspaceTarget(file);
  const c = ctx();
  const plan = await planInit(t, 'committed', [], c);
  await commitInit(t, plan, c);
  write(file, { folders: [{ path: '.' }, { path: '../other' }], settings: { 'editor.tabSize': 4 } });
  const r = await sync(t, plan.state, c, { router: router('shared') });
  assert.equal(r.status, 'unhidden');
  assert.deepEqual(core.parseObject(read(file)), { folders: [{ path: '.' }, { path: '../other' }], settings: { 'editor.tabSize': 4 } });
  assert.match(r.message, /changes outside "settings".*show in Git now too/, 'the uncommitted folder is pointed out before the commit');
  // Committing only the settings block (the folder stays uncommitted) hides the file again.
  const staged = path.join(tmp(), 'p.code-workspace');
  write(staged, { folders: [{ path: '.' }], settings: { 'editor.tabSize': 4 } });
  const blob = git(dir, 'hash-object', '-w', staged).trim();
  git(dir, 'update-index', '--cacheinfo', `100644,${blob},p.code-workspace`);
  git(dir, 'commit', '-qm', 'tab size');
  const back = await sync(t, r.state, c, { router: router('defer') });
  assert.equal(back.status, 'ok');
  assert.equal(back.rehid, true);
  assert.deepEqual(core.parseObject(read(file)).folders, [{ path: '.' }, { path: '../other' }]);
  assert.match(git(dir, 'ls-files', '-v', 'p.code-workspace'), /^S /);
  assert.match(back.notice, /uncommitted changes outside "settings".*doesn't show them/, 'hiding the uncommitted folder is pointed out');
});

test('committed setup of a workspace file with uncommitted folders says Git will stop showing them', async () => {
  const dir = tmp('lws-ws-');
  git(dir, 'init', '-q', '-b', 'main');
  const file = path.join(dir, 'p.code-workspace');
  write(file, { folders: [{ path: '.' }], settings: { 'editor.tabSize': 2 } });
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'ws');
  const t = core.workspaceTarget(file);
  assert.equal((await planInit(t, 'committed', [], ctx())).note, undefined);
  write(file, { folders: [{ path: '.' }, { path: '../other' }], settings: { 'editor.tabSize': 2 } });
  assert.match((await planInit(t, 'committed', [], ctx())).note, /outside "settings"/);
});

test('a commit of ones own that is not pushed yet is not an upstream change; an upstream delete is', async () => {
  const { me, t, c, st, commitUp } = await committed({ 'editor.tabSize': 2 });
  write(t.settingsFile, { 'editor.tabSize': 4 });
  const r = await sync(t, st, c, { router: router('shared') });
  assert.equal(r.status, 'unhidden');
  git(me, 'commit', '-qam', 'tab size');
  const back = await sync(t, r.state, c, { router: router() });
  assert.equal(back.rehid, true);
  assert.equal(await upstreamChanged(t), false, 'nothing to pull: the commit is only not pushed');
  const upDir = path.join(path.dirname(me), 'up');
  git(upDir, 'pull', '-q', me, 'main');
  commitUp('.vscode/settings.shared.json', { 'editor.tabSize': 4 });
  git(me, 'fetch', '-q');
  assert.equal(await upstreamChanged(t), false, 'upstream changes to other files are not reported');
  git(upDir, 'rm', '-q', '.vscode/settings.json');
  git(upDir, 'commit', '-qm', 'generated now');
  git(me, 'fetch', '-q');
  assert.equal(await upstreamChanged(t), true, 'the team deleted settings.json upstream');
});

test('unhidden to pull, pulled, and the pull did not touch the file: personal settings come back', async () => {
  const { me, t, c, st, commitUp } = await committed({ 'editor.tabSize': 2 });
  write(t.localFile, { 'peacock.color': '#222222' });
  const s = (await sync(t, st, c, { router: router() })).state;
  commitUp('README.md', '# changed\n');
  const u = await unhide(t, s, c, 'pull', router());
  assert.equal(u.status, 'unhidden');
  git(me, 'pull', '-q');
  const back = await sync(t, u.state, c, { router: router() });
  assert.equal(back.status, 'ok');
  assert.equal(back.rehid, true);
  assert.equal(readJson(t.settingsFile)['peacock.color'], '#222222');
});

test('hiding again after moving a shared setting to the local file keeps its value', async () => {
  const { t, c, st } = await committed({ 'editor.tabSize': 2, 'files.trimTrailingWhitespace': true });
  const r = await sync(t, st, c, { router: router(), edit: [{ op: 'toLocal', key: 'editor.tabSize' }] });
  assert.equal(r.status, 'unhidden');
  const asked = router();
  const h = await hide(t, r.state, c, asked);
  assert.equal(h.status, 'ok');
  assert.equal(asked.asked.length, 0);
  assert.equal(readJson(t.localFile)['editor.tabSize'], 2, 'not null');
  assert.equal(readJson(t.settingsFile)['editor.tabSize'], 2);
});

test('hiding again after sharing a personal setting keeps it, for this user', async () => {
  const { t, c, st } = await committed({ 'editor.tabSize': 2 });
  write(t.localFile, { 'editor.rulers': [80] });
  const s = (await sync(t, st, c, { router: router() })).state;
  const r = await sync(t, s, c, { router: router(), edit: [{ op: 'toShared', key: 'editor.rulers' }] });
  assert.equal(r.status, 'unhidden');
  assert.deepEqual(readJson(t.settingsFile), { 'editor.tabSize': 2, 'editor.rulers': [80] });
  await hide(t, r.state, c, router('defer'));
  assert.deepEqual(readJson(t.localFile), { 'editor.rulers': [80] });
  assert.deepEqual(readJson(t.settingsFile), { 'editor.tabSize': 2, 'editor.rulers': [80] });
});

test('undoing a committed setup puts settings.json back and lets Git see it again', async () => {
  const { me, t, c, st } = await committed('{ "editor.tabSize": 2 }\n', '{ "editor.tabSize": 2, "peacock.color": "#abcdef" }\n');
  const [entry] = await c.backups.list(t.id);
  assert.equal(entry.setup, 'committed');
  const back = await core.restore(t, st, entry, c);
  assert.equal(back, undefined, 'local settings are off again');
  assert.deepEqual(readJson(t.settingsFile), { 'editor.tabSize': 2, 'peacock.color': '#abcdef' });
  assert.doesNotMatch(git(me, 'ls-files', '-v', '.vscode/settings.json'), /^S /);
  assert.match(status(me), /^ M \.vscode\/settings\.json/m);
});

test('stopping committed mode: keep the personal values, or go back to the commit', async () => {
  for (const keep of ['mine', 'commit']) {
    const { me, t, c, st } = await committed({ 'editor.tabSize': 2 });
    write(t.localFile, { 'peacock.color': '#123456' });
    const s = (await sync(t, st, c, { router: router() })).state;
    await core.teardown(t, s, c, keep);
    assert.doesNotMatch(git(me, 'ls-files', '-v', '.vscode/settings.json'), /^S /);
    assert.deepEqual(readJson(t.settingsFile), keep === 'mine' ? { 'editor.tabSize': 2, 'peacock.color': '#123456' } : { 'editor.tabSize': 2 });
    assert.deepEqual(readJson(t.localFile), { 'peacock.color': '#123456' });
  }
});

test('generated mode: a checkout that commits settings.json is left alone', async () => {
  // A branch from before the switch: settings.json is committed there, settings.shared.json isn't.
  const { me, t } = repo({ 'editor.tabSize': 2 });
  const c = ctx();
  git(me, 'checkout', '-q', '-b', 'migrated');
  write(t.settingsFile, { 'editor.tabSize': 2, 'peacock.color': '#f00' });
  const p2 = await planInit(t, 'generated', ['peacock.color'], c);
  await commitInit(t, p2, c);
  git(me, 'rm', '-q', '--cached', '.vscode/settings.json');
  write(path.join(me, '.gitignore'), '/.vscode/settings.json\n/.vscode/settings.local.json\n');
  git(me, 'add', '.');
  git(me, 'commit', '-qm', 'generated');
  let s = (await sync(t, p2.state, c, { router: router() })).state;
  git(me, 'checkout', '-q', 'main');
  assert.deepEqual(readJson(t.settingsFile), { 'editor.tabSize': 2 });
  const r = await sync(t, s, c, { router: router() });
  assert.equal(r.status, 'error');
  assert.match(r.message, /settings\.shared\.json is missing/);
  assert.deepEqual(r.wrote, []);
  assert.doesNotMatch(status(me), / \.vscode\/settings\.json/, 'the committed settings.json is not touched');
  assert.deepEqual(readJson(t.localFile), { 'peacock.color': '#f00' }, 'the personal setting stays');
  // Back on the branch, merging resumes.
  git(me, 'checkout', '-q', 'migrated');
  const again = await sync(t, s, c, { router: router() });
  assert.equal(again.status, 'ok');
  assert.deepEqual(readJson(t.settingsFile), { 'editor.tabSize': 2, 'peacock.color': '#f00' });
  // A settings.shared.json next to a committed, unchanged settings.json: also left alone.
  s = again.state;
  git(me, 'checkout', '-q', 'main');
  write(t.sharedFile, { 'editor.tabSize': 2 });
  const mixed = await sync(t, s, c, { router: router() });
  assert.equal(mixed.status, 'error');
  assert.match(mixed.message, /committed to Git in this checkout/);
  assert.doesNotMatch(status(me), / \.vscode\/settings\.json/);
});

test('unhiding a .code-workspace file to pull keeps its uncommitted folders and says so', async () => {
  const dir = tmp('lws-ws-');
  git(dir, 'init', '-q', '-b', 'main');
  const file = path.join(dir, 'p.code-workspace');
  write(file, { folders: [{ path: '.' }], settings: { 'editor.tabSize': 2 } });
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'ws');
  const t = core.workspaceTarget(file);
  const c = ctx();
  const plan = await planInit(t, 'committed', [], c);
  await commitInit(t, plan, c);
  write(file, { folders: [{ path: '.' }, { path: '../other' }], settings: { 'editor.tabSize': 2, 'peacock.color': '#f00' } });
  const s = (await sync(t, plan.state, c, { router: router() })).state;
  const u = await unhide(t, s, c, 'pull', router());
  assert.equal(u.status, 'unhidden');
  assert.deepEqual(core.parseObject(read(file)), { folders: [{ path: '.' }, { path: '../other' }], settings: { 'editor.tabSize': 2 } });
  assert.match(u.message, /uncommitted changes outside "settings"/);
});

test('ignore rules escape pattern characters, and a .gitignore link is refused', async () => {
  assert.equal(core.git.ignorePattern('app[1]/.vscode/settings.local.json'), '/app\\[1\\]/.vscode/settings.local.json');
  assert.equal(core.git.ignorePattern('a*b?/x '), '/a\\*b\\?/x\\ ');
  const { me } = repo({ a: 1 });
  const sub = path.join(me, 'app[1]', '.vscode');
  write(path.join(sub, 'settings.local.json'), '{}');
  const l = await core.git.locate(path.join(sub, 'settings.local.json'));
  await core.git.addIgnoreRules(path.join(me, '.gitignore'), [core.git.ignorePattern(l.rel)], 'c', me);
  assert.equal(await core.git.isIgnored(l), true);
  // A committed .gitignore that is a link to a file outside the repository.
  const outside = path.join(tmp(), 'secret.txt');
  write(outside, 'aws_secret=SECRET123\n');
  const { me: me2 } = repo({ a: 1 });
  const { symlinkSync, lstatSync } = await import('fs');
  symlinkSync(outside, path.join(me2, '.gitignore'));
  await assert.rejects(core.git.addIgnoreRules(path.join(me2, '.gitignore'), ['/x'], 'c', me2), /symbolic link/);
  assert.ok(lstatSync(path.join(me2, '.gitignore')).isSymbolicLink());
  assert.equal(read(outside), 'aws_secret=SECRET123\n');
});

test('without a runnable git, committed mode says git is missing instead of "not committed"', async () => {
  const { t } = repo({ a: 1 });
  core.git.setGitBinary('/nonexistent/git');
  try {
    await assert.rejects(core.git.locate(t.settingsFile), (e) => e instanceof core.git.GitUnavailable);
    const r = await sync(t, { mode: 'committed' }, ctx(), { router: router() });
    assert.equal(r.status, 'error');
    assert.match(r.message, /Git could not be run/);
  } finally {
    core.git.setGitBinary(undefined);
  }
});
