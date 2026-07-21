import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStackError } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import { loadMachineControllerConfig } from "./config.js";
import {
  createDirectory,
  editTextBlock,
  movePath,
  readTextFile,
  searchFiles,
  writePdfFile,
  writeTextFile
} from "./filesystem.js";

describe("bounded filesystem compatibility actions", () => {
  it("supports bounded reads, exact edits, moves, and directory creation", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-filesystem-compat-"));
    const config = writeConfig(dir);

    try {
      writeFileSync(join(dir, "source.txt"), "one\ntwo\nthree\nfour\n");
      expect(readTextFile(config, { path: join(dir, "source.txt"), offset: -2, length: 2 }).text).toContain("three");
      expect(createDirectory(config, { path: join(dir, "nested", "folder") })).toMatchObject({ created: true });
      expect(
        writeTextFile(config, { path: join(dir, "nested", "folder", "note.txt"), content: "hello" })
      ).toMatchObject({
        mode: "rewrite"
      });
      expect(
        editTextBlock(config, {
          path: join(dir, "nested", "folder", "note.txt"),
          old_string: "hello",
          new_string: "world",
          expected_replacements: 1
        })
      ).toMatchObject({ replacements: 1 });
      expect(() =>
        editTextBlock(config, {
          path: join(dir, "nested", "folder", "note.txt"),
          old_string: "missing",
          new_string: "world",
          expected_replacements: 1
        })
      ).toThrow(ControlStackError);
      expect(
        movePath(config, {
          source: join(dir, "nested", "folder", "note.txt"),
          destination: join(dir, "moved.txt")
        })
      ).toMatchObject({ overwritten: false });
      expect(readFileSync(join(dir, "moved.txt"), "utf8")).toBe("world");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("searches file names and redacted content and emits a new PDF", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-filesystem-search-"));
    const config = writeConfig(dir);

    try {
      writeFileSync(join(dir, "fixture.txt"), "ACS_TOKEN=secret-value\nneedle\n");
      expect(
        searchFiles(config, {
          path: dir,
          pattern: "fixture",
          searchType: "files",
          literalSearch: true
        }).matches
      ).toHaveLength(1);
      expect(
        searchFiles(config, {
          path: dir,
          pattern: "needle",
          searchType: "content",
          literalSearch: true
        }).matches
      ).toMatchObject([{ line: 2, text: "needle" }]);
      const pdf = writePdfFile(config, { path: join(dir, "result.pdf"), content: "# ACS report" });
      expect(pdf.format).toBe("pdf");
      expect(readFileSync(join(dir, "result.pdf"), "utf8")).toContain("%PDF-1.4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function writeConfig(dir: string) {
  const configPath = join(dir, "config.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      paths: { allow: [dir], deny: [] },
      commands: { allow_readonly: ["uname"], deny: [] },
      security: { max_output_bytes: 20_000 },
      audit: { log_path: join(dir, "audit.jsonl") }
    })
  );
  return loadMachineControllerConfig(configPath);
}
