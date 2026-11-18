/**
 * Root-controlled file reads (shared by the JC local policy and the approverd passkey trust anchor).
 *
 * Rule (restores #324's local-policy.ts:90-96, plus main's JC-owner/JC-writable checks):
 *  - The file and EVERY parent directory up to `/` must be owned by uid 0.
 *  - No component may be group- or world-writable (no sticky-bit exception: /tmp is rejected).
 *  - No component may be owned by, or writable by, the current (JC) account.
 *  - A symlink anywhere in the literal path is accepted only if the link itself is root-owned AND the
 *    realpath of the whole path is a root-controlled chain that contains no symlinks.
 *  - TOCTOU: the realpath chain is lstat-ed, the file is opened with O_NOFOLLOW, the open fd is fstat-ed,
 *    and its (dev, ino) must equal the lstat taken during the chain check; the bytes are then read from that
 *    fd, so a file swapped between the check and the read is rejected.
 *
 * Errors carry fixed messages and never include file contents. A missing file surfaces the original
 * ENOENT error (code preserved) so callers keep their fail-closed / fallback handling.
 *
 * Every filesystem and uid call goes through `RootControlledFileIo`, so tests can model root-owned trees
 * without running as root. Production always uses `defaultRootControlledFileIo`.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface RootControlledStat {
  uid: number;
  mode: number;
  dev: number;
  ino: number;
  size: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface RootControlledFileIo {
  lstat(p: string): RootControlledStat;
  realpath(p: string): string;
  /** Opens read-only with O_NOFOLLOW (and O_NONBLOCK, so a swapped-in FIFO cannot hang the caller). */
  openNoFollow(p: string): number;
  fstat(fd: number): RootControlledStat;
  read(fd: number, maxBytes: number): Buffer;
  close(fd: number): void;
  /** True when the current process could write `p` (access(W_OK)). */
  writable(p: string): boolean;
  geteuid(): number | undefined;
}

export class RootControlledFileError extends Error {}

export const defaultRootControlledFileIo: RootControlledFileIo = {
  lstat: (p) => fs.lstatSync(p),
  realpath: (p) => fs.realpathSync(p),
  openNoFollow: (p) => fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)),
  fstat: (fd) => fs.fstatSync(fd),
  read: (fd, maxBytes) => {
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    for (;;) {
      const n = fs.readSync(fd, buffer, total, buffer.length - total, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) break;
    }
    return buffer.subarray(0, total);
  },
  close: (fd) => fs.closeSync(fd),
  writable: (p) => {
    try {
      fs.accessSync(p, fs.constants.W_OK);
      return true;
    } catch {
      return false; // EACCES / EROFS: not writable by us, which is what we require.
    }
  },
  geteuid: () => process.geteuid?.(),
};

export interface RootControlledOptions {
  /** Name used for the current account in messages. */
  accountLabel?: string;
  io?: RootControlledFileIo;
}

function checkComponent(p: string, stat: RootControlledStat, io: RootControlledFileIo, label: string): void {
  // An owner can always chmod the path writable again, so a read-only mode on a path we own proves nothing.
  const me = io.geteuid();
  if (me !== undefined && me !== 0 && stat.uid === me) throw new RootControlledFileError(`${p} is owned by the ${label} (uid ${me}); it could make it writable again`);
  if ((stat.mode & 0o022) !== 0) throw new RootControlledFileError(`${p} is group/world-writable`);
  if (stat.uid !== 0) throw new RootControlledFileError(`${p} is not owned by root (uid ${stat.uid})`);
  if (io.writable(p)) throw new RootControlledFileError(`${p} is writable by the ${label} process (uid ${me ?? '?'}); a file the process can edit cannot be trusted`);
}

function components(resolved: string): string[] {
  const out: string[] = [];
  let current = resolved;
  for (;;) {
    out.push(current);
    const parent = path.dirname(current);
    if (parent === current) return out;
    current = parent;
  }
}

/**
 * Throws unless `filePath` is a root-controlled chain (see the module header). Returns the lstat of the
 * canonical file and its canonical path. Does not read the file.
 */
export function assertRootControlledPath(filePath: string, options: RootControlledOptions = {}): { realPath: string; stat: RootControlledStat } {
  const io = options.io ?? defaultRootControlledFileIo;
  const label = options.accountLabel ?? 'JC account';
  if (process.platform === 'win32' && io === defaultRootControlledFileIo) throw new RootControlledFileError('root-controlled files require POSIX ownership');
  const resolved = path.resolve(filePath);
  // Pass 1, literal path: a symlink component is tolerated only if root owns the link itself.
  let sawLink = false;
  for (const p of components(resolved)) {
    const stat = io.lstat(p);
    if (stat.isSymbolicLink()) {
      if (stat.uid !== 0) throw new RootControlledFileError(`${p} is a symlink not owned by root`);
      sawLink = true;
      continue;
    }
    checkComponent(p, stat, io, label);
  }
  // Pass 2, canonical path: must contain no symlinks at all and be root-controlled end to end.
  const realPath = sawLink ? io.realpath(resolved) : resolved;
  let fileStat: RootControlledStat | undefined;
  for (const p of components(realPath)) {
    const stat = io.lstat(p);
    if (stat.isSymbolicLink()) throw new RootControlledFileError(`${p} is a symlink`);
    checkComponent(p, stat, io, label);
    fileStat ??= stat;
  }
  return { realPath, stat: fileStat! };
}

/**
 * Reads a root-controlled regular file of at most `maxBytes`, from the same inode that passed the chain
 * check. Throws RootControlledFileError on any violation; a missing file rethrows the ENOENT error.
 */
export function readRootControlledFile(filePath: string, maxBytes: number, options: RootControlledOptions = {}): string {
  const io = options.io ?? defaultRootControlledFileIo;
  const { realPath, stat } = assertRootControlledPath(filePath, { ...options, io });
  if (!stat.isFile()) throw new RootControlledFileError(`${realPath} is not a regular file`);
  let fd: number;
  try {
    fd = io.openNoFollow(realPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    throw new RootControlledFileError(`${realPath} could not be opened without following links`);
  }
  try {
    const opened = io.fstat(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new RootControlledFileError(`${realPath} was replaced between the ownership check and the read`);
    if (!opened.isFile()) throw new RootControlledFileError(`${realPath} is not a regular file`);
    if (opened.uid !== 0 || (opened.mode & 0o022) !== 0) throw new RootControlledFileError(`${realPath} changed ownership or mode between the check and the read`);
    if (opened.size > maxBytes) throw new RootControlledFileError(`${realPath} exceeds ${maxBytes} bytes`);
    const bytes = io.read(fd, maxBytes);
    if (bytes.length > maxBytes) throw new RootControlledFileError(`${realPath} exceeds ${maxBytes} bytes`);
    return bytes.toString('utf8');
  } finally {
    io.close(fd);
  }
}
