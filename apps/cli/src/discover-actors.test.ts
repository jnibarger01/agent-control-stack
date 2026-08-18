import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it, vi } from "vitest";
import { listAvailableActors } from "./available-actors.js";
import {
  CANONICAL_DISCOVERY_TARGETS,
  SYSTEM_BOOTSTRAP_ACTOR_ID,
  discoverLocalActors,
  isWorkerCapacityTarget,
  sanitizeDiscoveryError
} from "./discover-actors.js";

function tempDb(): { directory: string; dbPath: string; store: SqliteWorkItemStore } {
  const directory = mkdtempSync(join(tmpdir(), "acs-discover-"));
  const dbPath = join(directory, "control.db");
  return { directory, dbPath, store: new SqliteWorkItemStore(dbPath) };
}

describe("discoverLocalActors", () => {
  it("uses the fixed canonical executable mapping in registry order", () => {
    expect(CANONICAL_DISCOVERY_TARGETS.map((target) => target.id)).toEqual([
      "codex-cli",
      "claude-code",
      "gemini-cli",
      "opencode-local",
      "hermes-local",
      "openclaw-bridge",
      "grok-cli",
      "pi-cli"
    ]);
    expect(CANONICAL_DISCOVERY_TARGETS.every((target) => target.probeArgs[0] === "--version")).toBe(true);
    expect(isWorkerCapacityTarget("hermes-local")).toBe(false);
    expect(isWorkerCapacityTarget("openclaw-bridge")).toBe(false);
    expect(isWorkerCapacityTarget("codex-cli")).toBe(true);
    expect(isWorkerCapacityTarget("grok-cli")).toBe(true);
    expect(isWorkerCapacityTarget("pi-cli")).toBe(true);
  });

  it("records AVAILABLE on the bootstrap actor when the executable exists and the probe succeeds", async () => {
    const { directory, store } = tempDb();
    const now = new Date("2026-08-17T18:00:00.000Z");
    const resolveExecutable = vi.fn((name: string) => (name === "codex" ? "/fixed/codex" : undefined));
    const probe = vi.fn(async () => ({ ok: true }));
    try {
      const results = await discoverLocalActors({ store, resolveExecutable, probe, now });
      expect(results.find((result) => result.id === "codex-cli")).toEqual({ id: "codex-cli", outcome: "available" });
      expect(probe).toHaveBeenCalledWith("/fixed/codex", ["--version"]);
      const agent = store.getRegistryAgent("codex-cli");
      expect(agent?.status).toBe("AVAILABLE");
      expect(agent?.lastHeartbeatAt).toBe(now.toISOString());
      expect(agent?.updatedByActorId).toBe(SYSTEM_BOOTSTRAP_ACTOR_ID);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not return a missing executable as available and fail-closes to OFFLINE", async () => {
    const { directory, store } = tempDb();
    try {
      const results = await discoverLocalActors({
        store,
        resolveExecutable: () => undefined,
        probe: async () => ({ ok: true }),
        now: new Date("2026-08-17T18:00:00.000Z")
      });
      expect(results.every((result) => result.outcome === "missing")).toBe(true);
      expect(store.getRegistryAgent("codex-cli")?.status).toBe("OFFLINE");
      expect(store.getRegistryAgent("codex-cli")?.id).toBe("codex-cli");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not manufacture availability when a probe fails or times out", async () => {
    const { directory, store } = tempDb();
    const resolveExecutable = () => "/fixed/claude";
    try {
      await discoverLocalActors({
        store,
        resolveExecutable,
        probe: async () => ({ ok: false, error: "exit 1" }),
        now: new Date("2026-08-17T18:00:00.000Z")
      });
      expect(store.getRegistryAgent("claude-code")?.status).toBe("ERROR");

      await discoverLocalActors({
        store,
        resolveExecutable,
        probe: async () => ({ ok: false, timedOut: true, error: "timeout" }),
        now: new Date("2026-08-17T18:01:00.000Z")
      });
      expect(store.getRegistryAgent("claude-code")?.status).toBe("ERROR");
      expect(store.getRegistryAgent("claude-code")?.status).not.toBe("AVAILABLE");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refreshes a stale heartbeat only after a successful probe", async () => {
    const { directory, dbPath, store } = tempDb();
    const stale = new Date("2026-08-17T17:00:00.000Z");
    const now = new Date("2026-08-17T18:00:00.000Z");
    try {
      store.recordAgentHeartbeat("codex-cli", {
        status: "AVAILABLE",
        actorId: SYSTEM_BOOTSTRAP_ACTOR_ID,
        now: stale
      });
      expect(
        listAvailableActors({
          dbPath,
          now,
          heartbeatTtlMs: 60_000
        })
      ).toEqual([]);

      await discoverLocalActors({
        store,
        resolveExecutable: (name) => (name === "codex" ? "/fixed/codex" : undefined),
        probe: async () => ({ ok: true }),
        now
      });
      expect(store.getRegistryAgent("codex-cli")?.lastHeartbeatAt).toBe(now.toISOString());
      expect(
        listAvailableActors({
          dbPath,
          now,
          heartbeatTtlMs: 60_000
        })
      ).toEqual([
        {
          actor_id: "codex-cli",
          role: "coder",
          status: "AVAILABLE",
          agent_type: "cli",
          pane_id: "codex-cli",
          capacity: 1
        }
      ]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps hermes-local and openclaw-bridge history but excludes them from worker-capacity JSON", async () => {
    const { directory, dbPath, store } = tempDb();
    const now = new Date("2026-08-17T18:00:00.000Z");
    try {
      await discoverLocalActors({
        store,
        resolveExecutable: (name) => `/fixed/${name}`,
        probe: async () => ({ ok: true }),
        now
      });
      expect(store.getRegistryAgent("hermes-local")?.status).toBe("AVAILABLE");
      expect(store.getRegistryAgent("openclaw-bridge")?.status).toBe("AVAILABLE");
      const json = listAvailableActors({ dbPath, now, heartbeatTtlMs: 60_000 });
      expect(json.every((actor) => actor.actor_id !== "hermes-local" && actor.actor_id !== "openclaw-bridge")).toBe(
        true
      );
      expect(json.every((actor) => actor.capacity === 1)).toBe(true);
      expect(json[0] && Object.keys(json[0]).sort()).toEqual(
        ["actor_id", "agent_type", "capacity", "pane_id", "role", "status"].sort()
      );
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not create arbitrary agents and sanitizes probe errors", async () => {
    const { directory, store } = tempDb();
    const before = store.listRegistryAgents().map((agent) => agent.id);
    try {
      await discoverLocalActors({
        store,
        resolveExecutable: () => "/fixed/missing-bin",
        probe: async () => ({ ok: false, error: "secret=sk-proj-EXAMPLE token=abc\n".repeat(40) }),
        now: new Date("2026-08-17T18:00:00.000Z")
      });
      expect(store.listRegistryAgents().map((agent) => agent.id)).toEqual(before);
      const error = store.getRegistryAgent("gemini-cli")?.lastError ?? "";
      expect(error.length).toBeLessThanOrEqual(240);
      expect(error).not.toMatch(/\n/);
      expect(sanitizeDiscoveryError("a\u0000b".repeat(300)).length).toBeLessThanOrEqual(200);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records Grok as researcher and Pi as operator after successful injected probes", async () => {
    const { directory, dbPath, store } = tempDb();
    const now = new Date("2026-08-18T12:00:00.000Z");
    const probe = vi.fn(async () => ({ ok: true }));
    try {
      const results = await discoverLocalActors({
        store,
        resolveExecutable: (name) => (name === "grok" || name === "pi" ? `/fixed/${name}` : undefined),
        probe,
        now
      });
      expect(results.find((result) => result.id === "grok-cli")).toEqual({ id: "grok-cli", outcome: "available" });
      expect(results.find((result) => result.id === "pi-cli")).toEqual({ id: "pi-cli", outcome: "available" });
      expect(probe).toHaveBeenCalledWith("/fixed/grok", ["--version"]);
      expect(probe).toHaveBeenCalledWith("/fixed/pi", ["--version"]);
      expect(store.getRegistryAgent("grok-cli")).toMatchObject({
        status: "AVAILABLE",
        acpRole: "RESEARCH_BROAD_SCAN_AGENT",
        updatedByActorId: SYSTEM_BOOTSTRAP_ACTOR_ID,
        lastHeartbeatAt: now.toISOString()
      });
      expect(store.getRegistryAgent("pi-cli")).toMatchObject({
        status: "AVAILABLE",
        acpRole: "REVIEW_PLANNING_AGENT",
        updatedByActorId: SYSTEM_BOOTSTRAP_ACTOR_ID
      });
      expect(store.getRegistryAgent("codex-cli")?.status).toBe("OFFLINE");
      const json = listAvailableActors({ dbPath, now, heartbeatTtlMs: 60_000 });
      expect(json).toEqual(
        expect.arrayContaining([
          {
            actor_id: "grok-cli",
            role: "researcher",
            status: "AVAILABLE",
            agent_type: "cli",
            pane_id: "grok-cli",
            capacity: 1
          },
          {
            actor_id: "pi-cli",
            role: "operator",
            status: "AVAILABLE",
            agent_type: "cli",
            pane_id: "pi-cli",
            capacity: 1
          }
        ])
      );
      expect(json.every((actor) => actor.actor_id !== "hermes-local" && actor.actor_id !== "openclaw-bridge")).toBe(
        true
      );
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fail-closes missing or failed Grok and Pi probes without creating agents", async () => {
    const { directory, store } = tempDb();
    const now = new Date("2026-08-18T12:00:00.000Z");
    const before = store.listRegistryAgents().map((agent) => agent.id).sort();
    try {
      await discoverLocalActors({
        store,
        resolveExecutable: (name) => (name === "grok" ? undefined : name === "pi" ? "/fixed/pi" : undefined),
        probe: async () => ({ ok: false, error: "exit 2" }),
        now
      });
      expect(store.getRegistryAgent("grok-cli")?.status).toBe("OFFLINE");
      expect(store.getRegistryAgent("pi-cli")?.status).toBe("ERROR");
      expect(store.listRegistryAgents().map((agent) => agent.id).sort()).toEqual(before);

      await discoverLocalActors({
        store,
        resolveExecutable: (name) => (name === "pi" ? "/fixed/pi" : undefined),
        probe: async () => ({ ok: false, timedOut: true, error: "timeout" }),
        now: new Date("2026-08-18T12:01:00.000Z")
      });
      expect(store.getRegistryAgent("pi-cli")?.status).toBe("ERROR");
      expect(store.getRegistryAgent("pi-cli")?.status).not.toBe("AVAILABLE");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refreshes a stale Grok heartbeat only after a successful probe", async () => {
    const { directory, dbPath, store } = tempDb();
    const stale = new Date("2026-08-18T11:00:00.000Z");
    const now = new Date("2026-08-18T12:00:00.000Z");
    try {
      store.recordAgentHeartbeat("grok-cli", {
        status: "AVAILABLE",
        actorId: SYSTEM_BOOTSTRAP_ACTOR_ID,
        now: stale
      });
      expect(listAvailableActors({ dbPath, now, heartbeatTtlMs: 60_000 }).some((actor) => actor.actor_id === "grok-cli")).toBe(
        false
      );

      await discoverLocalActors({
        store,
        resolveExecutable: (name) => (name === "grok" ? "/fixed/grok" : undefined),
        probe: async () => ({ ok: true }),
        now
      });
      expect(store.getRegistryAgent("grok-cli")?.lastHeartbeatAt).toBe(now.toISOString());
      expect(listAvailableActors({ dbPath, now, heartbeatTtlMs: 60_000 })).toEqual([
        {
          actor_id: "grok-cli",
          role: "researcher",
          status: "AVAILABLE",
          agent_type: "cli",
          pane_id: "grok-cli",
          capacity: 1
        }
      ]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
