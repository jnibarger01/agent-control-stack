import { missionUnitSubjectId } from "@agent-control-stack/advisory";
import { ControlStackError } from "@agent-control-stack/shared";
import { enableAdvisorBinding, insertAdvisorConsultation } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { CodingMissionStore } from "./store.js";

const T0 = "2026-10-13T00:00:00.000Z";

function runningUnit() {
  const store = new CodingMissionStore(":memory:");
  store.createGeneral({ missionId: "m1", summary: "s", now: T0 });
  store.addWorkUnits("m1", [{ unitId: "u", kind: "coding", title: "u" }], T0);
  const claim = { token: "tok-1", workerId: "w1", route: { workerId: "w1" }, claimedAt: T0 };
  expect(store.claimUnit("m1", "u", claim)).toMatchObject({ ok: true });
  return { store, claim };
}

describe("mission unit advisor completion", () => {
  it("completes a unit that has no advisor binding", () => {
    const { store, claim } = runningUnit();
    store.completeOperation("m1", "u", claim.token, { resultHash: "h", files: [] }, T0);
    expect(store.workUnits("m1")[0]?.status).toBe("succeeded");
    store.close();
  });

  it("fails closed when a required before-completion consultation is missing", () => {
    const { store, claim } = runningUnit();
    enableAdvisorBinding(store.db, {
      subjectId: missionUnitSubjectId("m1", "u"),
      missionId: "m1",
      subjectKind: "mission_unit",
      executorModelId: "claude-sonnet-5",
      advisorModelId: "claude-opus-5-5",
      requireBeforeCompletion: true,
      now: T0
    });
    expect(() => store.completeOperation("m1", "u", claim.token, { resultHash: "h", files: [] }, T0)).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "advisor_consultation_required" })
    );
    expect(store.workUnits("m1")[0]?.status).toBe("running");
    insertAdvisorConsultation(store.db, {
      subjectId: missionUnitSubjectId("m1", "u"),
      missionId: "m1",
      subjectKind: "mission_unit",
      checkpoint: "before_completion",
      disposition: "reviewed",
      inputSha256: "a".repeat(64),
      guidanceText: "keep the unit small",
      declineReason: null,
      errorCode: null,
      executorModelId: "claude-sonnet-5",
      advisorModelId: "claude-opus-5-5",
      inputTokens: null,
      outputTokens: null,
      createdAt: T0,
      fence: { kind: "mission_unit", missionId: "m1", unitId: "u", workerId: "w1", claimToken: claim.token }
    });
    store.completeOperation("m1", "u", claim.token, { resultHash: "h", files: [] }, T0);
    expect(store.workUnits("m1")[0]?.status).toBe("succeeded");
    store.close();
  });

  it("rejects a binding or consultation whose subject is not the mission unit key", () => {
    const { store, claim } = runningUnit();
    expect(() =>
      enableAdvisorBinding(store.db, {
        subjectId: "u",
        missionId: "m1",
        subjectKind: "mission_unit",
        executorModelId: "claude-sonnet-5",
        advisorModelId: "claude-opus-5-5",
        requireBeforeCompletion: false,
        now: T0
      })
    ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "advisor_binding_mission_mismatch" }));
    expect(() =>
      insertAdvisorConsultation(store.db, {
        subjectId: "u",
        missionId: "m1",
        subjectKind: "mission_unit",
        checkpoint: "before_approach",
        disposition: "reviewed",
        inputSha256: "a".repeat(64),
        guidanceText: "no",
        declineReason: null,
        errorCode: null,
        executorModelId: "claude-sonnet-5",
        advisorModelId: "claude-opus-5-5",
        inputTokens: null,
        outputTokens: null,
        createdAt: T0,
        fence: { kind: "mission_unit", missionId: "m1", unitId: "u", workerId: "w1", claimToken: claim.token }
      })
    ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "advisor_lease_stale" }));
    store.close();
  });

  it("does not let a consultation recorded under an earlier claim satisfy a retried unit", () => {
    const { store, claim } = runningUnit();
    bindRequired(store);
    reviewed(store, claim.token);
    store.markOperation("m1", "u", "failed");
    expect(store.retryUnit("m1", "u", T0)).toMatchObject({ ok: true });
    const second = { token: "tok-2", workerId: "w1", route: { workerId: "w1" }, claimedAt: T0 };
    expect(store.claimUnit("m1", "u", second)).toMatchObject({ ok: true });
    expect(() => store.completeOperation("m1", "u", second.token, { resultHash: "h", files: [] }, T0)).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "advisor_consultation_required" })
    );
    reviewed(store, second.token);
    store.completeOperation("m1", "u", second.token, { resultHash: "h", files: [] }, T0);
    expect(store.workUnits("m1")[0]?.status).toBe("succeeded");
    store.close();
  });

  it("does not let a declined before-completion consultation satisfy the gate", () => {
    const { store, claim } = runningUnit();
    bindRequired(store);
    insertAdvisorConsultation(store.db, {
      ...consultation(claim.token),
      disposition: "declined",
      guidanceText: null,
      declineReason: "advisor declined"
    });
    expect(() => store.completeOperation("m1", "u", claim.token, { resultHash: "h", files: [] }, T0)).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "advisor_consultation_required" })
    );
    store.close();
  });

  it("fails closed when a binding row is edited to require_before_completion = 0", () => {
    const { store, claim } = runningUnit();
    bindRequired(store);
    store.db.exec("UPDATE advisor_bindings SET require_before_completion = 0");
    expect(() => store.completeOperation("m1", "u", claim.token, { resultHash: "h", files: [] }, T0)).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "advisor_binding_integrity_mismatch" })
    );
    expect(store.workUnits("m1")[0]?.status).toBe("running");
    store.close();
  });

  it("fails closed when a binding row is disabled out of band", () => {
    const { store, claim } = runningUnit();
    bindRequired(store);
    store.db.exec(`UPDATE advisor_bindings SET disabled_at = '${T0}'`);
    expect(() => store.completeOperation("m1", "u", claim.token, { resultHash: "h", files: [] }, T0)).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "advisor_binding_integrity_mismatch" })
    );
    store.close();
  });

  it("fails closed when a stored consultation row is tampered", () => {
    const { store, claim } = runningUnit();
    bindRequired(store);
    insertAdvisorConsultation(store.db, {
      ...consultation(claim.token),
      disposition: "declined",
      guidanceText: null,
      declineReason: "advisor declined"
    });
    store.db.exec("DROP TRIGGER advisor_consultations_no_update");
    store.db.exec(
      "UPDATE advisor_consultations SET disposition = 'reviewed', guidance_text = 'forged', decline_reason = NULL"
    );
    expect(() => store.completeOperation("m1", "u", claim.token, { resultHash: "h", files: [] }, T0)).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "advisor_consultation_integrity_mismatch" })
    );
    store.close();
  });

  it("refuses to delete a binding row", () => {
    const { store } = runningUnit();
    bindRequired(store);
    expect(() => store.db.exec("DELETE FROM advisor_bindings")).toThrow(/cannot be deleted/);
    store.close();
  });

  it("stores a derived mission-unit subject id longer than 256 characters", () => {
    const store = new CodingMissionStore(":memory:");
    const missionId = "m".repeat(128);
    const unitId = "u".repeat(128);
    store.createGeneral({ missionId, summary: "s", now: T0 });
    store.addWorkUnits(missionId, [{ unitId, kind: "coding", title: "u" }], T0);
    const subjectId = missionUnitSubjectId(missionId, unitId);
    expect(subjectId.length).toBeGreaterThan(256);
    const binding = enableAdvisorBinding(store.db, {
      subjectId,
      missionId,
      subjectKind: "mission_unit",
      executorModelId: "claude-sonnet-5",
      advisorModelId: "claude-opus-5-5",
      requireBeforeCompletion: true,
      now: T0
    });
    expect(binding.subjectId).toBe(subjectId);
    store.close();
  });
});

function bindRequired(store: CodingMissionStore) {
  enableAdvisorBinding(store.db, {
    subjectId: missionUnitSubjectId("m1", "u"),
    missionId: "m1",
    subjectKind: "mission_unit",
    executorModelId: "claude-sonnet-5",
    advisorModelId: "claude-opus-5-5",
    requireBeforeCompletion: true,
    now: T0
  });
}

function consultation(claimToken: string) {
  return {
    subjectId: missionUnitSubjectId("m1", "u"),
    missionId: "m1",
    subjectKind: "mission_unit" as const,
    checkpoint: "before_completion" as const,
    disposition: "reviewed" as "reviewed" | "declined" | "unavailable",
    inputSha256: "a".repeat(64),
    guidanceText: "keep the unit small" as string | null,
    declineReason: null as string | null,
    errorCode: null,
    executorModelId: "claude-sonnet-5",
    advisorModelId: "claude-opus-5-5",
    inputTokens: null,
    outputTokens: null,
    createdAt: T0,
    fence: { kind: "mission_unit" as const, missionId: "m1", unitId: "u", workerId: "w1", claimToken }
  };
}

function reviewed(store: CodingMissionStore, claimToken: string) {
  insertAdvisorConsultation(store.db, consultation(claimToken));
}
