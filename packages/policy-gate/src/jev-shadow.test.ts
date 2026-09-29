import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CANONICAL_TRACE_EVENT_SCHEMA_VERSION,
  CANONICAL_TRACE_GENESIS_HASH,
  SqliteWorkItemStore,
  canonicalTracePayloadHash,
  classifierEvidenceHash,
  type CanonicalTraceEvent,
  type ClassifierEvidence
} from "@agent-control-stack/work-items";
import { createPolicyEngine } from "./policy.js";
import { createWorkItemTools } from "./tools.js";
import { previewWorkItemPolicy } from "./preview.js";
import { classifyMissionIntake, MISSION_CLASSIFIER_VERSION } from "./mission-classifier.js";
import { classifyJevTrace } from "../../jev-advisor/src/index.js";
import { runJevIntake } from "../../jev-advisor/src/intake.js";
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

function canonicalTraceEvent(workItemId: string): CanonicalTraceEvent {
  const payload = { status: "completed" };
  return {
    schema_version: CANONICAL_TRACE_EVENT_SCHEMA_VERSION,
    event_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    trace_id: "ab".repeat(16),
    span_id: "cd".repeat(8),
    source: { system: "dc", component: "jace-commander", instance: "jc-test", release_sha: "unreleased" },
    class: "evidence",
    kind: "run.completed",
    actor: { id: "jace-commander", type: "system" },
    subject: { work_item_id: workItemId },
    seq: 1,
    prev_hash: CANONICAL_TRACE_GENESIS_HASH,
    ts: "2026-09-28T12:00:00.000Z",
    payload,
    payload_hash: canonicalTracePayloadHash(payload)
  };
}

afterEach(() => {
  delete process.env.ACS_JEV_ENABLED;
});

describe("jev shadow advisory", () => {
  it("is fully inert without ACS_JEV_ENABLED", async () => {
    const lines: string[] = [];
    await maybeRunJevShadowAdvisory(INTAKE, { sink: (line) => lines.push(line) });
    expect(lines).toEqual([]);
  });

  it("emits one correlated telemetry event from one ten-question POST", async () => {
    process.env.ACS_JEV_ENABLED = "1";
    const bodies: Array<{ state: string; questions: Record<string, { type: string }> }> = [];
    const probabilities = {
      actionable: 0.9,
      needs_code: 0.8,
      needs_shell: 0.7,
      needs_browser: 0.1,
      needs_mobile: 0.02,
      needs_desktop: 0.03,
      destructive: 0.5,
      auth_sensitive: 0.2,
      runtime_mutation: 0.6,
      approval_likely: 0.4
    };
    const impl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
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
    await maybeRunJevShadowAdvisory(INTAKE, {
      fetchImpl: impl,
      correlation: { workItemId: "wi-shadow-1" },
      sink: (line) => lines.push(line)
    });
    expect(bodies).toHaveLength(1);
    expect(Object.keys(bodies[0].questions)).toHaveLength(10);
    expect(Object.keys(bodies[0].questions).sort()).toEqual([...JEV_ROUTING_SIGNALS, ...JEV_RISK_SIGNALS].sort());
    expect(Object.values(bodies[0].questions).every((question) => question.type === "noul")).toBe(true);

    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event.consumer).toBe("mission-intake");
    expect(event.question_set_version).toBe("jev-intake@2");
    expect(event.correlation).toEqual({ request_id: INTAKE.requestId, work_item_id: "wi-shadow-1" });
    expect(event.signals).toEqual(probabilities);
    expect(event.deterministic_baseline).toMatchObject({
      classifier_id: "mission-router-compat",
      classifier_version: MISSION_CLASSIFIER_VERSION
    });
    expect(lines[0]).not.toContain(INTAKE.goal);
  });

  it("redacts secret-shaped intake state and never emits it in telemetry", async () => {
    process.env.ACS_JEV_ENABLED = "1";
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWX";
    const secretIntake = {
      ...INTAKE,
      requestId: "req-shadow-secret",
      goal: `fix authentication token=${secret}`
    };
    let requestBody = "";
    const impl: typeof fetch = async (_url, init) => {
      requestBody = String(init?.body);
      const body = JSON.parse(requestBody);
      return new Response(
        JSON.stringify({
          model: "jevos-q4_k_m",
          answers: Object.fromEntries(Object.keys(body.questions).map((name) => [name, { type: "noul", noul: 0.5 }]))
        }),
        { status: 200 }
      );
    };
    const lines: string[] = [];
    await maybeRunJevShadowAdvisory(secretIntake, { fetchImpl: impl, sink: (line) => lines.push(line) });
    expect(requestBody).not.toContain(secret);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(secret);
    expect(lines[0]).not.toContain(secretIntake.goal);
  });

  it("no-ops on invalid intake shapes and never throws", async () => {
    process.env.ACS_JEV_ENABLED = "1";
    const lines: string[] = [];
    await maybeRunJevShadowAdvisory({ not: "an intake" }, { sink: (line) => lines.push(line) });
    await maybeRunJevShadowAdvisory(undefined, { sink: (line) => lines.push(line) });
    expect(lines).toEqual([]);
  });

  it("honors explicit options.enabled=false even when the env gate is on (red-team #2)", async () => {
    process.env.ACS_JEV_ENABLED = "1";
    const lines: string[] = [];
    await maybeRunJevShadowAdvisory(INTAKE, { enabled: false, sink: (line) => lines.push(line) });
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

  it("joins intake and trace advisory telemetry through the canonical work-item identity", async () => {
    process.env.ACS_JEV_ENABLED = "1";
    const lines: string[] = [];
    const impl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          model: "jevos-q4_k_m",
          answers: Object.fromEntries(Object.keys(body.questions).map((name) => [name, { type: "noul", noul: 0.5 }]))
        }),
        { status: 200 }
      );
    };
    await maybeRunJevShadowAdvisory(INTAKE, {
      fetchImpl: impl,
      correlation: { workItemId: "wi-shadow-join" },
      sink: (line) => lines.push(line)
    });
    const intakeEvent = JSON.parse(lines[0]);
    const traceAdvisory = await classifyJevTrace([canonicalTraceEvent("wi-shadow-join")], { enabled: true });
    expect(intakeEvent.correlation.work_item_id).toBe("wi-shadow-join");
    expect(traceAdvisory.telemetry.correlation).toEqual({
      work_item_id: "wi-shadow-join",
      trace_id: "ab".repeat(16)
    });
    expect(traceAdvisory.result).toMatchObject({
      degraded: true,
      failureReason: "INCOMPATIBLE_MODEL"
    });
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

  async function policyApprovalCapabilitySnapshot(): Promise<{
    preview: unknown;
    createdStatus: string;
    claimedStatus: string | null;
    leaseIssued: boolean;
    planBound: boolean;
  }> {
    const dir = mkdtempSync(join(tmpdir(), "acs-jev-authority-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    const policy = createPolicyEngine();
    const draft = {
      title: "Read",
      requester: "user",
      intent: "read a file",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.read", description: "read", params: { paths: ["README.md"] } }],
      risk: "low"
    };
    try {
      const preview = previewWorkItemPolicy(policy, draft);
      const tools = createWorkItemTools(store, policy);
      const created = tools.create_work_item(draft);
      const claimed = tools.claim_next_approved_work_item({ workerId: "worker-jev-regression" });
      return {
        preview,
        createdStatus: created.status,
        claimedStatus: claimed?.status ?? null,
        leaseIssued: typeof claimed?.leaseToken === "string" && claimed.leaseToken.length > 0,
        planBound: typeof claimed?.planHash === "string" && claimed.planHash.length === 64
      };
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("healthy and degraded Jev leave policy, approval, and execution capability behavior unchanged", async () => {
    delete process.env.ACS_JEV_ENABLED;
    const baseline = await policyApprovalCapabilitySnapshot();

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

    process.env.ACS_JEV_ENABLED = "1";
    await maybeRunJevShadowAdvisory(INTAKE, { fetchImpl: jevOk, sink: () => {} });
    const healthy = await policyApprovalCapabilitySnapshot();
    expect(healthy).toEqual(baseline);

    await maybeRunJevShadowAdvisory(INTAKE, { fetchImpl: jevDown, sink: () => {} });
    const degraded = await policyApprovalCapabilitySnapshot();
    expect(degraded).toEqual(baseline);
  });

  it("trace shadow classification cannot change policy, approval, or capability behavior", async () => {
    const baseline = await policyApprovalCapabilitySnapshot();
    const capability = {
      promptVersion: "typed-v1",
      supportsNoul: true,
      supportsChoice: true,
      supportsScore: true,
      fingerprint: "policy-differential"
    };
    const probabilities = {
      healthy: 0.05,
      tool_loop: 0.05,
      budget_burn: 0.05,
      instruction_drift: 0.05,
      verifier_fail: 0.5,
      stagnation: 0.05,
      hallucination: 0.05,
      policy_denied: 0.05,
      worktree_collision: 0.05,
      other: 0.1
    };
    const healthyFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          model: "jev-typed",
          answers: {
            failure_mode: { type: "choice", choice: "verifier_fail", probabilities, confidence: 0.5 },
            should_escalate: { type: "noul", noul: 0.9 },
            needs_maker_checker: { type: "noul", noul: 0.8 },
            context_rot: { type: "noul", noul: 0.2 },
            recovery_urgency: {
              type: "score",
              score: 3.5,
              probabilities: { "0": 0.02, "1": 0.03, "2": 0.1, "3": 0.15, "4": 0.7 },
              confidence: 0.7
            }
          }
        }),
        { status: 200 }
      );

    await classifyJevTrace([canonicalTraceEvent("wi-trace-authority")], {
      enabled: true,
      capabilityProfile: capability,
      fetchImpl: healthyFetch
    });
    expect(await policyApprovalCapabilitySnapshot()).toEqual(baseline);

    await classifyJevTrace([canonicalTraceEvent("wi-trace-authority")], {
      enabled: true,
      capabilityProfile: capability,
      fetchImpl: async () => {
        throw new TypeError("trace observer offline");
      }
    });
    expect(await policyApprovalCapabilitySnapshot()).toEqual(baseline);
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

  it.each([
    [
      "UNAVAILABLE",
      async () => {
        throw new TypeError("fetch failed");
      }
    ],
    [
      "TIMEOUT",
      (_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        })
    ],
    ["NO_ADVICE", async () => new Response(JSON.stringify({ model: "m", answers: {} }), { status: 200 })],
    [
      "INCOMPATIBLE_MODEL",
      async () => new Response(JSON.stringify({ model: "m", supportsNoul: false, answers: {} }), { status: 200 })
    ]
  ] as const)("%s shadow intake does not change authoritative classification", async (status, fetchImpl) => {
    const before = classifyMissionIntake(INTAKE, CONTEXT);
    const intake = await runJevIntake(INTAKE.goal, before, {
      fetchImpl: fetchImpl as typeof fetch,
      enabled: true,
      timeoutMs: 20
    });
    const after = classifyMissionIntake(INTAKE, CONTEXT);
    expect(intake.status).toBe(status);
    expect(authoritativeFields(after)).toEqual(authoritativeFields(before));
    expect(classifierEvidenceHash(after)).toBe(classifierEvidenceHash(before));
    expect(after).toEqual(before);
  });
});
