import { redactValue } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import { assertRepresentable, isRepresentable, safeText, sanitizeDeep } from "./persist.js";

const SECRETISH = ["ghp_abcdefghijklmnop", "Bearer abcdef.ghi", "sk-aaaaaaaaaaaaaaaaaaaaaaaa", "API_KEY=abc123"];

describe("persisted form", () => {
  it("leaves ordinary text alone and substitutes anything the store would redact", () => {
    expect(safeText("src/a.ts")).toBe("src/a.ts");
    for (const text of SECRETISH) {
      const safe = safeText(text);
      expect(safe).toMatch(/^\[unrepresentable:[0-9a-f]{12}\]$/u);
      expect(redactValue(safe)).toBe(safe);
      expect(safe).toBe(safeText(text));
    }
  });
  it("sanitizeDeep rewrites only string leaves, never keys, and makes the body representable", () => {
    const body = { a: ["x", SECRETISH[0]], nested: { path: SECRETISH[2], n: 1, ok: true, none: null } };
    expect(isRepresentable(body)).toBe(false);
    const clean = sanitizeDeep(body);
    expect(Object.keys(clean.nested)).toEqual(["path", "n", "ok", "none"]);
    expect(isRepresentable(clean)).toBe(true);
    expect(() => assertRepresentable(clean, "x")).not.toThrow();
    expect(() => assertRepresentable(body, "x")).toThrow(/would redact/u);
  });
  it("treats a sensitive key name as unrepresentable", () => {
    expect(isRepresentable({ token: "x" })).toBe(false);
  });
});
