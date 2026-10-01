import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUDIT_TAIL_READ_BYTES, readLastJsonlLine } from "./audit-tail-reader.js";

// The bounded read is the whole point of this module: capture the length and
// offset of every readSync so the tests can prove the file is never loaded whole.
const { readCalls } = vi.hoisted(() => ({ readCalls: [] as Array<{ length: number; position: number }> }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readSync: (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number) => {
      readCalls.push({ length, position });
      return actual.readSync(fd, buffer, offset, length, position);
    }
  };
});

const dirs: string[] = [];

function write(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "acs-audit-tail-"));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

afterEach(() => {
  readCalls.length = 0;
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("readLastJsonlLine", () => {
  it("returns undefined for a missing file", () => {
    expect(readLastJsonlLine(join(tmpdir(), "acs-audit-tail-absent.jsonl"))).toBeUndefined();
  });

  it("returns undefined for empty and blank-only files", () => {
    expect(readLastJsonlLine(write("empty.jsonl", ""))).toBeUndefined();
    expect(readLastJsonlLine(write("blank.jsonl", "\n\n  \n"))).toBeUndefined();
  });

  it("returns the final non-empty line with the previous trim/split semantics", () => {
    expect(readLastJsonlLine(write("trailing-newline.jsonl", '{"a":1}\n{"b":2}\n'))).toBe('{"b":2}');
    expect(readLastJsonlLine(write("no-trailing-newline.jsonl", '{"a":1}\n{"b":2}'))).toBe('{"b":2}');
    expect(readLastJsonlLine(write("trailing-blanks.jsonl", '{"a":1}\n{"b":2}\n\n  '))).toBe('{"b":2}');
    expect(readLastJsonlLine(write("single.jsonl", '{"only":1}'))).toBe('{"only":1}');
  });

  it("reads one bounded tail window for a file far larger than the window", () => {
    const record = (i: number) => JSON.stringify({ sequence: i, eventHash: `h${i}`, pad: "x".repeat(512) });
    const contents = `${Array.from({ length: 8000 }, (_, i) => record(i)).join("\n")}\n`;
    const path = write("big.jsonl", contents);
    expect(statSync(path).size).toBeGreaterThan(AUDIT_TAIL_READ_BYTES * 4);

    const last = readLastJsonlLine(path);
    expect(JSON.parse(last as string)).toMatchObject({ sequence: 7999, eventHash: "h7999" });

    // One read, from the tail, never longer than the window: the whole 4 MB file
    // is not loaded.
    expect(readCalls).toHaveLength(1);
    expect(readCalls[0]?.length).toBe(AUDIT_TAIL_READ_BYTES);
    expect(readCalls[0]?.position).toBe(statSync(path).size - AUDIT_TAIL_READ_BYTES);
  });

  it("expands the window backwards to keep a record longer than one window intact", () => {
    const huge = JSON.stringify({ sequence: 7, eventHash: "h7", pad: "ü".repeat(AUDIT_TAIL_READ_BYTES) });
    const path = write("huge-line.jsonl", `{"sequence":1,"eventHash":"h1"}\n${huge}\n`);
    expect(Buffer.byteLength(huge)).toBeGreaterThan(AUDIT_TAIL_READ_BYTES);

    expect(readLastJsonlLine(path)).toBe(huge);
    // The first read still starts at the bounded tail window, then the window
    // doubles because the final record does not fit in one chunk.
    expect(readCalls[0]?.length).toBe(AUDIT_TAIL_READ_BYTES);
    expect(readCalls.length).toBeGreaterThan(1);
    expect(readCalls[1]?.length).toBe(Math.min(statSync(path).size, AUDIT_TAIL_READ_BYTES * 2));
  });
});
