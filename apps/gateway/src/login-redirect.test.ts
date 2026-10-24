import { describe, expect, it } from "vitest";
import { safeLoginRedirect } from "./server.js";

const base = "https://console.invalid";
const staysOnOrigin = (target: string) => {
  expect(target.startsWith("/"), target).toBe(true);
  expect(target.startsWith("//"), target).toBe(false);
  expect(target.includes("\\"), target).toBe(false);
  expect(new URL(target, base).origin, target).toBe(base);
};

describe("safeLoginRedirect", () => {
  // Dot-segment normalisation used to collapse these to "//evil.com" (or "///evil.com").
  it.each(["/.//evil.com", "/..//evil.com", "/a/..//evil.com", "/%2e%2e//evil.com", "/..///evil.com"])(
    "falls back to / for %s",
    (payload) => {
      const result = safeLoginRedirect(payload);
      expect(result).toBe("/");
      staysOnOrigin(result);
    }
  );

  it("falls back to / for an oversized value", () => {
    expect(safeLoginRedirect(`/${"a".repeat(100_000)}`)).toBe("/");
    expect(safeLoginRedirect(`/${"a".repeat(2048)}`)).toBe("/");
    expect(safeLoginRedirect(`/${"a".repeat(2047)}`)).toBe(`/${"a".repeat(2047)}`);
  });

  it("keeps ordinary same-origin paths", () => {
    expect(safeLoginRedirect("/next/")).toBe("/next/");
    expect(safeLoginRedirect("/a/../next/?q=1#h")).toBe("/next/?q=1#h");
  });
});
