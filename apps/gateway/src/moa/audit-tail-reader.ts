import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

/**
 * Bytes read from the end of an append-only audit JSONL to locate its final
 * record. The audit logs grow without bound, so rehydration must not load the
 * whole file: reading a bounded tail keeps gateway startup memory and time flat
 * in the number of records already written. The window doubles only when the
 * final record is longer than one chunk, so a large record is still returned
 * intact.
 */
export const AUDIT_TAIL_READ_BYTES = 64 * 1024;

/**
 * Return the last non-empty line of an append-only JSONL file, or `undefined`
 * when the file is missing, empty, or holds only blank lines.
 *
 * Semantics match `readFileSync(path, "utf8").trim().split("\n").filter(Boolean).at(-1)`
 * for the value returned, but the file is read from the end in bounded chunks
 * instead of being loaded whole.
 */
export function readLastJsonlLine(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const size = statSync(path).size;
  if (size === 0) return undefined;

  const fd = openSync(path, "r");
  try {
    let windowBytes = Math.min(AUDIT_TAIL_READ_BYTES, size);
    for (;;) {
      const offset = size - windowBytes;
      const text = readWindow(fd, offset, windowBytes);
      // Strip trailing whitespace exactly as the previous whole-file `trim()`
      // did, then everything after the final newline is the last line.
      const trimmed = text.replace(/\s+$/u, "");
      const lastNewline = trimmed.lastIndexOf("\n");
      const lastLine = lastNewline === -1 ? trimmed : trimmed.slice(lastNewline + 1);
      if (lastLine && (lastNewline !== -1 || offset === 0)) return lastLine;
      if (offset === 0) return undefined;
      windowBytes = Math.min(size, windowBytes * 2);
    }
  } finally {
    closeSync(fd);
  }
}

function readWindow(fd: number, offset: number, length: number): string {
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const bytes = readSync(fd, buffer, read, length - read, offset + read);
    if (bytes <= 0) break;
    read += bytes;
  }
  // Only bytes read are decoded; a partial multi-byte character at the window
  // start is discarded with the rest of the line preceding the newline.
  return buffer.subarray(0, read).toString("utf8");
}
