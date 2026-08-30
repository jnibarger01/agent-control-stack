import { describe, expect, it } from "vitest";
import {
  buildEvidenceManifest,
  evidenceManifestHash,
  evidenceManifestSchema,
  verifyEvidenceManifestHash,
  type BuildEvidenceManifestInput
} from "./evidence-manifest.js";

const H = (c: string) => c.repeat(64);

const input: BuildEvidenceManifestInput = {
  attemptId: "attempt_1",
  workItemId: "wrk_1",
  admittedPlanHash: H("a"),
  planHash: H("b"),
  actionHash: H("c"),
  baseWorkspaceRevision: H("d"),
  resultWorkspaceRevision: H("e"),
  changedPaths: ["src/parse.ts", "src/parse.test.ts"],
  diffHash: H("f"),
  commands: [
    { executable: "npm", argvHash: H("1"), exitCode: 0, stdoutHash: H("2"), stderrHash: H("3"), durationMs: 4200 }
  ],
  testEvidence: { validationRunId: "vrun_1", passed: true, checksPassed: 12, checksFailed: 0 },
  sandboxProfile: "desktop_commander",
  networkProfile: "none",
  networkDecisions: { allowed: 0, denied: 0 },
  observations: [],
  workerId: "worker_1",
  startedAt: "2026-08-30T00:00:00.000Z",
  finishedAt: "2026-08-30T00:00:05.000Z"
};

describe("EvidenceManifest", () => {
  it("is content-addressed and immutable (hash matches body)", () => {
    const manifest = buildEvidenceManifest(input);
    expect(manifest.schemaVersion).toBe("acs.evidence-manifest.v1");
    expect(manifest.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyEvidenceManifestHash(manifest)).toBe(true);
  });

  it("any field mutation breaks the content address", () => {
    const manifest = buildEvidenceManifest(input);
    expect(verifyEvidenceManifestHash({ ...manifest, resultWorkspaceRevision: H("9") })).toBe(false);
    expect(verifyEvidenceManifestHash({ ...manifest, changedPaths: [...manifest.changedPaths, "evil.ts"] })).toBe(
      false
    );
    expect(
      verifyEvidenceManifestHash({
        ...manifest,
        commands: [{ ...manifest.commands[0], exitCode: 1 }]
      })
    ).toBe(false);
  });

  it("changedPaths order does not change the hash (canonicalised)", () => {
    const a = buildEvidenceManifest({ ...input, changedPaths: ["a.ts", "b.ts"] });
    const b = buildEvidenceManifest({ ...input, changedPaths: ["b.ts", "a.ts"] });
    expect(a.manifestHash).toBe(b.manifestHash);
  });

  it("a model claim string cannot be smuggled in — the schema is strict and typed", () => {
    const manifest = buildEvidenceManifest(input);
    // No free-text "summary"/"implementerClaim"/"notes" field exists.
    expect("summary" in manifest).toBe(false);
    expect("implementerClaim" in manifest).toBe(false);
    expect(evidenceManifestSchema.safeParse({ ...manifest, implementerClaim: "it works, trust me" }).success).toBe(
      false
    );
    // testEvidence is a typed record, not prose.
    expect(() => buildEvidenceManifest({ ...input, testEvidence: "all green" as never })).toThrow();
  });

  it("recomputed hash matches the documented domain", () => {
    const manifest = buildEvidenceManifest(input);
    const { manifestHash: _h, ...rest } = manifest;
    expect(evidenceManifestHash(rest)).toBe(manifest.manifestHash);
  });
});
