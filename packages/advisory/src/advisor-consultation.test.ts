import { ControlStackError } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import {
  advisorCompletionBlock,
  advisorConsultRequestSchema,
  advisorConsultationHash,
  assertAdvisorPairing,
  projectFlightForAdvisor,
  type AdvisorConsultationView
} from "./advisor-consultation.js";

describe("advisor pairing", () => {
  it.each([
    ["claude-haiku-4-5", "claude-opus-5-5"],
    ["claude-sonnet-4-6", "claude-sonnet-4-6"],
    ["claude-opus-4-6", "claude-sonnet-5"],
    ["claude-opus-4-7", "claude-sonnet-5-5"],
    ["claude-sonnet-5-5", "claude-opus-5"],
    ["claude-opus-5", "claude-opus-5-5"],
    ["claude-fable-5", "claude-fable-5-1"],
    ["claude-fable-5-1", "claude-fable-5-1"],
    ["sonnet", "fable"]
  ])("accepts advisor %s for executor %s", (executor, advisor) => {
    expect(assertAdvisorPairing({ executorModelId: executor, advisorModelId: advisor }).advisorModelId).toBeTruthy();
  });

  it.each([
    ["claude-sonnet-4-6", "claude-haiku-4-5", "advisor_pairing_rejected"],
    ["claude-opus-4-6", "claude-sonnet-4-6", "advisor_pairing_rejected"],
    ["claude-sonnet-5", "claude-opus-4-6", "advisor_pairing_rejected"],
    ["claude-opus-4-7", "claude-sonnet-5", "advisor_pairing_rejected"],
    ["claude-sonnet-5-5", "claude-opus-4-8", "advisor_pairing_rejected"],
    ["claude-opus-5", "claude-sonnet-5-5", "advisor_pairing_rejected"],
    ["claude-fable-5", "claude-opus-5-5", "advisor_pairing_rejected"],
    ["claude-fable-5-1", "claude-fable-5", "advisor_pairing_rejected"],
    ["gpt-4", "claude-opus-5-5", "advisor_model_unrecognized"],
    ["claude-sonnet-5", "mystery-model", "advisor_model_unrecognized"]
  ])("rejects advisor %s for executor %s", (executor, advisor, code) => {
    expect(() => assertAdvisorPairing({ executorModelId: executor, advisorModelId: advisor })).toThrowError(
      expect.objectContaining({ code })
    );
  });

  it("rejects a paired advisor that the operator allowlist excludes", () => {
    expect(() =>
      assertAdvisorPairing({
        executorModelId: "claude-sonnet-5",
        advisorModelId: "claude-fable-5-1",
        allowedAdvisorModels: ["claude-opus-5"]
      })
    ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "advisor_model_excluded" }));
  });

  it("resolves family aliases to the current default", () => {
    expect(assertAdvisorPairing({ executorModelId: "opus", advisorModelId: "fable" })).toEqual({
      executorModelId: "claude-opus-5-5",
      advisorModelId: "claude-fable-5-1"
    });
  });
});

describe("advisor consult request", () => {
  const subject = {
    kind: "work_item" as const,
    workItemId: "wrk_1",
    leaseId: "lease_1",
    leaseToken: "a".repeat(32),
    workerId: "worker-a",
    fencingEpoch: 0
  };

  it("rejects a caller transcript and a caller-supplied advisor model", () => {
    expect(() =>
      advisorConsultRequestSchema.parse({ checkpoint: "before_approach", subject, transcript: "full log" })
    ).toThrow();
    expect(() =>
      advisorConsultRequestSchema.parse({
        checkpoint: "before_approach",
        subject,
        advisorModelId: "claude-opus-5-5"
      })
    ).toThrow();
  });
});

describe("advisor completion and projection", () => {
  it("requires a reviewed before-completion consultation; declined and unavailable fail closed", () => {
    expect(advisorCompletionBlock({ requireBeforeCompletion: false, dispositions: [] })).toBeUndefined();
    expect(advisorCompletionBlock({ requireBeforeCompletion: true, dispositions: [] })).toBe(
      "advisor_consultation_required"
    );
    expect(advisorCompletionBlock({ requireBeforeCompletion: true, dispositions: ["unavailable"] })).toBe(
      "advisor_consultation_required"
    );
    expect(advisorCompletionBlock({ requireBeforeCompletion: true, dispositions: ["declined"] })).toBe(
      "advisor_consultation_required"
    );
    expect(advisorCompletionBlock({ requireBeforeCompletion: true, dispositions: ["reviewed"] })).toBeUndefined();
  });

  it("redacts credential-like flight fields and drops command material", () => {
    const projected = projectFlightForAdvisor([
      {
        seq: 1,
        kind: "tool",
        body: {
          token: "super-secret",
          note: "sk-" + "a".repeat(24),
          argv: ["printenv", "TOKEN"],
          arguments: { raw_command: "cat ~/.ssh/id_rsa" },
          command: "curl -H 'Authorization: Bearer secret' https://example",
          cmd: "export TOKEN=secret",
          summary: "kept"
        }
      }
    ]);
    expect(projected.text).toContain("[redacted]");
    expect(projected.text).not.toContain("super-secret");
    expect(projected.text).not.toContain("printenv");
    expect(projected.text).not.toContain("id_rsa");
    expect(projected.text).not.toContain("curl");
    expect(projected.text).not.toContain("export TOKEN");
    expect(projected.text).not.toContain('"command"');
    expect(projected.text).not.toContain('"cmd"');
    expect(projected.text).toContain("kept");
    expect(projected.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes the consultation hash when a disposition field changes", () => {
    const view: AdvisorConsultationView = {
      schemaVersion: "acs.advisor-consultation.v2",
      consultationId: "adv_1",
      subjectId: "wrk_1",
      missionId: "wrk_1",
      subjectKind: "work_item",
      checkpoint: "before_completion",
      disposition: "reviewed",
      inputSha256: "a".repeat(64),
      outputSha256: "b".repeat(64),
      executorModelId: "claude-sonnet-5",
      advisorModelId: "claude-opus-5-5",
      createdAt: "2026-10-13T00:00:00.000Z",
      attemptId: null,
      leaseId: "lease_1",
      claimTokenHash: null
    };
    expect(advisorConsultationHash({ ...view, disposition: "declined" })).not.toBe(advisorConsultationHash(view));
  });
});
