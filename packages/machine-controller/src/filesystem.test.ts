import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMachineControllerConfig } from "./config.js";
import { readTextFile } from "./filesystem.js";

describe("fs.read line-range handling", () => {
  it("matches split semantics for full reads, including trailing-newline and empty files", () => {
    const { config, dir, allowed } = setup();
    try {
      const cases = [
        "a\nb\nc",
        "a\nb\nc\n",
        "\r\nline2\r\nline3",
        "single",
        "",
        "\n",
        "a\r\nb",
        "value\r",       // lone trailing CR, no trailing newline
        "a\rb",           // lone mid-line CR
        "one\r\ntwo\r"    // CRLF lines followed by a lone trailing CR
      ];
      for (const [name, content] of cases.entries()) {
        const file = join(allowed, `case-${name}.txt`);
        writeFileSync(file, content);
        const expected = content.split(/\r?\n/).map((line, index) => `${index + 1}: ${line}`).join("\n");
        expect(readTextFile(config, { path: file, start_line: 1 }).text).toBe(expected);
      }
    } finally {
      cleanup(dir);
    }
  });

  it("returns exactly the requested 1-based inclusive line range", () => {
    const { config, dir, allowed } = setup();
    try {
      const file = join(allowed, "lines.txt");
      writeFileSync(file, Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n"));
      const result = readTextFile(config, { path: file, start_line: 3, end_line: 5 });
      expect(result.startLine).toBe(3);
      expect(result.endLine).toBe(5);
      expect(result.text).toBe("3: line3\n4: line4\n5: line5");
    } finally {
      cleanup(dir);
    }
  });

  it("reports the true final line when the range extends past end of file", () => {
    const { config, dir, allowed } = setup();
    try {
      const file = join(allowed, "short.txt");
      writeFileSync(file, "one\ntwo\n");
      const result = readTextFile(config, { path: file, start_line: 2, end_line: 99 });
      expect(result.endLine).toBe(3);
      expect(result.text).toBe("2: two\n3: ");
      const empty = readTextFile(config, { path: file, start_line: 50, end_line: 60 });
      expect(empty.text).toBe("");
      expect(empty.endLine).toBe(3);
    } finally {
      cleanup(dir);
    }
  });

  it("strips CR from CRLF line endings inside a range", () => {
    const { config, dir, allowed } = setup();
    try {
      const file = join(allowed, "crlf.txt");
      writeFileSync(file, "one\r\ntwo\r\nthree\r\n");
      const result = readTextFile(config, { path: file, start_line: 2, end_line: 2 });
      expect(result.text).toBe("2: two");
    } finally {
      cleanup(dir);
    }
  });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "acs-machine-fsread-"));
  const allowed = join(dir, "allowed");
  mkdirSync(allowed);
  const config = writeConfig(dir, allowed);
  return { config, dir, allowed };
}

function writeConfig(dir: string, allowed: string) {
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      paths: { allow: [allowed], deny: [] },
      commands: { allow_readonly: [], deny: [] },
      audit: { log_path: join(dir, "audit.jsonl") }
    })
  );
  return loadMachineControllerConfig(configPath);
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}
