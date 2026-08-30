import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { containCwd, containPath, type ContainmentConfig } from "./containment.js";

let root: string;
let outside: string;
let config: ContainmentConfig;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "dc-allow-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "dc-outside-")));
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "a.txt"), "a");
  writeFileSync(join(outside, "secret.txt"), "s");
  symlinkSync(outside, join(root, "escape-link"));
  writeFileSync(join(root, ".env"), "SECRET=1");
  config = { allowedRoots: [root], deniedRoots: [join(root, "denied")] };
  mkdirSync(join(root, "denied"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("containPath", () => {
  it("accepts a path inside the allow root", () => {
    const contained = containPath(config, join(root, "sub", "a.txt"));
    expect(contained.canonical).toBe(join(root, "sub", "a.txt"));
  });

  it("accepts a not-yet-existing target contained by its parent", () => {
    const contained = containPath(config, join(root, "sub", "new-file.txt"));
    expect(contained.canonical).toBe(join(root, "sub", "new-file.txt"));
  });

  it("rejects a parent-traversal escape", () => {
    expect(() => containPath(config, join(root, "..", "etc", "passwd"))).toThrow(/parent traversal|outside/);
  });

  it("rejects an absolute path outside every allow root", () => {
    expect(() => containPath(config, join(outside, "secret.txt"))).toThrow(/outside every allow root/);
  });

  it("rejects a symlink that escapes the allow root", () => {
    expect(() => containPath(config, join(root, "escape-link", "secret.txt"))).toThrow(/outside every allow root/);
  });

  it("rejects a denied root", () => {
    expect(() => containPath(config, join(root, "denied", "x"))).toThrow(/denied root/);
  });

  it("rejects credential-like paths", () => {
    expect(() => containPath(config, join(root, ".env"))).toThrow(/credential/);
    expect(() => containPath(config, join(root, "sub", "id_rsa"))).toThrow(/credential/);
    expect(() => containPath(config, join(root, ".ssh", "config"))).toThrow(/credential/);
  });

  it("rejects NUL and newline injection", () => {
    expect(() => containPath(config, `${root}/a\0b`)).toThrow(/NUL/);
    expect(() => containPath(config, `${root}/a\nb`)).toThrow(/newline/);
  });

  it("resolves relative paths against a contained base cwd", () => {
    const contained = containPath(config, "sub/a.txt", root);
    expect(contained.canonical).toBe(join(root, "sub", "a.txt"));
  });
});

describe("containCwd", () => {
  it("requires the directory to exist", () => {
    expect(() => containCwd(config, join(root, "no-such-dir"))).toThrow(/does not exist/);
  });
  it("accepts an existing contained directory", () => {
    expect(containCwd(config, join(root, "sub")).canonical).toBe(join(root, "sub"));
  });
});
