import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkItem } from "@agent-control-stack/work-items";
import { authenticatedWorkerClaimConfigFromEnv, createAuthenticatedWorkerClaim } from "./claim-client.js";

afterEach(() => vi.unstubAllEnvs());

function claimedWorkItem() {
  return {
    ...createWorkItem(
      {
        title: "Read-only acceptance",
        requester: "user",
        intent: "Read one test fixture",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.read", description: "Read a file", params: { path: "README.md" } }],
        risk: "low",
        status: "pending_policy"
      },
      "2026-10-02T12:00:00.000Z"
    ),
    status: "running" as const,
    workerId: "worker-a",
    leaseToken: "lease-token-for-worker-a-0001",
    leaseId: "lease-1",
    actionHash: "a".repeat(64),
    attemptId: "attempt-1",
    planHash: "b".repeat(64),
    inputHash: "c".repeat(64),
    fencingEpoch: 1,
    startedAt: "2026-10-02T12:00:00.000Z",
    leaseExpiresAt: "2026-10-02T12:05:00.000Z"
  };
}

describe("authenticated Nimble worker claim client", () => {
  it("is disabled outside Nimble worker mode and requires a dedicated worker identity when enabled", () => {
    expect(authenticatedWorkerClaimConfigFromEnv({})).toBeUndefined();
    expect(() =>
      authenticatedWorkerClaimConfigFromEnv({ ACS_NIMBLE_ROUTING_ENABLED: "1" } as NodeJS.ProcessEnv)
    ).toThrow("Nimble worker mode requires ACS_WORKER_ID and ACS_WORKER_TOKEN");
  });

  it("rejects non-loopback gateway URLs and invalid timeouts", () => {
    expect(() =>
      authenticatedWorkerClaimConfigFromEnv({
        ACS_NIMBLE_ROUTING_ENABLED: "1",
        ACS_WORKER_ID: "worker-a",
        ACS_WORKER_TOKEN: "worker-token-for-test-0001",
        ACS_WORKER_GATEWAY_URL: "https://gateway.example.test"
      } as NodeJS.ProcessEnv)
    ).toThrow("ACS_WORKER_GATEWAY_URL must be a loopback HTTP origin");
    expect(() =>
      authenticatedWorkerClaimConfigFromEnv({
        ACS_NIMBLE_ROUTING_ENABLED: "1",
        ACS_WORKER_ID: "worker-a",
        ACS_WORKER_TOKEN: "worker-token-for-test-0001",
        ACS_WORKER_CLAIM_TIMEOUT_MS: "999999"
      } as NodeJS.ProcessEnv)
    ).toThrow("ACS_WORKER_CLAIM_TIMEOUT_MS must be between 100 and 60000");
  });

  it("authenticates without trusting a worker ID in the body and validates the persisted claim response", async () => {
    const claimed = claimedWorkItem();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:3000/worker/claim");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer worker-token-for-test-0001");
      expect(init?.body).toBe("{}");
      expect(String(init?.body)).not.toContain("worker-a");
      return Response.json({ claimed: true, workItem: claimed });
    }) as unknown as typeof fetch;
    const claim = createAuthenticatedWorkerClaim(
      {
        workerId: "worker-a",
        token: "worker-token-for-test-0001",
        gatewayUrl: new URL("http://127.0.0.1:3000"),
        timeoutMs: 5_000
      },
      fetchImpl
    );

    await expect(claim()).resolves.toMatchObject({ id: claimed.id, workerId: "worker-a", status: "running" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns no claim without parsing any caller-supplied identity", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ claimed: false })) as unknown as typeof fetch;
    const claim = createAuthenticatedWorkerClaim(
      {
        workerId: "worker-a",
        token: "worker-token-for-test-0001",
        gatewayUrl: new URL("http://127.0.0.1:3000"),
        timeoutMs: 5_000
      },
      fetchImpl
    );
    await expect(claim()).resolves.toBeUndefined();
  });

  it("does not expose credential material or response bodies when the gateway rejects a claim", async () => {
    const token = "worker-token-for-test-0001";
    const fetchImpl = vi.fn(
      async () => new Response("sensitive response body", { status: 503 })
    ) as unknown as typeof fetch;
    const claim = createAuthenticatedWorkerClaim(
      {
        workerId: "worker-a",
        token,
        gatewayUrl: new URL("http://127.0.0.1:3000"),
        timeoutMs: 5_000
      },
      fetchImpl
    );
    const error = await claim().catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "worker_claim_unavailable" });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(token);
    expect((error as Error).message).not.toContain("sensitive response body");
  });

  it("rejects malformed claim responses", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ claimed: true, workItem: {} })) as unknown as typeof fetch;
    const claim = createAuthenticatedWorkerClaim(
      {
        workerId: "worker-a",
        token: "worker-token-for-test-0001",
        gatewayUrl: new URL("http://127.0.0.1:3000"),
        timeoutMs: 5_000
      },
      fetchImpl
    );
    await expect(claim()).rejects.toMatchObject({ code: "worker_claim_invalid_response" });
  });

  it("fails closed when the authenticated response names another worker", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ claimed: true, workItem: { ...claimedWorkItem(), workerId: "worker-b" } })
    ) as unknown as typeof fetch;
    const claim = createAuthenticatedWorkerClaim(
      {
        workerId: "worker-a",
        token: "worker-token-for-test-0001",
        gatewayUrl: new URL("http://127.0.0.1:3000"),
        timeoutMs: 5_000
      },
      fetchImpl
    );
    await expect(claim()).rejects.toMatchObject({ code: "worker_claim_identity_mismatch" });
  });
});
