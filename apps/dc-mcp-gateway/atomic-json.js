import fs from "node:fs";
import path from "node:path";

// Atomic and always 0600: write a private temp file, then rename over the target. A crash can never leave a truncated
// tokens.json (which would silently forget every refresh token and force every client to reconnect), and rename
// replaces a pre-existing file that was created with looser permissions.
export const saveJson = (f, o, io = fs) => {
  const tmp = `${f}.${process.pid}.tmp`;
  io.rmSync(tmp, { force: true }); // never write through a stale file or a planted symlink; 'wx' below refuses both
  const fd = io.openSync(tmp, 'wx', 0o600);
  try {
    io.fchmodSync(fd, 0o600);
    // writeSync may write fewer bytes than asked; never rename a truncated file over tokens.json.
    const buf = Buffer.from(JSON.stringify(o, null, 2));
    for (let off = 0; off < buf.length;) {
      const written = io.writeSync(fd, buf, off, buf.length - off);
      if (written <= 0) throw new Error("atomic JSON write made no progress");
      off += written;
    }
    io.fsyncSync(fd);
  } catch (error) {
    io.closeSync(fd); io.rmSync(tmp, { force: true }); // do not leave plaintext tokens behind on ENOSPC etc.
    throw error;
  }
  io.closeSync(fd);
  io.renameSync(tmp, f);
  try { const dfd = io.openSync(path.dirname(f), 'r'); try { io.fsyncSync(dfd); } finally { io.closeSync(dfd); } } catch { /* best effort: durability of the rename */ }
};
