import { describe, expect, it } from "vitest";
import { type AdvisorRequest } from "@agent-control-stack/local-advisor";
import { createAdvise } from "./advise.js";

const ENVELOPE = `sha256:${"b".repeat(64)}`;

const request = {
  schemaVersion: "advisor.v1",
  requestId: "req-1",
  operation: "review_plan",
  mission: { id: "mission-1", envelopeHash: ENVELOPE },
  context: { objective: "Review", constraints: [], evidence: [{ id: "diff-1", kind: "diff", content: "x" }] },
  budget: { timeoutMs: 60_000, maxOutputTokens: 128 }
} as unknown as AdvisorRequest;

/** A listener that accepts the request and then never answers, only honoring abort. */
const stalledFetch = ((_input: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  })) as unknown as typeof fetch;

describe("createAdvise: route discovery deadline", () => {
  it("aborts discovery against a stalled listener even when the caller signal never fires", async () => {
    const advise = createAdvise({}, { fetchImpl: stalledFetch, discoveryTimeoutMs: 50 });
    const started = Date.now();
    await expect(advise(request, new AbortController().signal)).rejects.toMatchObject({ kind: "aborted" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("createAdvise: startup validation", () => {
  it("rejects invalid ACS_LOCAL_ADVISOR_ROUTES when created, not on first call", () => {
    expect(() => createAdvise({ ACS_LOCAL_ADVISOR_ROUTES: "{not json" })).toThrow();
    expect(() => createAdvise({ ACS_LOCAL_ADVISOR_ROUTES: JSON.stringify([{ bogus: true }]) })).toThrow();
  });

  it.each([
    { ACS_LOCAL_ADVISOR_EXPECTED_DIGEST: "sha256:zz" },
    { ACS_LOCAL_ADVISOR_BASE_URL: "http://evil.example" },
    { ACS_LOCAL_ADVISOR_BASE_URL: "not a url" },
    { ACS_LOCAL_ADVISOR_MIN_FREE_BYTES: "abc" },
    { ACS_LOCAL_ADVISOR_MIN_FREE_BYTES: "-1" },
    { ACS_LOCAL_ADVISOR_MIN_FREE_BYTES: "1.5" }
  ])("rejects invalid settings at startup: %j", (env) => {
    expect(() => createAdvise(env)).toThrow();
  });

  it("accepts valid settings at startup", () => {
    expect(() =>
      createAdvise({
        ACS_LOCAL_ADVISOR_EXPECTED_DIGEST: `sha256:${"e".repeat(64)}`,
        ACS_LOCAL_ADVISOR_BASE_URL: "http://127.0.0.1:11434",
        ACS_LOCAL_ADVISOR_MIN_FREE_BYTES: "1073741824"
      })
    ).not.toThrow();
  });
});

describe("createAdvise: provider cache identity", () => {
  it("does not reuse a provider pinned to a different digest for the same model", async () => {
    const installedHex = "c".repeat(64);
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(String(input));
      if (url.pathname === "/api/tags") {
        return new Response(
          JSON.stringify({ models: [{ name: "qwen2.5-coder:7b", digest: installedHex, capabilities: ["completion"] }] })
        );
      }
      return new Response(
        JSON.stringify({
          message: { content: JSON.stringify({ verdict: "PASS", findings: [], recommendedActions: [] }) }
        })
      );
    }) as unknown as typeof fetch;
    const routes = [
      {
        role: "architecture",
        model: "qwen2.5-coder:7b",
        operations: ["review_plan"],
        expectedDigest: `sha256:${installedHex}`
      },
      {
        role: "triage",
        model: "qwen2.5-coder:7b",
        operations: ["diagnose_failure"],
        expectedDigest: `sha256:${"d".repeat(64)}`
      }
    ];
    const advise = createAdvise({ ACS_LOCAL_ADVISOR_ROUTES: JSON.stringify(routes) }, { fetchImpl });
    const first = await advise(request, new AbortController().signal);
    expect(first.status).toBe("completed");
    const second = await advise(
      { ...request, operation: "diagnose_failure" } as AdvisorRequest,
      new AbortController().signal
    );
    expect(second).toMatchObject({ status: "unavailable", reason: "model_digest_mismatch" });
  });
});
