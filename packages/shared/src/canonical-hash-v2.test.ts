import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalJsonV2, CANONICAL_V2_PREFIX, domainHashV2, stableHash, stableHashV2 } from "./hash.js";

type GoldenCase = {
  id: string;
  domain?: string;
  input: unknown;
  canonical: string;
  sha256: string;
};
type Golden = { schema: string; prefix: string; cases: GoldenCase[] };

const golden: Golden = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../contracts/canonical-hash/v2.golden.json", import.meta.url)), "utf8")
);

describe("canonical JSON v2 golden fixtures (shared with the Rust crate)", () => {
  it("declares the versioned prefix it hashes", () => {
    expect(golden.schema).toBe("acs.canonical-hash.golden.v2");
    expect(golden.prefix).toBe(CANONICAL_V2_PREFIX);
    expect(golden.cases.length).toBeGreaterThanOrEqual(17);
  });

  for (const testCase of golden.cases) {
    it(`matches the recorded canonical text and digest: ${testCase.id}`, () => {
      expect(canonicalJsonV2(testCase.input)).toBe(testCase.canonical);
      const digest = testCase.domain ? domainHashV2(testCase.domain, testCase.input) : stableHashV2(testCase.input);
      expect(digest).toBe(testCase.sha256);
    });
  }

  it("keeps non-ASCII keys in code point order, distinct from UTF-16 order", () => {
    const keys = golden.cases.find((c) => c.id === "keys-non-ascii-and-supplementary");
    expect(keys).toBeDefined();
    // U+1F600 sorts after U+E000 by code point. UTF-16 order would put it before.
    expect(canonicalJsonV2({ "": 1, "\u{1F600}": 2 })).toBe('{"":1,"\u{1F600}":2}');
  });
});

describe("canonical JSON v2 is independent of host locale", () => {
  it("orders non-ASCII keys by code point in-process", () => {
    expect(canonicalJsonV2({ ä: 1, z: 2 })).toBe('{"z":2,"ä":1}');
  });

  it("produces the same digest under a Swedish locale, where v1 orders differently", () => {
    const value = { z: 2, ä: 1, a: 3 };
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { stableHashV2, stableHash } from ${JSON.stringify(new URL("./hash.ts", import.meta.url).href)};
         process.stdout.write(JSON.stringify({ v2: stableHashV2(${JSON.stringify(value)}), v1: stableHash(${JSON.stringify(value)}) }));`
      ],
      { env: { ...process.env, LANG: "sv_SE.UTF-8", LC_ALL: "sv_SE.UTF-8" }, encoding: "utf8" }
    );
    expect(child.status, child.stderr).toBe(0);
    const underSwedish = JSON.parse(child.stdout) as { v1: string; v2: string };
    // Control: the environment really changes v1 ordering, so v1 is locale-dependent here.
    expect(underSwedish.v1).not.toBe(stableHash(value));
    // v2 is the same under the Swedish locale as in this process.
    expect(underSwedish.v2).toBe(stableHashV2(value));
  });
});

describe("canonical JSON v2 fails closed outside its domain", () => {
  const rejected: Array<[string, unknown]> = [
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["non-integer", 1.5],
    ["above the safe range", 2 ** 53],
    ["below the safe range", -(2 ** 53)],
    ["bigint", 1n],
    ["symbol", Symbol("x")],
    ["function", () => 1],
    ["Date", new Date(0)],
    ["Map", new Map([["a", 1]])],
    ["class instance", new (class Thing {})()],
    ["lone high surrogate in a value", { s: "\uD800" }],
    ["lone low surrogate in a key", { "\uDC00": 1 }],
    ["nested non-finite", { a: [{ b: Number.NaN }] }]
  ];

  for (const [name, value] of rejected) {
    it(`rejects ${name}`, () => {
      expect(() => canonicalJsonV2(value)).toThrow(TypeError);
    });
  }

  it("rejects top-level undefined", () => {
    expect(() => canonicalJsonV2(undefined)).toThrow(TypeError);
  });

  it("encodes undefined as v1 does: dropped from objects and null in arrays", () => {
    expect(canonicalJsonV2({ a: undefined, b: [1, undefined, 3] })).toBe('{"b":[1,null,3]}');
  });

  it("encodes integral values exactly and negative zero as zero", () => {
    expect(canonicalJsonV2([0, -0, 9_007_199_254_740_991, -9_007_199_254_740_991])).toBe(
      "[0,0,9007199254740991,-9007199254740991]"
    );
  });
});

describe("canonical JSON v1 is unchanged by the v2 addition", () => {
  it("keeps v1 canonical text and digest for the values it has always hashed", () => {
    expect(canonicalJson({ z: 1, nested: { b: 2, a: 1 }, array: [1, undefined, 3], omitted: undefined })).toBe(
      '{"array":[1,null,3],"nested":{"a":1,"b":2},"z":1}'
    );
    expect(stableHash({})).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
  });

  it("never collides with v2, because v2 hashes a versioned prefix", () => {
    expect(stableHashV2({})).not.toBe(stableHash({}));
  });
});
