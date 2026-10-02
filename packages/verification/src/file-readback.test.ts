import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { verifyFileReadback } from "./file-readback.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "acs-independent-readback-"));
  roots.push(root);
  const path = join(root, "artifact.txt");
  const assertPath = (value: string) => {
    const canonical = resolve(value);
    if (!canonical.startsWith(`${root}/`)) throw new Error("outside approved scope");
    return canonical;
  };
  return { root, path, assertPath };
}
describe("independent bounded file read-back", () => {
  it("observes bytes and hash independently without returning content", () => {
    const { path, assertPath } = fixture();
    writeFileSync(path, "verified bytes");
    const sha256 = createHash("sha256").update("verified bytes").digest("hex");
    expect(verifyFileReadback(path, { content: "verified bytes", sha256 }, assertPath)).toMatchObject({
      passed: true,
      sha256,
      bytes: 14
    });
    expect(verifyFileReadback(path, { content: "wrong" }, assertPath).passed).toBe(false);
    expect(verifyFileReadback(path, { exists: false }, assertPath).passed).toBe(false);
  });
  it("checks explicit absence and never treats missing output as successful creation", () => {
    const { path, assertPath } = fixture();
    expect(verifyFileReadback(path, { exists: false }, assertPath).passed).toBe(true);
    expect(verifyFileReadback(path, { content: "expected" }, assertPath).passed).toBe(false);
  });
  it("rejects unsupported assertions", () => {
    const { path, assertPath } = fixture();
    expect(() => verifyFileReadback(path, { passed: true }, assertPath)).toThrow();
    expect(() => verifyFileReadback(path, {}, assertPath)).toThrow();
  });
  it("rejects non-regular and oversized resources", () => {
    const { path, assertPath } = fixture();
    mkdirSync(path);
    expect(() => verifyFileReadback(path, { exists: true }, assertPath)).toThrow(/bounded regular file/u);
    rmSync(path, { recursive: true });
    writeFileSync(path, Buffer.alloc(1_048_577));
    expect(() => verifyFileReadback(path, { exists: true }, assertPath)).toThrow(/bounded regular file/u);
  });
  it("does not follow a final symlink during open", () => {
    const { root, path, assertPath } = fixture();
    const target = join(root, "target");
    writeFileSync(target, "bytes");
    symlinkSync(target, path);
    expect(() => verifyFileReadback(path, { content: "bytes" }, assertPath)).toThrow(/opened safely/u);
  });
  it("rejects an opened descriptor resolved outside its approved scope", () => {
    const { path } = fixture();
    writeFileSync(path, "bytes");
    let calls = 0;
    expect(() =>
      verifyFileReadback(path, { exists: true }, (value) => {
        if (++calls === 2) throw new Error("descriptor outside scope");
        return value;
      })
    ).toThrow(/descriptor outside scope/u);
  });
});
