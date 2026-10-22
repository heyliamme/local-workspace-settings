// End-to-end: installs the packaged extension into a throwaway VS Code profile and uses it
// as a person would, in three windows:
//
// A. one folder, a Git repository whose settings.json is committed: setup in generated
//    mode with its preview, the ignore rules, editing the local file, a setting changed
//    in the Settings editor, the overview and its moves, a malformed file, undo, the light
//    theme, Reload Window;
// B. a multi-root workspace: a folder whose team already uses settings.shared.json, and a
//    clone set up in committed mode (skip-worktree), with an upstream change, unhide, pull
//    and a team change;
// C. Restricted Mode.
//
// Everything happens in a temporary folder; Git never reads the real user's configuration.
// Linux, with `code` on PATH.
//
//   npm run package && node test/e2e/run.mjs [local-workspace-settings-x.y.z.vsix]
//   E2E_SHOTS=images node test/e2e/run.mjs   # also writes the README screenshots there
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { VSCode, waitFor } from './vscode.mjs';

const core = createRequire(import.meta.url)('../../dist/core.js');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const vsix = path.resolve(process.argv[2] || `${pkg.name}-${pkg.version}.vsix`);
if (!existsSync(vsix)) throw new Error(`${vsix} not found: run npm run package first`);
const shotsFor = process.env.E2E_SHOTS ? path.resolve(process.env.E2E_SHOTS) : undefined;

const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'lws-e2e-')));
const out = path.join(root, 'shots');
mkdirSync(out);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.com' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
const write = (f, v) => (mkdirSync(path.dirname(f), { recursive: true }), writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 2) + '\n'));
const read = (f) => readFileSync(f, 'utf8');
const readJson = (f) => core.parseObject(read(f));

// ---- The folders ----------------------------------------------------------------------
// A: a project with a committed settings.json that mixes team and personal settings.
const A = path.join(root, 'webapp');
mkdirSync(A);
git(A, 'init', '-q', '-b', 'main');
write(path.join(A, 'README.md'), '# webapp\n');
write(
  path.join(A, '.vscode', 'settings.json'),
  `{
    // Formatting the team agreed on
    "editor.tabSize": 2,
    "editor.formatOnSave": true,
    "files.exclude": {
        "**/dist": true,
        "**/.cache": true
    },
    "typescript.tsdk": "node_modules/typescript/lib",
    "eslint.workingDirectories": ["./web", "./api"],
    "peacock.color": "#d4532f",
    "python.defaultInterpreterPath": "/home/sam/.venvs/webapp/bin/python",
    "window.zoomLevel": 1
}
`,
);
git(A, 'add', '.');
git(A, 'commit', '-qm', 'init');
const At = core.folderTarget(A);

// B: a multi-root workspace.
const B = path.join(root, 'platform');
const app2 = path.join(B, 'frontend');
write(path.join(app2, '.vscode', 'settings.shared.json'), { 'editor.tabSize': 4, 'files.trimTrailingWhitespace': true });
write(path.join(app2, '.vscode', 'settings.local.json'), { 'editor.fontSize': 15 });
const upstream = path.join(B, 'upstream-svc');
mkdirSync(upstream, { recursive: true });
git(upstream, 'init', '-q', '-b', 'main');
write(path.join(upstream, '.vscode', 'settings.json'), '{\n  // Team settings for the service\n  "editor.tabSize": 4,\n  "go.lintTool": "golangci-lint"\n}\n');
git(upstream, 'add', '.');
git(upstream, 'commit', '-qm', 'init');
const svc = path.join(B, 'service');
git(B, 'clone', '-q', upstream, svc);
// A personal tweak, never committed.
write(path.join(svc, '.vscode', 'settings.json'), '{\n  // Team settings for the service\n  "editor.tabSize": 4,\n  "go.lintTool": "golangci-lint",\n  "go.goroot": "/home/sam/sdk/go1.24"\n}\n');
const Bws = path.join(B, 'platform.code-workspace');
write(Bws, { folders: [{ path: 'frontend' }, { path: 'service' }], settings: {} });
const app2t = core.folderTarget(app2);
const svct = core.folderTarget(svc);

const settings = {
  'security.workspace.trust.enabled': false,
  'workbench.startupEditor': 'none',
  'workbench.colorTheme': 'Default Dark Modern',
  'window.restoreWindows': 'none',
  'extensions.autoUpdate': false,
  'extensions.ignoreRecommendations': true,
  'telemetry.telemetryLevel': 'off',
  'chat.disableAIFeatures': true,
  'window.dialogStyle': 'custom',
  'files.simpleDialog.enable': true,
  'workbench.tips.enabled': false,
  'editor.minimap.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'window.menuStyle': 'custom',
  'git.enabled': false,
  'git.autofetch': false,
  'workbench.welcomePage.walkthroughs.openOnInstall': false,
};
let vs = new VSCode(root);
vs.install(vsix, settings);

let passed = 0;
const failed = [];
async function step(name, fn) {
  const t = Date.now();
  try {
    if (await vs.quickInputVisible().catch(() => false)) await vs.key('Escape');
    await fn();
    passed++;
    console.log(`  ✓ ${name} (${Date.now() - t} ms)`);
  } catch (e) {
    failed.push(name);
    const file = path.join(out, `${failed.length}-${name.replace(/\W+/g, '-').slice(0, 80)}.png`);
    await vs.screenshot(file).catch(() => {});
    console.log(`  ✗ ${name}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 4).join('\n      ')}\n      screenshot: ${file}`);
  }
}
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

let ctx;
const w = (expr) => vs.eval(expr, ctx);
const until = (expr, what, timeout) => waitFor(() => w(expr), { what, timeout });
const W = {
  click: (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('not found: ' + ${JSON.stringify(sel)}); e.click(); return true; })()`,
  text: (sel) => `document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`,
  rows: `[...document.querySelectorAll('#keys tbody tr[data-key]')].map((r) => [r.dataset.key, r.dataset.origin])`,
  act: (op, key) => `(() => { const b = document.querySelector('button[data-op="${op}"][data-key=${JSON.stringify(key)}]'); if (!b) throw new Error('no ${op} button for ' + ${JSON.stringify(key)}); b.click(); return true; })()`,
};

async function focusWorkbench() {
  await vs.clickElement(`document.querySelector('.part.statusbar')`);
}
async function shotOfEditor(file) {
  // The window can be zoomed (window.zoomLevel is one of the test's personal settings):
  // the clip is in device pixels of the 1600 px wide viewport.
  const r = await vs.eval(`(() => { const z = 1600 / innerWidth; const b = document.querySelector('.part.editor').getBoundingClientRect(); return { x: b.x * z, y: b.y * z, width: b.width * z, height: b.height * z }; })()`);
  const { data } = await vs.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } });
  writeFileSync(file, Buffer.from(data, 'base64'));
}
async function closeAll() {
  await vs.command('View: Close All Editors');
  await waitFor(async () => (await vs.editorTabs()).length === 0, { what: 'editors to close' });
}
/** Runs a command that opens a quick pick or input of its own: doesn't wait for it to close. */
async function paletteRun(title) {
  if (await vs.quickInputVisible()) await vs.key('Escape');
  await waitFor(async () => !(await vs.quickInputVisible()), { what: 'quick input to close' });
  await vs.key('F1');
  await waitFor(async () => (await vs.quickInputVisible()) && (await vs.quickInputValue()).startsWith('>'), { what: 'command palette' });
  await vs.type(title);
  await sleep(500);
  await vs.key('Enter');
  await sleep(600);
}
/** Runs a palette command chosen by its exact label (Enter could pick a better-ranked neighbour). */
async function paletteExact(search, label) {
  if (await vs.quickInputVisible()) await vs.key('Escape');
  await vs.key('F1');
  await waitFor(async () => (await vs.quickInputVisible()) && (await vs.quickInputValue()).startsWith('>'), { what: 'command palette' });
  await vs.type(search);
  await sleep(500);
  const found = await waitFor(
    () => vs.eval(`(() => { const re = new RegExp(${JSON.stringify(label)}); const row = [...document.querySelectorAll('.quick-input-widget .monaco-list-row')].find((r) => re.test((r.querySelector('.label-name') ?? r).textContent.trim())); if (!row) return false; row.click(); return true; })()`),
    { what: `palette item ${label}`, timeout: 4000 },
  ).catch(() => false);
  if (!found) await vs.key('Escape');
  await sleep(500);
  return found;
}
async function hideAuxBar() {
  const open = await vs.eval(`(() => { const p = document.querySelector('.part.auxiliarybar'); return !!p && p.offsetWidth > 0; })()`);
  if (open) await paletteExact('Secondary Side Bar', '^View: (Close|Hide|Toggle) Secondary Side Bar');
}
async function notification(text, timeout = 10000) {
  return waitFor(async () => (await vs.notifications()).find((n) => n.includes(text)), { what: `notification "${text}"`, timeout });
}
const statusItem = `[...document.querySelectorAll('.statusbar-item')].find((e) => (e.querySelector('a')?.getAttribute('aria-label') || e.getAttribute('aria-label') || '').startsWith('Local workspace settings'))`;
async function statusText() {
  return vs.eval(`(() => { const e = ${statusItem}; return e ? e.textContent.trim() : null; })()`);
}
async function openOverview() {
  await vs.command('Local Workspace Settings: Show Settings Overview');
  ctx = await vs.webview();
}
async function pickedItems() {
  return vs.eval(`[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].map((r) => [(r.querySelector('.label-name') ?? r).textContent.trim(), r.querySelector('input[type=checkbox]')?.checked ?? r.getAttribute('aria-checked') === 'true'])`);
}
const storage = () => path.join(root, 'user-data', 'User', 'globalStorage', 'heyliam.local-workspace-settings');

try {
  // ===================================================================================
  console.log('Window A: one folder, generated mode');
  await vs.launch(A);
  await sleep(2000);

  await step('before setup: no status bar item, and the overview offers setup', async () => {
    await vs.command('View: Close Primary Side Bar');
    eq(await statusText(), null, 'status bar');
    await openOverview();
    await until(`!!document.getElementById('setup')`, 'setup button');
    ok((await w(W.text('.setup'))).includes('Generated settings.json'), 'explains the modes');
  });

  await step('setup in generated mode: personal settings are suggested, and every file is previewed', async () => {
    await w(W.click('#setup'));
    await vs.pickQuickItem('Generated settings.json');
    await waitFor(async () => (await pickedItems()).length === 8, { what: 'personal settings list' });
    const items = await pickedItems();
    const picked = items.filter(([, c]) => c).map(([l]) => l);
    eq(picked.sort(), ['peacock.color', 'python.defaultInterpreterPath', 'window.zoomLevel'], 'suggested personal settings');
    // Accept the suggestion.
    await vs.key('Enter');
    await notification('Set up webapp: write 3 files');
    await waitFor(async () => (await vs.editorTabs()).some((t) => t.startsWith('Set up webapp')), { what: 'preview tab' });
    await sleep(1500);
    if (shotsFor) await shotOfEditor(path.join(shotsFor, 'setup-preview-dark.png'));
    await vs.dialogButton('Set Up');
    await waitFor(() => existsSync(At.sharedFile), { what: 'settings.shared.json' });
    await vs.pickQuickItem('Add to .gitignore');
    await vs.dialogButton('Stop Tracking settings.json');
    await waitFor(() => !git(A, 'ls-files').includes('.vscode/settings.json'), { what: 'settings.json untracked' });
    const shared = readJson(At.sharedFile);
    eq(Object.keys(shared), ['editor.tabSize', 'editor.formatOnSave', 'files.exclude', 'typescript.tsdk', 'eslint.workingDirectories'], 'shared keys');
    ok(read(At.sharedFile).includes('// Formatting the team agreed on'), 'comment kept in the shared file');
    eq(readJson(At.localFile), { 'peacock.color': '#d4532f', 'python.defaultInterpreterPath': '/home/sam/.venvs/webapp/bin/python', 'window.zoomLevel': 1 }, 'local');
    ok(read(At.settingsFile).startsWith('// Generated by Local Workspace Settings'), 'generated header');
    ok(read(path.join(A, '.gitignore')).includes('/.vscode/settings.json\n/.vscode/settings.local.json\n'), '.gitignore');
    eq(git(A, 'status', '--porcelain', '-uall').split('\n').filter(Boolean).sort(), ['?? .gitignore', '?? .vscode/settings.shared.json', 'D  .vscode/settings.json'], 'git status');
    eq((await vs.editorTabs()).filter((t) => t.startsWith('Set up')), [], 'preview closed');
  });

  await step('the status bar shows the mode', async () => {
    await waitFor(async () => (await statusText()) === 'Local settings: generated', { what: 'status bar' });
  });

  await step('Set Up again says the folder is already set up instead of looping', async () => {
    await vs.clearNotifications();
    await paletteRun('Local Workspace Settings: Set Up in This Workspace');
    await notification('webapp is already set up');
    ok(!(await vs.notifications()).some((n) => n.includes('not set up in this workspace yet')), 'no "not set up" loop');
    await vs.clearNotifications();
  });

  await step('the layer files open as JSON with comments: no errors for their header comments', async () => {
    await closeAll();
    await vs.command('Local Workspace Settings: Open Local Settings');
    await waitFor(async () => (await vs.editorTabs()).some((t) => t.includes('settings.local.json')), { what: 'local file open' });
    await waitFor(() => vs.eval(`(document.querySelector('[id="status.editor.mode"]')?.textContent ?? '').includes('JSON with Comments')`), { what: 'jsonc language mode' });
    await sleep(2000);
    const counts = await vs.eval(`(document.querySelector('[id="status.problems"]')?.textContent ?? '').match(/\\d+/g)`);
    ok(counts && Number(counts[0]) === 0, `errors in the Problems count: ${JSON.stringify(counts)}`);
    await closeAll();
  });

  await step('editing settings.local.json (even outside VS Code) updates settings.json', async () => {
    const text = read(At.localFile).replace('"window.zoomLevel": 1', '"window.zoomLevel": 1,\n    "editor.tabSize": 4,\n    "files.exclude": { "**/coverage": true }');
    writeFileSync(At.localFile, text);
    await waitFor(() => readJson(At.settingsFile)['editor.tabSize'] === 4, { what: 'merged tabSize' });
    eq(readJson(At.settingsFile)['files.exclude'], { '**/dist': true, '**/.cache': true, '**/coverage': true }, 'objects merge key by key');
  });

  await step('a setting changed in the Settings editor is saved to settings.local.json', async () => {
    await closeAll();
    await vs.command('Preferences: Open Workspace Settings');
    await waitFor(() => vs.eval(`!!document.querySelector('.settings-editor .suggest-input-container')`), { what: 'settings editor' });
    await sleep(800);
    await vs.type('editor.wordWrap');
    const sel = `document.querySelector('.settings-editor select[aria-label="editor.wordWrap"]')`;
    await waitFor(() => vs.eval(`!!${sel}`), { what: 'word wrap setting', timeout: 15000 });
    await sleep(500);
    await vs.eval(`(() => { const s = ${sel}; s.focus(); s.value = 'on'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await waitFor(() => readJson(At.localFile)['editor.wordWrap'] === 'on', { what: 'routed to local', timeout: 15000 });
    await notification('editor.wordWrap was saved to .vscode/settings.local.json');
    ok(!('editor.wordWrap' in readJson(At.sharedFile)), 'not in shared');
    await vs.key('Escape');
    await sleep(300);
    eq(readJson(At.settingsFile)['editor.wordWrap'], 'on', 'effective');
    await vs.clearNotifications();
  });

  await step('the overview lists every setting with its origin', async () => {
    await closeAll();
    await openOverview();
    await until(`document.querySelectorAll('#keys tbody tr[data-key]').length === 9`, 'nine rows');
    const rows = Object.fromEntries(await w(W.rows));
    eq([rows['editor.tabSize'], rows['files.exclude'], rows['peacock.color'], rows['typescript.tsdk']], ['overridden', 'overridden', 'local', 'shared'], 'origins');
    ok((await w(W.text('#status'))).includes('In sync'), 'in sync');
    if (shotsFor) {
      await vs.clearNotifications();
      await hideAuxBar();
      await vs.showTab('Workspace Settings');
      await focusWorkbench();
      await sleep(600);
      await shotOfEditor(path.join(shotsFor, 'overview-dark.png'));
    }
  });

  await step('move a setting to shared, and one to local, from the overview', async () => {
    await w(W.act('toShared', 'editor.wordWrap'));
    await waitFor(() => readJson(At.sharedFile)['editor.wordWrap'] === 'on' && !('editor.wordWrap' in readJson(At.localFile)), { what: 'moved to shared' });
    await w(W.act('toLocal', 'typescript.tsdk'));
    await waitFor(() => readJson(At.localFile)['typescript.tsdk'] === 'node_modules/typescript/lib' && !('typescript.tsdk' in readJson(At.sharedFile)), { what: 'moved to local' });
    // From the keyboard: focus stays on the row after the page is rebuilt.
    await w(`(() => { window.focus(); const b = document.querySelector('button[data-op="removeOverride"][data-key="editor.tabSize"]'); b.focus(); b.click(); return true; })()`);
    await waitFor(() => readJson(At.settingsFile)['editor.tabSize'] === 2, { what: 'override removed' });
    await until(`document.querySelector('tr[data-key="editor.tabSize"]')?.dataset.origin === 'shared'`, 'row updated');
    await until(`document.activeElement?.closest('tr')?.dataset.key === 'editor.tabSize'`, 'focus kept on the row');
    await focusWorkbench();
  });

  await step('a malformed local file is refused: nothing written, the status bar and overview say why', async () => {
    const before = read(At.settingsFile);
    const good = read(At.localFile);
    writeFileSync(At.localFile, good.replace(/\}\s*$/, ',, }'));
    await waitFor(async () => (await statusText())?.includes('Local settings') && (await vs.eval(`(${statusItem})?.querySelector('.codicon-error') !== null`)), { what: 'error in the status bar' });
    await notification("settings.local.json can't be read");
    await until(`!!document.getElementById('problem')`, 'problem banner');
    eq(read(At.settingsFile), before, 'settings.json untouched');
    writeFileSync(At.localFile, good);
    await waitFor(async () => (await statusText()) === 'Local settings: generated', { what: 'recovered' });
    await vs.clearNotifications();
  });

  await step('Undo Last Change puts the files back', async () => {
    eq(readJson(At.settingsFile)['editor.tabSize'], 2, 'before undo');
    await vs.command('Local Workspace Settings: Undo Last Change');
    await vs.dialogButton('Restore');
    await waitFor(() => readJson(At.settingsFile)['editor.tabSize'] === 4 && readJson(At.localFile)['editor.tabSize'] === 4, { what: 'override back' });
    await vs.clearNotifications();
  });

  await step('the overview in the light theme', async () => {
    if (!shotsFor) return;
    const theme = async (name) => {
      ok(await paletteExact('Preferences: Color Theme', '^Preferences: Color Theme$'), 'theme picker');
      await waitFor(() => vs.quickInputVisible(), { what: 'theme picker' });
      await vs.type(name);
      await sleep(500);
      await vs.key('Enter');
      await sleep(1500);
    };
    await theme('Light Modern');
    await vs.clearNotifications();
    await openOverview();
    await hideAuxBar();
    await focusWorkbench();
    await sleep(600);
    await shotOfEditor(path.join(shotsFor, 'overview-light.png'));
    await theme('Dark Modern');
  });

  await step('Reload Window: nothing is rewritten, the state and the overview come back', async () => {
    const mtime = statSync(At.settingsFile).mtimeMs;
    const backupsBefore = (await new core.Backups(path.join(storage(), 'backups'), () => 99).list()).length;
    await openOverview();
    await focusWorkbench();
    vs.contexts.clear();
    await vs.command('Developer: Reload Window');
    await sleep(3000);
    await waitFor(() => vs.eval('!!document.querySelector(".monaco-workbench .part.statusbar")').catch(() => false), { timeout: 30000, what: 'workbench after reload' });
    await waitFor(async () => (await statusText()) === 'Local settings: generated', { what: 'status bar after reload', timeout: 20000 });
    await waitFor(async () => (await vs.editorTabs()).some((t) => t.includes('Workspace Settings')), { timeout: 20000, what: 'restored tab' });
    await vs.showTab('Workspace Settings');
    ctx = await vs.webview(25000);
    await until(`document.querySelectorAll('#keys tbody tr[data-key]').length > 5`, 'rows after reload', 15000);
    await sleep(1500);
    eq(statSync(At.settingsFile).mtimeMs, mtime, 'settings.json not rewritten');
    eq((await new core.Backups(path.join(storage(), 'backups'), () => 99).list()).length, backupsBefore, 'no new backups');
  });

  await step('no errors in the webviews (window A)', async () => {
    eq(vs.pageErrors, [], 'page errors');
  });
  await vs.close();

  // ===================================================================================
  console.log('Window B: a multi-root workspace, committed mode');
  vs = new VSCode(root);
  await vs.launch(Bws);
  await sleep(2000);
  await vs.command('View: Close Primary Side Bar').catch(() => {});

  await step('a folder whose team already uses settings.shared.json is merged without setup', async () => {
    await waitFor(() => existsSync(app2t.settingsFile), { what: 'generated settings.json', timeout: 15000 });
    eq(readJson(app2t.settingsFile), { 'editor.tabSize': 4, 'files.trimTrailingWhitespace': true, 'editor.fontSize': 15 }, 'merged');
    await waitFor(async () => (await statusText()) === 'Local settings: generated', { what: 'status bar' });
  });

  await step('committed mode: setup moves the uncommitted tweak to settings.local.json and hides settings.json from Git', async () => {
    await paletteRun('Local Workspace Settings: Set Up in This Workspace');
    await vs.pickQuickItem('service');
    await vs.pickQuickItem('Keep settings.json committed');
    await notification('Set up service: write 1 file');
    await vs.dialogButton('Set Up');
    await vs.pickQuickItem('Add to .git/info/exclude');
    await waitFor(() => existsSync(svct.localFile), { what: 'local file' });
    eq(readJson(svct.localFile), { 'go.goroot': '/home/sam/sdk/go1.24' }, 'local');
    ok(read(svct.settingsFile).includes('// Team settings for the service'), 'comment kept');
    await waitFor(() => git(svc, 'ls-files', '-v', '.vscode/settings.json').startsWith('S '), { what: 'skip-worktree' });
    await waitFor(() => git(svc, 'status', '--porcelain') === '', { what: 'clean git status' });
    await vs.clearNotifications();
  });

  await step('committed mode: a setting written to settings.json goes to settings.local.json, git status stays clean', async () => {
    const j = readJson(svct.settingsFile);
    write(svct.settingsFile, { ...j, 'go.toolsGopath': '/home/sam/go-tools' });
    await waitFor(() => readJson(svct.localFile)['go.toolsGopath'] === '/home/sam/go-tools', { what: 'routed', timeout: 15000 });
    eq(git(svc, 'status', '--porcelain'), '', 'git status');
    await vs.clearNotifications();
  });

  await step('an upstream change is noticed after a fetch; Unhide to Pull, pull, and personal settings come back', async () => {
    write(path.join(upstream, '.vscode', 'settings.json'), '{\n  // Team settings for the service\n  "editor.tabSize": 4,\n  "go.lintTool": "golangci-lint",\n  "go.lintOnSave": "package"\n}\n');
    git(upstream, 'commit', '-qam', 'lint on save');
    git(svc, 'fetch', '-q');
    await notification('the team changed .vscode/settings.json upstream', 15000);
    await vs.clearNotifications();
    await openOverview();
    if ((await w(`document.getElementById('target')?.value`)) !== svct.id) {
      await w(`(() => { const s = document.getElementById('target'); s.value = ${JSON.stringify(svct.id)}; s.dispatchEvent(new Event('change')); return true; })()`);
    }
    await until(`!!document.getElementById('upstream')`, 'upstream banner');
    await until(`document.getElementById('status')?.textContent.includes('Team change to pull')`, 'status chip says there is a team change');
    if (shotsFor) {
      await hideAuxBar();
      await focusWorkbench();
      await sleep(600);
      await shotOfEditor(path.join(shotsFor, 'committed-dark.png'));
    }
    await w(W.click('#unhide-pull'));
    await waitFor(() => !('go.goroot' in readJson(svct.settingsFile)), { what: 'unhidden' });
    ok(!git(svc, 'ls-files', '-v', '.vscode/settings.json').startsWith('S '), 'skip-worktree cleared');
    await waitFor(async () => (await statusText())?.includes('settings.json unhidden'), { what: 'status bar unhidden' });
    git(svc, 'pull', '-q', '--ff-only');
    await waitFor(() => readJson(svct.settingsFile)['go.goroot'] === '/home/sam/sdk/go1.24' && readJson(svct.settingsFile)['go.lintOnSave'] === 'package', { what: 'personal settings back', timeout: 15000 });
    await notification('your personal settings are applied');
    await waitFor(() => git(svc, 'ls-files', '-v', '.vscode/settings.json').startsWith('S '), { what: 'hidden again' });
    eq(git(svc, 'status', '--porcelain'), '', 'git status');
    await vs.clearNotifications();
  });

  await step('a team change from the overview: unhide, commit, and personal settings come back', async () => {
    ctx = await vs.webview();
    await until(`!!document.querySelector('button[data-op="toShared"][data-key="go.toolsGopath"]')`, 'row');
    await w(W.act('toShared', 'go.toolsGopath'));
    await vs.dialogButton('Unhide and Change');
    await waitFor(() => readJson(svct.settingsFile)['go.toolsGopath'] === '/home/sam/go-tools' && !('go.goroot' in readJson(svct.settingsFile)), { what: 'team change in the file' });
    eq(git(svc, 'status', '--porcelain'), ' M .vscode/settings.json\n', 'git sees the team change');
    ok(git(svc, 'diff').includes('+  "go.toolsGopath": "/home/sam/go-tools"'), 'diff');
    git(svc, 'commit', '-qam', 'share tools path');
    await waitFor(() => readJson(svct.settingsFile)['go.goroot'] === '/home/sam/sdk/go1.24', { what: 'personal settings back', timeout: 15000 });
    eq(readJson(svct.localFile), { 'go.goroot': '/home/sam/sdk/go1.24' }, 'local file');
    eq(git(svc, 'status', '--porcelain'), '', 'git status');
    await vs.clearNotifications();
  });

  await step('no errors in the webviews (window B)', async () => {
    eq(vs.pageErrors, [], 'page errors');
  });
  await vs.close();

  // ===================================================================================
  console.log('Window C: Restricted Mode');
  const R = path.join(root, 'untrusted');
  const Rt = core.folderTarget(R);
  write(Rt.sharedFile, { 'editor.tabSize': 3 });
  write(Rt.localFile, { 'editor.fontSize': 20 });
  writeFileSync(path.join(root, 'user-data', 'User', 'settings.json'), JSON.stringify({ ...settings, 'security.workspace.trust.enabled': true, 'security.workspace.trust.startupPrompt': 'never', 'security.workspace.trust.banner': 'never' }, null, 2));
  vs = new VSCode(root);
  await vs.launch(R);
  await sleep(2500);

  await step('Restricted Mode: nothing is written, the status bar says why', async () => {
    await waitFor(async () => (await statusText()) === 'Local settings' && (await vs.eval(`(${statusItem})?.querySelector('.codicon-shield') !== null`)), { what: 'shield in the status bar' });
    await sleep(2500);
    ok(!existsSync(Rt.settingsFile), 'no settings.json generated');
  });

  await step('Restricted Mode: commands explain instead of writing', async () => {
    await vs.command('Local Workspace Settings: Merge Now');
    await notification('does nothing in Restricted Mode');
    ok(!existsSync(Rt.settingsFile), 'still no settings.json');
    await vs.clearNotifications();
  });

  await step('Restricted Mode: the overview is read-only', async () => {
    await openOverview();
    await until(`!!document.getElementById('trust')`, 'trust button');
    eq(await w(W.rows), [['editor.fontSize', 'local'], ['editor.tabSize', 'shared']], 'rows');
    eq(await w(`document.getElementById('regenerate').disabled && [...document.querySelectorAll('#keys button[data-op]')].every((b) => b.disabled)`), true, 'actions disabled');
  });

  await step('granting trust merges right away', async () => {
    await vs.command('Workspaces: Manage Workspace Trust');
    const clicked = await waitFor(
      () => vs.eval(`(() => { const b = [...document.querySelectorAll('.workspace-trust-editor .monaco-button')].find((x) => /^Trust( Folder)?$/.test(x.textContent.trim())); if (!b) return false; b.click(); return true; })()`),
      { what: 'Trust button', timeout: 10000 },
    );
    ok(clicked, 'trust button');
    await waitFor(() => existsSync(Rt.settingsFile), { what: 'settings.json generated after trust', timeout: 15000 });
    eq(readJson(Rt.settingsFile), { 'editor.tabSize': 3, 'editor.fontSize': 20 }, 'merged');
  });

  await step('no errors in the webviews (window C)', async () => {
    eq(vs.pageErrors, [], 'page errors');
  });
} finally {
  await vs.close();
  console.log(`\n${passed} passed, ${failed.length} failed${failed.length ? `: ${failed.join('; ')}` : ''}`);
  console.log(`Profile and screenshots: ${root}`);
  process.exitCode = failed.length ? 1 : 0;
}
