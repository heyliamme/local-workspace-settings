import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { devNull, tmpdir } from 'os';
import path from 'path';
import { after } from 'node:test';

export const core = createRequire(import.meta.url)('../dist/core.js');

// Every test works in a throwaway folder; nothing here looks at a real workspace.
const made = [];
export function tmp(prefix = 'lws-test-') {
  const d = realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
  made.push(d);
  return d;
}
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

export const read = (f) => readFileSync(f, 'utf8');
export const readJson = (f) => core.parseObject(read(f));
export function write(f, text) {
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, typeof text === 'string' ? text : JSON.stringify(text, null, 2) + '\n');
}

/** A folder target in a fresh temp folder, with a backups folder and a context. */
export function folder(files = {}) {
  const dir = tmp();
  for (const [name, text] of Object.entries(files)) write(path.join(dir, '.vscode', name), text);
  const t = core.folderTarget(dir);
  const backups = new core.Backups(path.join(tmp('lws-backups-'), 'b'), () => 20);
  return { dir, t, ctx: { backups, header: true }, backups };
}

/** A router that answers every change with the same route, and records what it was asked. */
export function router(route = 'local') {
  const asked = [];
  const fn = async (changes) => {
    asked.push(...changes);
    return changes.map((c) => (typeof route === 'function' ? route(c) : route));
  };
  fn.asked = asked;
  return fn;
}

// The machine's Git config is shut out for the tests and for the extension's own git calls
// alike (it inherits process.env): a Windows runner's system core.autocrlf=true seen by one
// side only would make the two disagree about line endings. Tests that care set it per repo.
process.env.GIT_CONFIG_GLOBAL = devNull;
process.env.GIT_CONFIG_NOSYSTEM = '1';
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
}
/**
 * A repository with .vscode/settings.json committed, cloned so it has an upstream.
 * `config` is repo-level Git config for both sides, e.g. { 'core.autocrlf': 'true' }.
 */
export function repo(settings, config = {}) {
  const dir = tmp('lws-git-');
  const up = path.join(dir, 'up');
  mkdirSync(up);
  git(up, 'init', '-q', '-b', 'main');
  const cfg = Object.entries(config).flatMap(([k, v]) => ['-c', `${k}=${v}`]);
  for (const [k, v] of Object.entries(config)) git(up, 'config', k, v);
  write(path.join(up, '.vscode', 'settings.json'), settings);
  write(path.join(up, 'README.md'), '# r\n');
  git(up, 'add', '.');
  git(up, 'commit', '-qm', 'init');
  const me = path.join(dir, 'me');
  git(dir, 'clone', '-q', ...cfg, up, me);
  return { up, me, t: core.folderTarget(me), commitUp: (f, text, msg = 'up') => (write(path.join(up, f), text), git(up, 'add', '.'), git(up, 'commit', '-qm', msg)) };
}
