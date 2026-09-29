import { describe, expect, it } from "vitest";
import { LOCAL_BINARY_CAPABILITY, observeCapability } from "./contracts/capability.js";
import { classifyJev, noul } from "./index.js";
import { runJevIntake } from "./intake.js";

const INTAKE = {
  schemaVersion: "acs.mission-intake.v1" as const,
  requestId: "req-shadow-0001",
  title: "Fix flaky test",
  goal: "fix the flaky vitest test in packages/work-items",
  origin: "cli" as const,
  target: { files: [] as string[] },
  proposedActions: [
    { clientActionId: "action-0001", kind: "shell", description: "run tests", params: { command: "npx vitest run" } }
  ],
  constraints: { network: "none" as const, maxRuntimeMs: 600000, successCriteria: ["tests pass"] }
};

function answerBody(probabilities: Record<string, number>) {
  return {
    model: "jevos-q4_k_m",
    answers: Object.fromEntries(Object.entries(probabilities).map(([name, noul]) => [name, { type: "noul", noul }])),
    usage: { prompt_tokens: 1, completion_tokens: 1 }
  };
}

function mockFetch(body: unknown, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("decision responses do not invent capability flags", () => {
  it("leaves supportsNoul absent when /v1/systemone omits it", () => {
    const observed = observeCapability({
      model: "jevos-q4_k_m",
      answers: { actionable: { type: "noul", noul: 0.8 } },
      usage: {}
    });
    expect(observed.supportsNoul).toBeUndefined();
    expect(observed.supportsChoice).toBeUndefined();
    expect(observed.supportsScore).toBeUndefined();
    expect(LOCAL_BINARY_CAPABILITY.supportsNoul).toBe(true);
  });

  it("accepts a systemone body that only has model, answers, and usage", async () => {
    const result = await classifyJev(
      "state",
      { actionable: noul("q?") },
      { fetchImpl: mockFetch(answerBody({ actionable: 0.9 })), enabled: true }
    );
    expect(result.degraded).toBe(false);
    expect(result.failureReason).toBeUndefined();
    expect(result.signals.actionable?.probability).toBe(0.9);
  });

  it("rejects an explicit noul:false advertisement without treating omission as false", async () => {
    const result = await classifyJev(
      "state",
      { actionable: noul("q?") },
      {
        fetchImpl: mockFetch({ ...answerBody({ actionable: 0.9 }), supportsNoul: false }),
        enabled: true
      }
    );
    expect(result.failureReason).toBe("INCOMPATIBLE_MODEL");
    expect(result.degraded).toBe(true);
    expect(result.signals).toEqual({});
  });
});

describe("shadow intake failure modes do not change the supplied classifier snapshot", () => {
  const classifier = {
    taskType: "coding",
    risk: "write",
    authoritative: false,
    classifier: "mission-router-compat"
  };

  async function shadow(
    fetchImpl: typeof fetch,
    extra: { capabilityProfile?: typeof LOCAL_BINARY_CAPABILITY; timeoutMs?: number } = {}
  ) {
    const before = { ...classifier };
    const intake = await runJevIntake(INTAKE.goal, before, {
      fetchImpl,
      enabled: true,
      timeoutMs: extra.timeoutMs,
      ...(extra.capabilityProfile ? { capabilityProfile: extra.capabilityProfile } : {})
    });
    return { before, intake };
  }

  it("UNAVAILABLE", async () => {
    const { before, intake } = await shadow(async () => {
      throw new TypeError("fetch failed");
    });
    expect(intake.status).toBe("UNAVAILABLE");
    expect(intake.probabilities).toEqual({});
    expect(intake.classifier).toBe(before);
    expect(intake.classifier).toEqual(classifier);
  });

  it("TIMEOUT", async () => {
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    const { before, intake } = await shadow(fetchImpl, { timeoutMs: 5 });
    expect(intake.status).toBe("TIMEOUT");
    expect(intake.classifier).toBe(before);
    expect(intake.classifier).toEqual(classifier);
  });

  it("NO_ADVICE", async () => {
    const { before, intake } = await shadow(mockFetch({ model: "jevos-q4_k_m", answers: {} }));
    expect(intake.status).toBe("NO_ADVICE");
    expect(intake.classifier).toBe(before);
    expect(intake.classifier).toEqual(classifier);
  });

  it("INCOMPATIBLE_MODEL", async () => {
    const { before, intake } = await shadow(mockFetch(answerBody({ actionable: 0.2 })), {
      capabilityProfile: { ...LOCAL_BINARY_CAPABILITY, supportsNoul: false }
    });
    expect(intake.status).toBe("INCOMPATIBLE_MODEL");
    expect(intake.classifier).toBe(before);
    expect(intake.classifier).toEqual(classifier);
  });

  it("records advice on success and leaves the classifier unchanged", async () => {
    const probabilities = Object.fromEntries(
      Object.keys({
        actionable: 1,
        needs_code: 1,
        needs_shell: 1,
        needs_browser: 1,
        needs_mobile: 1,
        needs_desktop: 1,
        destructive: 1,
        auth_sensitive: 1,
        runtime_mutation: 1,
        approval_likely: 1
      }).map((name) => [name, name === "needs_code" ? 0.91 : 0.1])
    );
    const { before, intake } = await shadow(mockFetch(answerBody(probabilities)));
    expect(intake.status).toBe("ok");
    expect(intake.model).toBe("jevos-q4_k_m");
    expect(intake.questionSetVersion).toBe("jev-intake@2");
    expect(intake.promptVersion).toBe("binary");
    expect(intake.probabilities.needsCode).toBe(0.91);
    expect(intake.probabilities.actionable).toBe(0.1);
    expect(intake.classifier).toBe(before);
    expect(intake.classifier).toEqual(classifier);
  });
});
