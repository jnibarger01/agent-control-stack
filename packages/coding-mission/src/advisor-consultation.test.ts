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

  it("rejects a consultation whose subject is not the mission unit key", () => {
    const { store, claim } = runningUnit();
    enableAdvisorBinding(store.db, {
      subjectId: "u",
      missionId: "m1",
      subjectKind: "mission_unit",
      executorModelId: "claude-sonnet-5",
      advisorModelId: "claude-opus-5-5",
      requireBeforeCompletion: false,
      now: T0
    });
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
});
