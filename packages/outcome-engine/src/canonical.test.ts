import { describe, expect, it } from "vitest";
import { canonicalize, outcomeHash } from "./canonical.js";

describe("canonicalize", () => {
  it("orders keys by code unit, not by locale", () => {
    expect(canonicalize({ b: 1, B: 2, a: 3, é: 4, Z: 5 })).toBe('{"B":2,"Z":5,"a":3,"b":1,"é":4}');
  });
  it("is stable across key insertion order and nesting", () => {
    expect(canonicalize({ x: { b: [1, { d: 1, c: 2 }], a: null } })).toBe(
      canonicalize({ x: { a: null, b: [1, { c: 2, d: 1 }] } })
    );
  });
  it("refuses values that have no canonical form", () => {
    expect(() => canonicalize({ a: undefined })).toThrow(/unsupported/u);
    expect(() => canonicalize(Number.NaN)).toThrow(/non-finite/u);
    expect(() => canonicalize(Infinity)).toThrow(/non-finite/u);
    expect(() => canonicalize(1n)).toThrow(/unsupported/u);
    expect(() => canonicalize(() => 1)).toThrow(/unsupported/u);
  });
  it("hashes with domain separation and pinned golden values", () => {
    expect(outcomeHash("a", { x: 1 })).not.toBe(outcomeHash("b", { x: 1 }));
    expect(outcomeHash("plan", { x: 1 })).toBe("4056989c126a450c803e65b8bbacc5da66b81f397fd3650ab4590c0f64c0642a");
    expect(() => outcomeHash("Bad Domain", {})).toThrow(/bounded identifier/u);
  });
});
