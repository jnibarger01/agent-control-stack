import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { listAvailableActors } from "./available-actors.js";

describe("listAvailableActors", () => {
  it("returns only AVAILABLE registry agents with a fresh heartbeat and capacity 1", () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-cli-actors-"));
    const dbPath = join(directory, "control.db");
    const now = new Date("2026-08-17T12:00:00.000Z");
    const heartbeatTtlMs = 60_000;
    const store = new SqliteWorkItemStore(dbPath, { heartbeatTtlMs });

    try {
      store.registerActor({ id: "user", actorType: "HUMAN", displayName: "Jace" });
      store.createRegistryAgent({
        id: "fresh-coder",
        name: "Fresh Coder",
        kind: "cli",
        acpRole: "IMPLEMENTATION_AGENT",
        provider: "codex",
        actorId: "user"
      });
      store.createRegistryAgent({
        id: "stale-coder",
        name: "Stale Coder",
        kind: "cli",
        acpRole: "LOCAL_CODING_AGENT",
        actorId: "user"
      });
      store.createRegistryAgent({
        id: "busy-fresh",
        name: "Busy Fresh",
        kind: "cli",
        acpRole: "RESEARCH_BROAD_SCAN_AGENT",
        actorId: "user"
      });
      store.recordAgentHeartbeat("fresh-coder", { status: "AVAILABLE", actorId: "user", now });
      store.recordAgentHeartbeat("stale-coder", {
        status: "AVAILABLE",
        actorId: "user",
        now: new Date(now.getTime() - heartbeatTtlMs - 1)
      });
      store.recordAgentHeartbeat("busy-fresh", { status: "BUSY", actorId: "user", now });
    } finally {
      store.close();
    }

    try {
      const actors = listAvailableActors({ dbPath, now, heartbeatTtlMs });
      expect(JSON.parse(JSON.stringify(actors))).toEqual([
        {
          actor_id: "fresh-coder",
          role: "coder",
          status: "AVAILABLE",
          agent_type: "codex",
          pane_id: "fresh-coder",
          capacity: 1
        }
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not read the actors table for availability", () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-cli-actors-no-table-"));
    const dbPath = join(directory, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    try {
      store.registerActor({ id: "user", actorType: "HUMAN", displayName: "Jace" });
      expect(store.listActors().some((actor) => actor.id === "user")).toBe(true);
      expect(store.listRegistryAgents().length).toBeGreaterThan(0);
      expect(store.listRegistryAgents().every((agent) => agent.status !== "AVAILABLE")).toBe(true);
      expect(listAvailableActors({ dbPath })).toEqual([]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
