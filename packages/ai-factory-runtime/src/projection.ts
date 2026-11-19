import type { CodingMissionRecord, CodingMissionStore } from "@agent-control-stack/coding-mission";
import { FACTORY_DRAFT_PR_EFFECT } from "./publish.js";

/**
 * F10: the operator view of a factory mission, projected only from ACS's own recorded state
 * (mission row, work units, budget, effect reservation, plan lineage from the audit log).
 *
 * It never invents status: every stage is derived from a recorded fact, and anything it does not
 * recognise is shown as `unknown`. Free text supplied by callers or planners (objective, titles,
 * criteria) is not projected. The next action is a recommendation and is labelled as such; it never
 * authorizes anything.
 */
export const FACTORY_STAGES = [
  "awaiting_plan",
  "plan_review",
  "pending_dispatch",
  "executing",
  "needs_reconciliation",
  "blocked_integration",
  "failed_gate",
  "verified_awaiting_publication",
  "publication_uncertain",
  "draft_published",
  "cancelled",
  "unknown"
] as const;
export type FactoryStage = (typeof FACTORY_STAGES)[number];

export interface FactoryMissionView {
  missionId: string;
  repository: string;
  /** Immutable base commit the mission was admitted against. */
  pinnedBaseSha: string;
  missionState: string;
  stage: FactoryStage;
  plan: { revision: number; planDigest: string; accepted: boolean } | null;
  units: { unitId: string; status: string; failureCategory: string | null; resultHash: string | null }[];
  budget: { limits: Record<string, number>; usage: Record<string, number> } | null;
  failedGate: string | null;
  publication: { state: "none" | "uncertain" | "published"; url: string | null };
  nextAction: { recommendation: string; authority: "advisory"; requiresHumanApproval: boolean };
}

export function projectFactoryMission(input: {
  mission: CodingMissionRecord;
  units: ReturnType<CodingMissionStore["workUnits"]>;
  budget: ReturnType<CodingMissionStore["budget"]>;
  publication: ReturnType<CodingMissionStore["effect"]>;
  plan: { revision: number; planDigest: string; accepted: boolean } | null;
}): FactoryMissionView {
  const { mission, units, plan } = input;
  const statuses = new Set(units.map((unit) => unit.status));
  const failed = units.find((unit) => unit.status === "failed" || unit.status === "retryable");
  const publicationState: FactoryMissionView["publication"]["state"] = !input.publication
    ? "none"
    : input.publication.outcome === "succeeded"
      ? "published"
      : "uncertain";

  let stage: FactoryStage;
  if (mission.state === "CANCELLED") stage = "cancelled";
  else if (publicationState === "published") stage = "draft_published";
  else if (publicationState === "uncertain") stage = "publication_uncertain";
  else if (units.length === 0) stage = plan ? "plan_review" : "awaiting_plan";
  else if (statuses.has("unknown")) stage = "needs_reconciliation";
  else if (statuses.has("conflict")) stage = "blocked_integration";
  else if (failed) stage = "failed_gate";
  else if (statuses.has("running") || statuses.has("checkpointed") || statuses.has("verifying")) stage = "executing";
  else if (units.every((unit) => unit.status === "succeeded")) stage = "verified_awaiting_publication";
  else if (units.every((unit) => ["pending", "ready", "succeeded"].includes(unit.status))) stage = "pending_dispatch";
  else stage = "unknown";

  const next: Record<FactoryStage, [string, boolean]> = {
    awaiting_plan: ["Submit a plan revision for ACS validation.", false],
    plan_review: ["Review the latest plan revision and accept it by digest.", true],
    pending_dispatch: ["Dispatch ready units; ACS enforces the budget on every claim.", false],
    executing: ["Wait for running attempts; their fences are checked before each mutation.", false],
    needs_reconciliation: ["Reconcile units with unknown effects before any retry; ACS will not replay them.", true],
    blocked_integration: ["Resolve overlapping lane changes; ACS will not choose a winner.", true],
    failed_gate: ["Inspect the failed gate; a retry needs a new decision.", true],
    verified_awaiting_publication: ["Approve publication of the verified head as a draft pull request.", true],
    publication_uncertain: ["Reconcile the draft pull request from the remote before retrying.", true],
    draft_published: ["Review the draft pull request. ACS never merges or deploys.", true],
    cancelled: ["No action. Effects ACS could not prove rolled back are listed as uncertain.", false],
    unknown: ["State is not recognised; inspect the audit trail. Nothing is inferred.", true]
  };
  const [recommendation, requiresHumanApproval] = next[stage];

  return {
    missionId: mission.missionId,
    repository: mission.repository,
    pinnedBaseSha: mission.baseSha,
    missionState: mission.state,
    stage,
    plan,
    units: units.map((unit) => ({
      unitId: unit.unitId,
      status: unit.status,
      failureCategory: unit.failureCategory ?? null,
      resultHash: unit.resultHash ?? null
    })),
    budget: input.budget
      ? {
          limits: Object.fromEntries(Object.entries(input.budget.limits).filter(([, value]) => typeof value === "number")) as Record<string, number>,
          usage: Object.fromEntries(Object.entries(input.budget.usage).filter(([, value]) => typeof value === "number")) as Record<string, number>
        }
      : null,
    failedGate: failed?.failureCategory ?? null,
    publication: { state: publicationState, url: publicationState === "published" ? input.publication?.externalId ?? null : null },
    nextAction: { recommendation, authority: "advisory", requiresHumanApproval }
  };
}

export function factoryPublicationEffect(
  store: Pick<CodingMissionStore, "effect">,
  missionId: string
): ReturnType<CodingMissionStore["effect"]> {
  return store.effect(missionId, FACTORY_DRAFT_PR_EFFECT);
}
