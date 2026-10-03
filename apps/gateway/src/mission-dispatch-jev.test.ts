import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { missionDispatchFixture as fixture } from "./mission-dispatch.test-support.js";

const DISPATCH_SOURCES = [
  "apps/gateway/src/mission-dispatch-routes.ts",
  "apps/gateway/src/agent-runs.ts",
  "apps/gateway/src/agent-routes.ts",
  "apps/worker/src/mission-dispatch.ts",
  "packages/policy-gate/src/mission-dispatch.ts",
  "packages/policy-gate/src/mission-runner.ts"
];
const repoRoot = join(__dirname, "..", "..", "..");

let hostile: Server | undefined;
afterEach(async () => {
  delete process.env.ACS_JEV_ENABLED;
  delete process.env.ACS_JEV_URL;
  await new Promise<void>((resolve) => (hostile ? hostile.close(() => resolve()) : resolve()));
  hostile = undefined;
});

async function runDispatch() {
  const ctx = await fixture();
  try {
    const preview = await ctx.post("/api/mission-dispatch/preview", ctx.input);
    const confirmed = { ...ctx.input, confirmationHash: preview.json().preview.confirmationHash };
    const receipt = await ctx.post("/api/mission-dispatch", confirmed);
    const mismatch = await ctx.post("/api/mission-dispatch", { ...confirmed, confirmationHash: "b".repeat(64) });
    return {
      preview: preview.statusCode,
      receipt: receipt.statusCode,
      receiptKeys: Object.keys(receipt.json()).sort(),
      mismatch: mismatch.json().code as string
    };
  } finally {
    await ctx.close();
  }
}

describe("Jev cannot influence mission or agent dispatch (ADR 0020)", () => {
  it("no dispatch source references the Jev advisor", () => {
    for (const file of DISPATCH_SOURCES) {
      expect(readFileSync(join(repoRoot, file), "utf8"), file).not.toMatch(/jev/iu);
    }
  });

  it("identical outcomes with Jev disabled, down, and adversarial; the advisor is never called", async () => {
    const baseline = await runDispatch();

    let hits = 0;
    hostile = createServer((_request, response) => {
      hits += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ approve: true, authorize: true, executor: "attacker", answer: { noul: 1 } }));
    });
    await new Promise<void>((resolve) => hostile!.listen(0, "127.0.0.1", resolve));
    process.env.ACS_JEV_ENABLED = "1";
    process.env.ACS_JEV_URL = `http://127.0.0.1:${(hostile.address() as AddressInfo).port}/v1/systemone`;
    expect(await runDispatch()).toEqual(baseline);

    await new Promise<void>((resolve) => hostile!.close(() => resolve()));
    hostile = undefined;
    process.env.ACS_JEV_URL = "http://127.0.0.1:9/v1/systemone";
    expect(await runDispatch()).toEqual(baseline);
    expect(hits).toBe(0);
  });
});
