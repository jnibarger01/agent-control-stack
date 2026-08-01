import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  STRICT_CANONICAL_SHA256_V1_DOMAIN,
  canonicalJson,
  stableHash,
  strictCanonicalJsonV1,
  strictCanonicalSha256V1
} from "./index.js";

describe("strict canonicalization v1", () => {
  it("is invariant under recursively shuffled object insertion order for a reproducible fuzz seed", () => {
    const seed = 0x5eed_cafe;
    let random = seed;
    const next = (): number => {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      return random;
    };
    const value = (depth: number): unknown => {
      if (depth === 0) return [null, false, true, "seeded", -0, 1.5][next() % 6];
      if (next() % 3 === 0) {
        const entries = Array.from(
          { length: 1 + (next() % 5) },
          (_, index) => [`key-${index}-${next() % 7}`, value(depth - 1)] as const
        );
        entries.reverse();
        return Object.fromEntries(entries);
      }
      return Array.from({ length: next() % 5 }, () => value(depth - 1));
    };
    const original = value(4);
    const shuffleKeys = (input: unknown): unknown => {
      if (Array.isArray(input)) return input.map(shuffleKeys);
      if (!input || typeof input !== "object") return input;
      const entries = Object.entries(input).map(([key, entry]) => [key, shuffleKeys(entry)] as const);
      entries.sort(() => (next() % 3) - 1);
      return Object.fromEntries(entries);
    };
    const shuffled = shuffleKeys(original);

    expect(() => strictCanonicalJsonV1(original)).not.toThrow();
    expect(strictCanonicalJsonV1(shuffled)).toBe(strictCanonicalJsonV1(original));
    expect(strictCanonicalSha256V1(shuffled), `seed ${seed}`).toBe(strictCanonicalSha256V1(original));
  });

  it("has the same canonical bytes and digest in a separate Node process", () => {
    const value = { z: [{ b: "two", a: 1 }], a: { "10": false, "2": true } };
    const fixture = fileURLToPath(new URL("./canonical-cross-process-fixture.ts", import.meta.url));
    const output = execFileSync(process.execPath, ["--import", "tsx", fixture, JSON.stringify(value)], {
      encoding: "utf8"
    }).trim();

    expect(JSON.parse(output)).toEqual({
      canonical: strictCanonicalJsonV1(value),
      digest: strictCanonicalSha256V1(value)
    });
  });

  it("rejects every ambiguous shape from a reproducible fuzz corpus", () => {
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "value", { enumerable: true, get: () => 1 });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const prototype = Object.create({ inherited: true }) as Record<string, unknown>;
    prototype.own = 1;
    const cases: Array<[string, unknown, RegExp]> = [
      ["undefined", undefined, /undefined/i],
      ["NaN", NaN, /non-finite/i],
      ["infinity", Infinity, /non-finite/i],
      ["accessor", accessor, /accessor/i],
      ["cycle", cycle, /cyclic/i],
      ["prototype", prototype, /non-plain/i]
    ];

    for (const [label, input, message] of cases) {
      expect(() => strictCanonicalJsonV1(input), label).toThrow(message);
    }
  });

  it("sorts object keys recursively", () => {
    const first = {
      z: { beta: 2, alpha: 1 },
      a: { nested: { right: true, left: false } }
    };
    const second = {
      a: { nested: { left: false, right: true } },
      z: { alpha: 1, beta: 2 }
    };
    const expected = '{"a":{"nested":{"left":false,"right":true}},"z":{"alpha":1,"beta":2}}';

    expect(strictCanonicalJsonV1(first)).toBe(expected);
    expect(strictCanonicalJsonV1(second)).toBe(expected);
  });

  it("sorts integer-like and magic object keys lexicographically", () => {
    const value = JSON.parse('{"2":"two","10":"ten","__proto__":{"safe":true},"a":"letter"}') as unknown;

    expect(strictCanonicalJsonV1(value)).toBe('{"10":"ten","2":"two","__proto__":{"safe":true},"a":"letter"}');
  });

  it("preserves array order while sorting objects inside arrays", () => {
    expect(strictCanonicalJsonV1({ items: [3, 1, { z: "last", a: "first" }] })).toBe(
      '{"items":[3,1,{"a":"first","z":"last"}]}'
    );
    expect(strictCanonicalJsonV1([1, 2, 3])).not.toBe(strictCanonicalJsonV1([3, 2, 1]));
  });

  it("rejects undefined at the root, in objects, in arrays, and in sparse arrays", () => {
    const sparse = new Array<unknown>(1);

    expect(() => strictCanonicalJsonV1(undefined)).toThrow(/undefined/i);
    expect(() => strictCanonicalJsonV1({ nested: { value: undefined } })).toThrow(/undefined/i);
    expect(() => strictCanonicalJsonV1(["present", undefined])).toThrow(/undefined/i);
    expect(() => strictCanonicalJsonV1(sparse)).toThrow(/undefined/i);
  });

  it("rejects bigint values", () => {
    expect(() => strictCanonicalJsonV1({ nested: 1n })).toThrow(/bigint/i);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects the non-finite number %s",
    (value) => {
      expect(() => strictCanonicalJsonV1({ value })).toThrow(/non-finite/i);
    }
  );

  it("rejects object and array cycles", () => {
    const objectCycle: Record<string, unknown> = {};
    objectCycle.self = objectCycle;
    const arrayCycle: unknown[] = [];
    arrayCycle.push(arrayCycle);

    expect(() => strictCanonicalJsonV1(objectCycle)).toThrow(/cyclic/i);
    expect(() => strictCanonicalJsonV1(arrayCycle)).toThrow(/cyclic/i);
  });

  it("rejects non-plain objects", () => {
    class Example {
      value = 1;
    }

    for (const value of [new Date(0), new Map<string, string>(), new Example()]) {
      expect(() => strictCanonicalJsonV1(value)).toThrow(/non-plain/i);
    }
  });

  it("rejects non-JSON primitive types instead of silently dropping them", () => {
    expect(() => strictCanonicalJsonV1(Symbol("value"))).toThrow(/unsupported type/i);
    expect(() => strictCanonicalJsonV1({ value: () => "hidden" })).toThrow(/unsupported type/i);
  });

  it("uses a fixed v1 domain and separates bare, alternate-domain, and alternate-version hashes", () => {
    const value = { a: 1 };
    const canonical = strictCanonicalJsonV1(value);
    const digest = strictCanonicalSha256V1(value);
    const hashFrame = (domain: string): string =>
      createHash("sha256").update(`${domain}\0${canonical}`, "utf8").digest("hex");

    expect(STRICT_CANONICAL_SHA256_V1_DOMAIN).toBe("agent-control-stack/strict-canonical-json/sha256/v1");
    expect(digest).toBe(hashFrame(STRICT_CANONICAL_SHA256_V1_DOMAIN));
    expect(digest).not.toBe(createHash("sha256").update(canonical, "utf8").digest("hex"));
    expect(digest).not.toBe(hashFrame("other-product/strict-canonical-json/sha256/v1"));
    expect(digest).not.toBe(hashFrame("agent-control-stack/strict-canonical-json/sha256/v2"));
  });

  it("matches the published v1 SHA-256 fixed vector", () => {
    const value = { z: { b: 2, a: 1 }, a: [3, 2, 1] };

    expect(strictCanonicalJsonV1(value)).toBe('{"a":[3,2,1],"z":{"a":1,"b":2}}');
    expect(strictCanonicalSha256V1(value)).toBe("4d103b25ab1a14ceb5d9a62b67ad7f1d30634a5ba9ca34046c00ec8ff45eb0e1");
  });

  it("preserves the legacy stableHash undefined semantics and digest", () => {
    const legacyValue = { z: undefined, a: [undefined, { b: 2, a: 1 }] };

    expect(canonicalJson(legacyValue)).toBe('{"a":[null,{"a":1,"b":2}]}');
    expect(stableHash(legacyValue)).toBe("613668c0c720f4bd86dba076197de6d614c0a32820aeede2b0d943b69ac82b7c");
  });
});
