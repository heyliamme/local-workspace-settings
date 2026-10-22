// The extension manifest, what the package ships, and what the code is allowed to do.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const text = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const sources = [...readdirSync(new URL('../src', import.meta.url)).filter((f) => f.endsWith('.ts')).map((f) => `src/${f}`), ...readdirSync(new URL('../src/core', import.meta.url)).map((f) => `src/core/${f}`), 'webview/main.ts'];

test('runs where the files are: on the remote side in Remote, WSL and containers', () => {
  assert.deepEqual(pkg.extensionKind, ['workspace']);
});

test('settings a workspace could abuse are application-scoped; only the array rules can come from the team', () => {
  for (const [k, v] of Object.entries(pkg.contributes.configuration.properties)) assert.equal(v.scope, k === 'localWorkspaceSettings.arrayMerge' ? 'resource' : 'application', k);
});

test('Restricted Mode support is declared and explained', () => {
  assert.equal(pkg.capabilities.untrustedWorkspaces.supported, 'limited');
  assert.match(pkg.capabilities.untrustedWorkspaces.description, /Restricted Mode nothing is written and Git is never run/);
  assert.equal(pkg.capabilities.virtualWorkspaces.supported, false);
});

test('every command is registered in the code and documented in the README, and so is every setting', () => {
  const src = text('src/extension.ts');
  const readme = text('README.md');
  for (const c of pkg.contributes.commands) {
    assert.ok(src.includes(`'${c.command}'`), `${c.command} registered`);
    assert.ok(readme.includes(c.title.replace('…', '')), `${c.title} in the README`);
  }
  for (const k of Object.keys(pkg.contributes.configuration.properties)) assert.ok(readme.includes(k), `${k} in the README`);
});

test('the walkthrough pages ship with the package', () => {
  const ignore = text('.vscodeignore');
  assert.match(ignore, /^!media\/walkthrough\/\*\.md$/m);
  for (const s of pkg.contributes.walkthroughs[0].steps) assert.ok(text(s.media.markdown).length > 100, s.id);
});

test('the package ships the third-party notices for what it bundles, pinned to exact versions', () => {
  assert.match(text('.vscodeignore'), /^!ThirdPartyNotices\.txt$/m);
  const notices = text('ThirdPartyNotices.txt');
  const version = (name) => JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8')).version;
  for (const n of ['jsonc-parser', '@vscode/codicons']) {
    assert.ok(notices.includes(`${n} ${version(n)}`), `${n} version`);
    assert.match(pkg.devDependencies[n], /^\d+\.\d+\.\d+$/, n);
  }
  assert.match(notices, /creativecommons\.org\/licenses\/by\/4\.0/);
});

test('the webview runs only its own script and builds the DOM without innerHTML', () => {
  assert.match(text('src/panel.ts'), /default-src 'none'; style-src \$\{w\.cspSource\}; script-src 'nonce-\$\{nonce\}'/);
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(text('webview/main.ts')));
});

test('no telemetry and no network at all', () => {
  for (const f of sources) {
    const s = text(f).replace(/\/\/.*$/gm, '');
    assert.ok(!/telemetry|https?\.request|XMLHttpRequest|WebSocket|\bfetch\(|net\.connect/i.test(s), f);
  }
});

test('git is only run through the one helper, never through a shell, and never commits or pushes', () => {
  const offenders = sources.filter((f) => f !== 'src/core/git.ts' && /child_process/.test(text(f)));
  assert.deepEqual(offenders, []);
  const g = text('src/core/git.ts');
  assert.ok(!/\bexec\(|spawn\(|shell:\s*true/.test(g), 'execFile only');
  for (const verb of ["'commit'", "'push'", "'pull'", "'fetch'", "'reset'", "'checkout'", "'stash'"]) assert.ok(!g.includes(verb), verb);
});

test('no shipped file mentions a real home folder (the examples use /home/sam)', () => {
  for (const f of [...sources, 'README.md', 'package.json']) assert.ok(!/\/home\/(?!sam\b)|\/Users\/|C:\\Users\\/.test(text(f)), f);
});
