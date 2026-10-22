// Files on disk: reading with a hash, atomic writes that never go through a symbolic link
// inside the workspace, and rotating backups taken before every write. Node only.
import { createHash, randomBytes } from 'crypto';
import { promises as fs, constants } from 'fs';
import * as path from 'path';

export const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export interface FileState {
  path: string;
  exists: boolean;
  text: string;
  /** Hash of the content, or "absent". */
  hash: string;
}

export async function readState(file: string): Promise<FileState> {
  try {
    const text = await fs.readFile(file, 'utf8');
    return { path: file, exists: true, text, hash: sha(text) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { path: file, exists: false, text: '', hash: 'absent' };
    throw e;
  }
}

/**
 * Refuses a path under `root` that goes through a symbolic link, or that leaves `root`.
 * The files live in a folder the repository controls: a link committed there could send
 * a write into another tracked file or out of the workspace.
 */
export async function assertConfined(file: string, root: string): Promise<void> {
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${file} is outside ${root}.`);
  let cur = root;
  for (const part of rel.split(path.sep)) {
    cur = path.join(cur, part);
    let st;
    try {
      st = await fs.lstat(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    if (st.isSymbolicLink()) throw new Error(`${path.relative(root, cur)} is a symbolic link. Settings are not written through links; nothing was written.`);
  }
}

/**
 * Writes atomically: a temporary file next to the target, flushed, then renamed over it.
 * An existing file keeps its permissions.
 */
export async function atomicWrite(file: string, content: string, confine?: string): Promise<void> {
  if (confine) await assertConfined(file, confine);
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  let mode = 0o644;
  try {
    mode = (await fs.stat(file)).mode & 0o7777;
  } catch {
    /* new file */
  }
  const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  const h = await fs.open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try {
    await h.writeFile(content, 'utf8');
    await h.sync();
  } finally {
    await h.close();
  }
  try {
    await fs.chmod(tmp, mode).catch(() => {});
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

export async function removeFile(file: string, confine?: string): Promise<void> {
  if (confine) await assertConfined(file, confine);
  await fs.rm(file, { force: true });
}

// ---- Backups -------------------------------------------------------------------------

export interface BackupFile {
  path: string;
  /** The file didn't exist: restoring removes it. */
  absent: boolean;
  hash: string;
}

export interface BackupEntry {
  id: string;
  /** The settings file of the folder or workspace the change was for. */
  target: string;
  at: number;
  /** What the change was, such as "Moved editor.fontSize to settings.local.json". */
  reason: string;
  files: BackupFile[];
  /** Taken by the setup of this mode: restoring it turns local settings off again. */
  setup?: 'generated' | 'committed';
}

/** Rotating copies of the files a change touches, taken before it; newest first. */
export class Backups {
  constructor(
    readonly dir: string,
    private readonly keep: () => number,
  ) {}

  /** `rotate: false` keeps old entries until rotate() is called (after the writes). */
  async take(target: string, reason: string, states: FileState[], opts: { rotate?: boolean; setup?: BackupEntry['setup'] } = {}): Promise<BackupEntry> {
    const at = Date.now();
    const id = `${new Date(at).toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
    const dir = path.join(this.dir, id);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const files: BackupFile[] = [];
    for (const [i, s] of states.entries()) {
      files.push({ path: s.path, absent: !s.exists, hash: s.hash });
      if (s.exists) await fs.writeFile(path.join(dir, `${i}.bak`), s.text, { mode: 0o600 });
    }
    const entry: BackupEntry = { id, target, at, reason, files, ...(opts.setup ? { setup: opts.setup } : {}) };
    await fs.writeFile(path.join(dir, 'entry.json'), JSON.stringify(entry, null, 2), { mode: 0o600 });
    if (opts.rotate !== false) await this.rotate(target);
    return entry;
  }

  async list(target?: string): Promise<BackupEntry[]> {
    let names: string[] = [];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const out: BackupEntry[] = [];
    for (const n of names) {
      try {
        const e = JSON.parse(await fs.readFile(path.join(this.dir, n, 'entry.json'), 'utf8')) as BackupEntry;
        if (!target || e.target === target) out.push(e);
      } catch {
        /* a broken or half-written entry is skipped */
      }
    }
    return out.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
  }

  /** The saved text of one file of an entry; undefined when it didn't exist. */
  async content(e: BackupEntry, file: string): Promise<string | undefined> {
    const i = e.files.findIndex((f) => f.path === file);
    if (i < 0 || e.files[i].absent) return undefined;
    return fs.readFile(path.join(this.dir, e.id, `${i}.bak`), 'utf8');
  }

  async remove(e: BackupEntry): Promise<void> {
    await fs.rm(path.join(this.dir, e.id), { recursive: true, force: true });
  }

  async rotate(target: string) {
    const keep = Math.max(1, Math.floor(this.keep()));
    for (const e of (await this.list(target)).slice(keep)) await this.remove(e);
  }
}
