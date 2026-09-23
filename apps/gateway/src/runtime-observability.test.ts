import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  RUNTIME_OBSERVABILITY_UNAVAILABLE_CODE,
  createRuntimeObservabilityClient,
  createRuntimeObservabilityClientFromEnv
} from "./runtime-observability.js";

const kinds = ["codex", "hermes", "openclaw", "opencode", "claude", "pi"] as const;
const servers: Server[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((s) => new Promise<void>((ok) => s.close(() => ok())))));
async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const s = createServer(handler); servers.push(s);
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const a = s.address(); if (!a || typeof a === "string") throw new Error("address");
  return "http://127.0.0.1:" + a.port;
}
function discovery() {
  return { schemaVersion: 1, generatedAt: "2026-09-22T18:00:00.000Z", runtimes: kinds.map((kind) => ({
    runtime: { kind, displayName: kind }, health: { status: "healthy", readiness: "ready", latencyMs: 1 },
    capabilities: [{ kind: "execute", enabled: true, requiresApproval: kind === "codex" }],
    available: true, availabilityReason: "available", version: { value: "1.0" }
  }))};
}
function agents(extra = {}) {
  return { schemaVersion: 1, generatedAt: "2026-09-22T18:00:00.000Z", runtimes: kinds.map((kind) => ({
    runtime: { kind }, inventory: { status: "available" },
    agents: [{ agent: { id: kind + "-agent", displayName: kind, sourceRuntime: kind, status: "idle" } }]
  })), ...extra };
}
describe("runtime observability", () => {
  it("projects bounded telemetry", async () => {
    const baseUrl = await listen((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(req.url === "/api/v1/runtimes" ? discovery() : agents())); });
    const out = await createRuntimeObservabilityClient({ baseUrl, timeoutMs: 1000 }).getSnapshot();
    expect(out.runtimes).toHaveLength(6);
    expect(out.runtimes[0]).toMatchObject({ kind: "codex", capabilities: ["execute"], approvalGatedCapabilities: 1 });
    expect(JSON.stringify(out)).not.toContain("command");
  });
  it("rejects credential-bearing payloads", async () => {
    const baseUrl = await listen((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(req.url === "/api/v1/runtimes" ? discovery() : agents({ token: "secret" }))); });
    await expect(createRuntimeObservabilityClient({ baseUrl, timeoutMs: 1000 }).getSnapshot()).rejects.toMatchObject({ code: RUNTIME_OBSERVABILITY_UNAVAILABLE_CODE });
  });
  it("rejects non-loopback configuration", async () => {
    await expect(createRuntimeObservabilityClientFromEnv({ ACS_RUNTIME_OBSERVABILITY_BASE_URL: "https://example.test" }).getSnapshot()).rejects.toMatchObject({ code: RUNTIME_OBSERVABILITY_UNAVAILABLE_CODE });
  });
});
