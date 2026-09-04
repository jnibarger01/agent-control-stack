import { describe, expect, it } from "vitest";
import { bindProvenance, provenanceMismatch, type ProvenanceBinding } from "./provenance.js";

const binding: ProvenanceBinding = {
  invocationId: "wi_1",
  upstreamId: "desktop-commander@1.2.3",
  toolName: "read_file",
  toolSchemaFingerprint: "a".repeat(64),
  actionFingerprint: "act_1",
  resultHash: "d".repeat(64)
};

const at = new Date("2026-09-03T00:00:00.000Z");

describe("bindProvenance", () => {
  it("is deterministic and self-hashing", () => {
    const a = bindProvenance(binding, at);
    const b = bindProvenance(binding, at);
    expect(b).toEqual(a);
    expect(a.provenanceHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("provenanceMismatch", () => {
  const bound = bindProvenance(binding, at);
  const expected = {
    invocationId: binding.invocationId,
    upstreamId: binding.upstreamId,
    toolName: binding.toolName,
    toolSchemaFingerprint: binding.toolSchemaFingerprint,
    actionFingerprint: binding.actionFingerprint
  };

  it("returns [] when everything matches", () => {
    expect(provenanceMismatch(bound, expected)).toEqual([]);
  });

  it("reports each mismatched field, fail-closed", () => {
    expect(provenanceMismatch(bound, { ...expected, upstreamId: "x" })).toEqual(["upstreamId"]);
    expect(provenanceMismatch(bound, { ...expected, toolName: "x" })).toEqual(["toolName"]);
    expect(provenanceMismatch(bound, { ...expected, invocationId: "x" })).toEqual(["invocationId"]);
    expect(provenanceMismatch(bound, { ...expected, actionFingerprint: "x" })).toEqual(["actionFingerprint"]);
    expect(provenanceMismatch(bound, { ...expected, toolSchemaFingerprint: "x" })).toEqual(["toolSchemaFingerprint"]);
  });

  it("detects a tampered provenanceHash", () => {
    const tampered = { ...bound, provenanceHash: "0".repeat(64) };
    expect(provenanceMismatch(tampered, expected)).toContain("provenanceHash");
  });

  it("detects a tampered field even if provenanceHash is left stale", () => {
    const tampered = { ...bound, upstreamId: "evil" };
    const fields = provenanceMismatch(tampered, expected);
    expect(fields).toContain("upstreamId");
    expect(fields).toContain("provenanceHash");
  });

  it("flags an expectedResultHash mismatch", () => {
    expect(provenanceMismatch(bound, { ...expected, expectedResultHash: "e".repeat(64) })).toEqual(["resultHash"]);
  });
});
