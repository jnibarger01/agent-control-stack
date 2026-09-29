import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteWorkItemStore } from "./index.js";

/**
 * Counts how many statements the store prepares while `run` executes. The
 * listing path is polled by the runtime reconciler and by the gateway agents
 * endpoints, so the number of prepared statements per listing is the thing
 * worth pinning: a per-agent read shows up here as a linear term.
 */
function withStatementCounter<T>(store: SqliteWorkItemStore, run: () => T): { result: T; statements: number } {
  const db = (store as unknown as { db: { prepare: (sql: string) => unknown } }).db;
  const original = db.prepare;
  let statements = 0;
  db.prepare = function counted(this: unknown, sql: string) {
    statements += 1;
    return original.call(this, sql);
  };
  try {
    return { result: run(), statements };
  } finally {
    db.prepare = original;
  }
}

describe("registry agent listing", () => {
  it("lists every agent's latest heartbeat and capabilities without a per-agent query", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-registry-listing-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      store.registerActor({ id: "user", actorType: "HUMAN", displayName: "Jace" });
      const agentIds = ["agent-a", "agent-b", "agent-c"];
      for (const [index, id] of agentIds.entries()) {
        store.createRegistryAgent({
          id,
          name: `Agent ${id}`,
          kind: "cli",
          acpRole: "IMPLEMENTATION_AGENT",
          actorId: "user"
        });
        store.replaceAgentCapabilities(id, [{ name: `cap:z-${id}` }, { name: `cap:a-${id}` }], "user");
        store.recordAgentHeartbeat(id, { actorId: "user", status: "AVAILABLE", currentTask: `task-${index}` });
      }

      const { result: listed, statements } = withStatementCounter(store, () => store.listRegistryAgents());

      // One statement per relation (agents, heartbeats, capabilities) - not
      // one per agent plus one per relation per agent.
      expect(statements).toBe(3);
      // The migrated registry seeds its own agents, so compare the agents this
      // test created, in `name ASC` order.
      expect(listed.filter((agent) => agentIds.includes(agent.id)).map((agent) => agent.id)).toEqual(agentIds);
      for (const id of agentIds) {
        const agent = listed.find((candidate) => candidate.id === id)!;
        // The batched listing must be indistinguishable from the row-by-row
        // read, including capability order.
        expect(agent).toEqual(store.getRegistryAgent(id));
        expect(agent.capabilities.map((capability) => capability.name)).toEqual([`cap:a-${id}`, `cap:z-${id}`]);
        expect(agent.latestHeartbeat).toBeDefined();
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves the highest heartbeat id when two heartbeats share an observed_at", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-registry-listing-tie-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      store.registerActor({ id: "user", actorType: "HUMAN", displayName: "Jace" });
      store.createRegistryAgent({
        id: "agent-a",
        name: "Agent A",
        kind: "cli",
        acpRole: "IMPLEMENTATION_AGENT",
        actorId: "user"
      });
      const observedAt = new Date("2026-09-28T12:00:00.000Z");
      store.recordAgentHeartbeat("agent-a", {
        actorId: "user",
        status: "DEGRADED",
        lastError: "warming",
        now: observedAt
      });
      store.recordAgentHeartbeat("agent-a", {
        actorId: "user",
        status: "AVAILABLE",
        currentTask: "idle",
        now: observedAt
      });

      const listed = store.listRegistryAgents().find((agent) => agent.id === "agent-a");

      expect(listed?.latestHeartbeat).toMatchObject({
        status: "AVAILABLE",
        currentTask: "idle",
        observedAt: observedAt.toISOString()
      });
      expect(listed).toEqual(store.getRegistryAgent("agent-a"));
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prepares a single statement and returns an empty list when no agents are registered", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-registry-listing-empty-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      store.registerActor({ id: "user", actorType: "HUMAN", displayName: "Jace" });
      // The migrations seed the registry, so empty it explicitly: the seeded
      // agents carry no heartbeats or capabilities, so the deletes cascade
      // nothing and no FK is left dangling.
      const db = (store as unknown as { db: { exec: (sql: string) => void } }).db;
      db.exec("DELETE FROM agents");

      const { result, statements } = withStatementCounter(store, () => store.listRegistryAgents());

      expect(result).toEqual([]);
      // No agent rows means no related-relation reads at all.
      expect(statements).toBe(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
