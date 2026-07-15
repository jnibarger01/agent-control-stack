import { describe, expect, it } from "vitest";
import { canonicalJson, domainHash } from "./hash.js";

describe("canonical domain hashes", () => {
  it("uses one fixed canonical JSON representation", () => {
    expect(canonicalJson({ z: 1, nested: { b: 2, a: 1 }, array: [1, undefined, 3], omitted: undefined })).toBe(
      '{"array":[1,null,3],"nested":{"a":1,"b":2},"z":1}'
    );
  });

  it("matches a fixed cross-language SHA-256 vector and separates domains", () => {
    const value = { schemaVersion: "example.v1", nested: { b: 2, a: 1 } };
    expect(domainHash("acs:test:v1", value)).toBe("0804e875dee2200e586482c130eae296d29236eb3fce6c57bbfcbdf235f1e6d6");
    expect(domainHash("acs:test:v2", value)).not.toBe(domainHash("acs:test:v1", value));
  });
});
