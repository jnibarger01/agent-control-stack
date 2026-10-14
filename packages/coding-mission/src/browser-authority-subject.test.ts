import { executionPlanSubjectInputHash } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { MissionAuthorityLedger } from "./child-work.js";
import { parseWorkUnitPayload } from "./mission-model.js";
import { ACTOR, setupRealGrants } from "./child-work-real-grants-fixture.js";

const ORIGIN = "https://app.example";
const browserTool = {
  runtime: "browser" as const,
  toolName: "cua" as const,
  allowedOrigins: [ORIGIN],
  allowedApplications: ["browser"]
};

/**
 * The browser-boundary re-check must compare the live grant's subject hash with the mission's current execution
 * inputs, as dispatch does. A real human-issued grant is read through the real store; only the subject-hash reader is
 * wrapped so the test can change the mission's inputs after dispatch.
 */
describe("browser authority verdict: grant subject binding", () => {
  function world() {
    const f = setupRealGrants({
      cuaRootPayload: { kind: "cua", objective: "look", allowedOrigins: [ORIGIN], allowedApplications: ["browser"] },
      extraToolClasses: [browserTool]
    });
    const subject: { override?: string | null } = {};
    const ledger = new MissionAuthorityLedger(f.missions, {
      grants: {
        getAutonomousAuthority: (grantId) => f.items.getAutonomousAuthority(grantId),
        currentSubjectInputHash: (missionId) => {
          if (subject.override === null) throw new Error("subject unavailable");
          if (subject.override !== undefined) return subject.override;
          const item = f.items.get(missionId);
          return item ? executionPlanSubjectInputHash(item) : undefined;
        }
      },
      verifyOperator: () => false,
      clock: () => f.state.now,
      resolveActor: () => ACTOR
    });
    ledger.grantMissionAuthority({ missionId: f.item.id, grantId: f.grant.grantId });
    const verdict = () =>
      ledger.browserAuthorityVerdict({
        missionId: f.item.id,
        unitId: "root",
        origins: [ORIGIN],
        applications: ["browser"],
        deadlineAt: f.iso(10_000)
      });
    return { verdict, subject };
  }

  it("allows the attempt while the subject hash still matches the grant", () => {
    expect(world().verdict()).toEqual({ ok: true });
  });

  it("refuses once the mission's execution inputs no longer match the grant's subject hash", () => {
    const w = world();
    expect(w.verdict()).toEqual({ ok: true });
    w.subject.override = "b".repeat(64);
    expect(w.verdict()).toEqual({ ok: false, reason: "cua_authority_subject_changed" });
  });

  it("refuses when the current subject hash cannot be read", () => {
    const w = world();
    w.subject.override = null;
    expect(w.verdict()).toEqual({ ok: false, reason: "cua_authority_subject_changed" });
  });
});

describe("cua work-unit origins: trailing-dot and non-ASCII hosts (S1)", () => {
  const payload = (origin: string) => ({ kind: "cua", objective: "look", allowedOrigins: [origin] });
  it("rejects a trailing-dot or non-ASCII host and accepts an exact ASCII origin", () => {
    for (const origin of ["https://app.example.", "https://bücher.example", "https://аpp.example"])
      expect(() => parseWorkUnitPayload("cua", payload(origin)), origin).toThrow();
    expect(parseWorkUnitPayload("cua", payload(ORIGIN))).toMatchObject({ allowedOrigins: [ORIGIN] });
  });
});
