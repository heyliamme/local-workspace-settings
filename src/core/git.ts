// The few Git operations the extension needs, through the git command line: whether a
// file is tracked or ignored, its committed (index) content, the skip-worktree flag, and
// whether the upstream branch changes it. Nothing here commits, pushes or pulls.
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { assertConfined, atomicWrite } from './files';

export interface GitResult {
  code: number;
  out: string;
  err: string;
  /** Set when git could not be started at all (ENOENT, EACCES). */
  spawn?: string;
}

let binary = 'git';
/** The git to run: VS Code's git.path when set, otherwise git from PATH. */
export function setGitBinary(file: string | undefined) {
  binary = file || 'git';
}

/** git itself could not be started (not installed, or not on PATH and no git.path). */
export class GitUnavailable extends Error {
  constructor(detail: string) {
    super(`Git could not be run (${binary}: ${detail}). Install Git, or point the git.path setting at it; committed settings.json files are read with git.`);
  }
}

export function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      { cwd, timeout: 15_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
      (err, stdout, stderr) => {
        const raw = (err as { code?: unknown } | null)?.code;
        const code = err ? (typeof raw === 'number' ? raw : -1) : 0;
        resolve({ code, out: String(stdout), err: String(stderr).trim(), spawn: typeof raw === 'string' ? raw : undefined });
      },
    );
  });
}

export interface RepoFile {
  /** The work tree root, as git reports it (real path). */
  root: string;
  /** The file relative to the root, with forward slashes. */
  rel: string;
}

/** Where `file` sits in a Git work tree; undefined outside one. Throws GitUnavailable when git can't run. */
export async function locate(file: string): Promise<RepoFile | undefined> {
  const dir = path.dirname(file);
  const exists = await fs.stat(dir).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!exists) return undefined;
  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  if (top.spawn) throw new GitUnavailable(top.spawn);
  if (top.code !== 0 || !top.out.trim()) return undefined;
  const root = await fs.realpath(top.out.trim()).catch(() => top.out.trim());
  const realDir = await fs.realpath(dir).catch(() => dir);
  const rel = path.relative(root, path.join(realDir, path.basename(file)));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return { root, rel: rel.split(path.sep).join('/') };
}

export async function isTracked(r: RepoFile): Promise<boolean> {
  return (await git(r.root, ['ls-files', '--error-unmatch', '--', r.rel])).code === 0;
}

export async function isIgnored(r: RepoFile): Promise<boolean> {
  return (await git(r.root, ['check-ignore', '-q', '--no-index', '--', r.rel])).code === 0;
}

/** The committed (index) content, as it would be checked out (line endings converted). */
export async function indexText(r: RepoFile): Promise<string | undefined> {
  const res = await git(r.root, ['cat-file', '--filters', `:${r.rel}`]);
  if (res.code === 0) return res.out;
  const show = await git(r.root, ['show', `:${r.rel}`]);
  return show.code === 0 ? show.out : undefined;
}

export async function indexBlob(r: RepoFile): Promise<string | undefined> {
  const res = await git(r.root, ['rev-parse', '-q', '--verify', `:${r.rel}`]);
  return res.code === 0 ? res.out.trim() : undefined;
}

/** The blob of the file on the upstream branch, when there is one and it has the file. */
export async function upstreamBlob(r: RepoFile): Promise<string | undefined> {
  const res = await git(r.root, ['rev-parse', '-q', '--verify', `@{u}:${r.rel}`]);
  return res.code === 0 ? res.out.trim() : undefined;
}

export async function hasUpstream(r: RepoFile): Promise<boolean> {
  return (await git(r.root, ['rev-parse', '-q', '--verify', '@{u}'])).code === 0;
}

/** The commit HEAD points at; undefined before the first commit. */
export async function head(root: string): Promise<string | undefined> {
  const res = await git(root, ['rev-parse', '-q', '--verify', 'HEAD']);
  return res.code === 0 ? res.out.trim() : undefined;
}

/**
 * A pull would change the file: the upstream branch has commits this branch doesn't, and
 * they change the file (or delete it) since the two branches parted. A commit of one's own
 * that isn't pushed yet is not an upstream change.
 */
export async function upstreamTouches(r: RepoFile): Promise<boolean> {
  if (!(await hasUpstream(r))) return false;
  if ((await git(r.root, ['merge-base', '--is-ancestor', '@{u}', 'HEAD'])).code === 0) return false;
  const mb = await git(r.root, ['merge-base', 'HEAD', '@{u}']);
  const base = mb.code === 0 ? mb.out.trim() : '';
  if (!base) {
    // No common history: compare the file's presence and content directly.
    const [up, idx] = await Promise.all([upstreamBlob(r), indexBlob(r)]);
    return up !== idx;
  }
  return (await git(r.root, ['diff', '--quiet', base, '@{u}', '--', `:(literal)${r.rel}`])).code === 1;
}

export async function isSkipWorktree(r: RepoFile): Promise<boolean> {
  const res = await git(r.root, ['ls-files', '-v', '--', r.rel]);
  return res.code === 0 && res.out.startsWith('S ');
}

export async function setSkipWorktree(r: RepoFile, on: boolean): Promise<void> {
  const res = await git(r.root, ['update-index', on ? '--skip-worktree' : '--no-skip-worktree', '--', r.rel]);
  if (res.code !== 0) throw new Error(`git update-index failed: ${res.err || res.code}`);
}

/** Stops tracking a file without deleting it (git rm --cached). */
export async function untrack(r: RepoFile): Promise<void> {
  const res = await git(r.root, ['rm', '--cached', '-q', '--', r.rel]);
  if (res.code !== 0) throw new Error(`git rm --cached failed: ${res.err || res.code}`);
}

export async function gitDir(root: string): Promise<string | undefined> {
  const res = await git(root, ['rev-parse', '--absolute-git-dir']);
  return res.code === 0 ? res.out.trim() : undefined;
}

/** Where an ignore rule can go: the shared .gitignore at the root, or this clone's info/exclude. */
export async function ignoreFile(root: string, where: 'gitignore' | 'exclude'): Promise<string | undefined> {
  if (where === 'gitignore') return path.join(root, '.gitignore');
  const res = await git(root, ['rev-parse', '--git-path', 'info/exclude']);
  return res.code === 0 && res.out.trim() ? path.resolve(root, res.out.trim()) : undefined;
}

/**
 * An ignore rule matching exactly one repository-relative path: anchored at the root, with
 * the characters .gitignore treats as patterns ([ ] * ? \\ and trailing spaces) escaped.
 */
export function ignorePattern(rel: string): string {
  const escaped = rel.replace(/[[\]*?\\]/g, '\\$&').replace(/ +$/, (sp) => sp.replace(/ /g, '\\ '));
  return '/' + escaped;
}

/** The text of an ignore file with the patterns added (each once), under a comment. */
export function withIgnoreLines(text: string, patterns: string[], comment: string): string {
  const have = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const missing = patterns.filter((p) => !have.has(p));
  if (!missing.length) return text;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const sep = text && !text.endsWith('\n') ? eol : '';
  const gap = text.trim() ? eol : '';
  return `${text}${sep}${gap}# ${comment}${eol}${missing.join(eol)}${eol}`;
}

export const sameText = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');

/**
 * Adds rules to an ignore file. `confine`: the file must sit inside this folder and not be
 * (or go through) a symbolic link: a committed .gitignore link would otherwise be read and
 * its target's text written into a regular .gitignore the team is asked to commit.
 */
export async function addIgnoreRules(file: string, patterns: string[], comment: string, confine?: string): Promise<void> {
  if (confine) await assertConfined(file, confine);
  const text = await fs.readFile(file, 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return '';
    throw e;
  });
  await atomicWrite(file, withIgnoreLines(text, patterns, comment), confine);
}
