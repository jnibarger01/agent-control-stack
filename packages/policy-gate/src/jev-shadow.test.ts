import { afterEach, describe, expect, it } from "vitest";
import { classifierEvidenceHash, type ClassifierEvidence } from "@agent-control-stack/work-items";
import { classifyMissionIntake, MISSION_CLASSIFIER_VERSION } from "./mission-classifier.js";
import { JEV_RISK_SIGNALS, JEV_ROUTING_SIGNALS, maybeRunJevShadowAdvisory } from "./jev-shadow.js";

const INTAKE = {
  schemaVersion: "acs.mission-intake.v1" as const,
  requestId: "req-shadow-0001",
  title: "Fix flaky test",
  goal: "fix the flaky vitest test in packages/work-items",
  origin: "cli" as const,
  target: { files: [] },
  proposedActions: [
    {
      clientActionId: "action-0001",
      kind: "shell",
      description: "run tests",
      params: { command: "npx vitest run" }
    }
  ],
  constraints: { network: "none" as const, maxRuntimeMs: 600000, successCriteria: ["tests pass"] }
};

const CONTEXT = { evidenceId: "ev-000000", generatedAt: "2026-09-26T00:00:00.000Z" };

afterEach(() => {
  delete process.env.ACS_JEV_ENABLED;
});

describe("jev shadow advisory", () => {
  it("is fully inert without ACS_JEV_ENABLED", async () => {
    const lines: string[] = [];
    await maybeRunJevShadowAdvisory(INTAKE, { sink: (line) => lines.push(line) });
    expect(lines).toEqual([]);
  });

  it("emits two batched telemetry events (routing then risk) with probabilities only", async () => {
    process.env.ACS_JEV_ENABLED = "1";
    const bodies: { questions: Record<string, string> }[] = [];
    let call = 0;
    const impl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      call += 1;
      const probabilities =
        call === 1
          ? {
              actionable: 0.9,
              needs_code: 0.8,
              needs_shell: 0.7,
              needs_browser: 0.1,
              needs_mobile: 0.02,
              needs_desktop: 0.03
            }
          : { destructive: 0.5, auth_sensitive: 0.2, runtime_mutation: 0.6, approval_likely: 0.4 };
      return new Response(
        JSON.stringify({
          model: "jevos-q4_k_m",
          answers: Object.fromEntries(
            Object.entries(probabilities).map(([name, p]) => [name, { type: "noul", noul: p }])
          )
        }),
        { status: 200 }
      );
    };
    const lines: string[] = [];
    await maybeRunJevShadowAdvisory(INTAKE, { fetchImpl: impl, sink: (line) => lines.push(line) });
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    expect(first.consumer).toBe("mission-router");
    expect(Object.keys(first.signals).sort()).toEqual([...JEV_ROUTING_SIGNALS].sort());
    expect(Object.keys(second.signals).sort()).toEqual([...JEV_RISK_SIGNALS].sort());
    expect(first.degraded).toBeUndefined();
    // no state text leaks into telemetry
    expect(lines.join("\n")).not.toContain(INTAKE.goal);
    // exactly two POSTs, batched per group
    expect(bodies).toHaveLength(2);
    expect(Object.keys(bodies[0].questions).sort()).toEqual([...JEV_ROUTING_SIGNALS].sort());
    expect(Object.keys(bodies[1].questions).sort()).toEqual([...JEV_RISK_SIGNALS].sort());
  });

  it("no-ops on invalid intake shapes and never throws", async () => {
    process.env.ACS_JEV_ENABLED = "1";
    const lines: string[] = [];
    await maybeRunJevShadowAdvisory({ not: "an intake" }, { sink: (line) => lines.push(line) });
    await maybeRunJevShadowAdvisory(undefined, { sink: (line) => lines.push(line) });
    expect(lines).toEqual([]);
  });

  it("swallows sink and jev failures (shadow must never break the request path)", async () => {
    process.env.ACS_JEV_ENABLED = "1";
    const impl: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(
      maybeRunJevShadowAdvisory(INTAKE, {
        fetchImpl: impl,
        sink: () => {
          throw new Error("sink down");
        }
      })
    ).resolves.toBeUndefined();
  });
});

describe("advisory output never feeds authoritative behavior (differential)", () => {
  /**
   * Invariant: authoritative behavior is identical with Jev disabled,
   * unavailable, degraded, or ignored — same classifier evidence, routing
   * decision, policy result, approval requirement, and work-item semantics.
   * Only non-authoritative Jev advisory metadata and Jev telemetry events
   * may differ. We therefore compare the authoritative evidence (and its
   * content hash), not serialized blobs that could contain advisory fields.
   */
  const authoritativeFields = (evidence: ClassifierEvidence) => ({
    taskType: evidence.taskType.recommendation,
    risk: evidence.risk.recommendation,
    sensitivity: evidence.sensitivity.categories,
    classifier: evidence.classifier,
    subjectIntakeHash: evidence.subjectIntakeHash,
    authoritative: evidence.authoritative
  });

  it("authoritative evidence is identical with Jev disabled, unavailable, degraded, and ignored", async () => {
    const jevOk: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          model: "jevos-q4_k_m",
          answers: Object.fromEntries(Object.keys(body.questions).map((name) => [name, { type: "noul", noul: 0.99 }]))
        }),
        { status: 200 }
      );
    };
    const jevDown: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };

    // 1. Jev disabled (default): baseline authoritative behavior.
    delete process.env.ACS_JEV_ENABLED;
    const baseline = classifyMissionIntake(INTAKE, CONTEXT);
    const baselineFields = authoritativeFields(baseline);
    const baselineHash = classifierEvidenceHash(baseline);

    // 2. Jev enabled and healthy: shadow advisory runs around classification.
    process.env.ACS_JEV_ENABLED = "1";
    await maybeRunJevShadowAdvisory(INTAKE, { fetchImpl: jevOk, sink: () => {} });
    const withAdvisor = classifyMissionIntake(INTAKE, CONTEXT);
    expect(authoritativeFields(withAdvisor)).toEqual(baselineFields);
    expect(classifierEvidenceHash(withAdvisor)).toBe(baselineHash);
    expect(withAdvisor.authoritative).toBe(false);
    expect(Object.keys(withAdvisor)).not.toContain("jevAdvisory");

    // 3. Jev enabled but unavailable (degraded): same authoritative behavior.
    await maybeRunJevShadowAdvisory(INTAKE, { fetchImpl: jevDown, sink: () => {} });
    const withDegraded = classifyMissionIntake(INTAKE, CONTEXT);
    expect(authoritativeFields(withDegraded)).toEqual(baselineFields);
    expect(classifierEvidenceHash(withDegraded)).toBe(baselineHash);

    // 4. Advisory results explicitly ignored by the classifier contract: the
    // evidence schema contains no advisory fields at all.
    expect(JSON.stringify(Object.keys(baseline)).toLowerCase()).not.toContain("jev");
    expect(withAdvisor.classifier.version).toBe(MISSION_CLASSIFIER_VERSION);
  });
});
