import { describe, expect, it } from "vitest";
import { createWorkerGatewayClient } from "./gateway-client.js";

describe("worker gateway client", () => {
  it("claims and submits through the dedicated authenticated worker API", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createWorkerGatewayClient({
      baseUrl: "http://127.0.0.1:3000/",
      token: "worker-token",
      workerId: "acs-worker",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        if (String(url).endsWith("/worker/claim")) {
          return new Response(
            JSON.stringify({
              workItem: {
                id: "wrk_1",
                workerId: "acs-worker",
                leaseToken: "lease-secret",
                leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
                leaseId: "lease_1"
              }
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ workItem: { id: "wrk_1", status: "succeeded" } }), { status: 200 });
      }
    });

    const claim = await client.claim();
    await client.submit("wrk_1", { leaseToken: claim!.leaseToken, status: "succeeded", result: { execution_mode: "dry_run" } });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.init.headers).toMatchObject({ authorization: "Bearer worker-token", "x-acs-worker-id": "acs-worker" });
    expect(calls[1]?.url).toBe("http://127.0.0.1:3000/work-items/wrk_1/results");
    expect(JSON.stringify(calls)).not.toContain("ACS_MCP_BEARER_TOKEN");
  });
});
