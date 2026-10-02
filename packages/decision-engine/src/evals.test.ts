import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DecisionModelUnavailable, type NimbleDecisionModel } from "./decide.js";
import { nextMissionAction, type MissionStep } from "./loop.js";
import type { MissionPolicyFacts } from "./loop.js";

type Expectation = {
  status: MissionStep["status"];
  reason?: string;
  selectedOperationId?: string | null;
  authorized?: boolean;
  authorizationReason?: string;
  permitId?: string;
  hasAuthorization: boolean;
  authoritativeModel?: "nimble";
  shadowModel?: "jev" | null;
  shadowDisagreement?: boolean;
  rejectsField?: string;
};

type Fixture = {
  state: unknown;
  cases: Array<{
    name: string;
    answer?: unknown;
    unavailable?: boolean;
    shadow?: { jevChoice: string | null };
    policy: MissionPolicyFacts;
    expect: Expectation;
  }>;
};

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/mission-steps.json", import.meta.url), "utf8")
) as Fixture;

function modelFor(entry: Fixture["cases"][number]): NimbleDecisionModel {
  return {
    id: "nimble",
    version: "2026-10-02",
    answer: () => {
      if (entry.unavailable) throw new DecisionModelUnavailable("fixture model outage");
      return entry.answer;
    }
  };
}

describe("mission-step evaluations", () => {
  for (const entry of fixture.cases) {
    it(entry.name, async () => {
      const step = await nextMissionAction({
        state: fixture.state,
        model: modelFor(entry),
        createdAt: "2026-10-02T00:00:00.000Z",
        policy: entry.policy,
        shadow: entry.shadow
      });
      expect(step.status).toBe(entry.expect.status);
      if ("reason" in step && entry.expect.reason !== undefined) {
        expect(step.reason).toBe(entry.expect.reason);
      }
      if ("selectedOperationId" in step && entry.expect.selectedOperationId !== undefined) {
        expect(step.selectedOperationId).toBe(entry.expect.selectedOperationId);
      }
      if (entry.expect.selectedOperationId !== undefined && step.status === "ready") {
        expect(step.decision.selectedOperationId).toBe(entry.expect.selectedOperationId);
      }
      expect("authorization" in step).toBe(entry.expect.hasAuthorization);
      if ("authorization" in step && entry.expect.authorized !== undefined) {
        expect(step.authorization.authorized).toBe(entry.expect.authorized);
        if (step.authorization.authorized && entry.expect.permitId !== undefined) {
          expect(step.authorization.permitId).toBe(entry.expect.permitId);
        }
        if (!step.authorization.authorized && entry.expect.authorizationReason !== undefined) {
          expect(step.authorization.reason).toBe(entry.expect.authorizationReason);
        }
      }
      if ("receipt" in step) {
        expect(step.receipt.authoritativeModel).toBe(entry.expect.authoritativeModel ?? "nimble");
        if (entry.expect.shadowModel !== undefined) expect(step.receipt.shadowModel).toBe(entry.expect.shadowModel);
        if (entry.expect.shadowDisagreement !== undefined) {
          expect(step.receipt.shadowDisagreement).toBe(entry.expect.shadowDisagreement);
        }
        if (entry.expect.rejectsField !== undefined) {
          expect(JSON.stringify(step)).not.toContain(entry.expect.rejectsField);
        }
      }
    });
  }

  it("keeps HTTP out of the decision package", () => {
    const sources = readdirSync(new URL(".", import.meta.url)).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")
    );
    for (const name of sources) {
      const source = readFileSync(new URL(name, import.meta.url), "utf8");
      expect(source).not.toContain("api.typesafe.ai");
      expect(source).not.toContain("fetch(");
    }
  });
});
