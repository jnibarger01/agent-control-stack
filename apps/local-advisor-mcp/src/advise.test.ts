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
});
