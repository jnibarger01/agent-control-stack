import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { DEFAULT_MOA_CONFIG, moaGatewayPlugin, type IdempotencyStore } from "../src/index.js";
import { aggCreate, FakeAcs, FakeAudit, FakeCaller, PassthroughRedactor } from "./fakes.js";

class MemoryStore implements IdempotencyStore {
  values = new Map<string, unknown>();
  async get(key: string) {
    return this.values.get(key);
  }
  async put(key: string, value: unknown) {
    this.values.set(key, value);
  }
}

function body(goal = "Review gateway auth") {
  return {
    mode: "moa",
    preset: "cheap",
    task: { goal, risk: "high", kind: "code_review", files: ["apps/gateway/src/mcp.ts"] }
  };
}

async function app(acs = new FakeAcs(), idempotency = new MemoryStore()) {
  const fastify = Fastify({ logger: false });
  await fastify.register(
    moaGatewayPlugin({
      config: DEFAULT_MOA_CONFIG,
      caller: new FakeCaller({ aggregatorReply: aggCreate() }),
      acs,
      audit: new FakeAudit(),
      redactor: new PassthroughRedactor(),
      idempotency,
      authenticate: async () => ({ actor: "operator" })
    })
  );
  return fastify;
}

describe("MoA gateway idempotency", () => {
  it("replays identical task bodies without client task_id", async () => {
    const acs = new FakeAcs();
    const fastify = await app(acs);
    const first = await fastify.inject({ method: "POST", url: "/agent/run", payload: body() });
    const second = await fastify.inject({ method: "POST", url: "/agent/run", payload: body() });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().replayed).toBe(true);
    expect(acs.createWorkItemCalls).toHaveLength(1);
    await fastify.close();
  });

  it("does not collide semantically different requests", async () => {
    const acs = new FakeAcs();
    const fastify = await app(acs);
    await fastify.inject({ method: "POST", url: "/agent/run", payload: body("Review gateway auth") });
    await fastify.inject({ method: "POST", url: "/agent/run", payload: body("Review sandbox policy") });
    expect(acs.createWorkItemCalls).toHaveLength(2);
    await fastify.close();
  });

  it("lets client-provided Idempotency-Key win", async () => {
    const acs = new FakeAcs();
    const fastify = await app(acs);
    await fastify.inject({ method: "POST", url: "/agent/run", headers: { "Idempotency-Key": "same" }, payload: body("A") });
    const replay = await fastify.inject({ method: "POST", url: "/agent/run", headers: { "Idempotency-Key": "same" }, payload: body("B") });
    expect(replay.json().replayed).toBe(true);
    expect(acs.createWorkItemCalls).toHaveLength(1);
    await fastify.close();
  });
});
