import { describe, expect, it, vi } from "vitest";
import { runAcsCli, type AcsAdapters } from "./dispatch.js";
import type { CompatibilityAvailableActor } from "./available-actors.js";

function collectIo() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: { write: (chunk: string) => (stdout += chunk) },
      stderr: { write: (chunk: string) => (stderr += chunk) }
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    }
  };
}

function adapters(overrides: Partial<AcsAdapters> = {}): AcsAdapters {
  return {
    discoverLocalActors: vi.fn(async () => undefined),
    listAvailableActors: vi.fn((): CompatibilityAvailableActor[] => [
      {
        actor_id: "fresh-coder",
        role: "coder",
        status: "AVAILABLE",
        agent_type: "codex",
        pane_id: "fresh-coder",
        capacity: 1
      }
    ]),
    runWorkerOnce: vi.fn(async () => ({ executed: false, reason: "no approved work item" })),
    runSchedulerOnce: vi.fn(async () => ({ firings: [] })),
    startMcp: vi.fn(),
    startGateway: vi.fn(async () => undefined),
    readStatus: vi.fn(() => ({ health: { ok: true }, audit: { ok: true } })),
    listPublications: vi.fn(() => []),
    ...overrides
  };
}

describe("runAcsCli", () => {
  it("writes a JSON array after refreshing local actor discovery", async () => {
    const collected = collectIo();
    const order: string[] = [];
    const discover = vi.fn(async () => {
      order.push("discover");
    });
    const injected = adapters({
      discoverLocalActors: discover,
      listAvailableActors: vi.fn((): CompatibilityAvailableActor[] => {
        order.push("list");
        return [
          {
            actor_id: "fresh-coder",
            role: "coder",
            status: "AVAILABLE",
            agent_type: "codex",
            pane_id: "fresh-coder",
            capacity: 1
          }
        ];
      })
    });
    const code = await runAcsCli(["actor", "list", "--available", "--json"], collected.io, injected);
    expect(code).toBe(0);
    expect(collected.stderr).toBe("");
    expect(discover).toHaveBeenCalledOnce();
    expect(order).toEqual(["discover", "list"]);
    expect(JSON.parse(collected.stdout)).toEqual([
      {
        actor_id: "fresh-coder",
        role: "coder",
        status: "AVAILABLE",
        agent_type: "codex",
        pane_id: "fresh-coder",
        capacity: 1
      }
    ]);
  });

  it("keeps usage errors off stdout", async () => {
    const collected = collectIo();
    const code = await runAcsCli(["actor", "list"], collected.io, adapters());
    expect(code).toBe(1);
    expect(collected.stdout).toBe("");
    expect(collected.stderr).toContain("acs actor list requires --available");
  });

  it("delegates worker, scheduler, mcp, and gateway", async () => {
    const collected = collectIo();
    const injected = adapters();
    expect(await runAcsCli(["worker"], collected.io, injected)).toBe(0);
    expect(await runAcsCli(["scheduler"], collected.io, injected)).toBe(0);
    expect(await runAcsCli(["mcp", "--config", "cfg.yml"], collected.io, injected)).toBe(0);
    expect(await runAcsCli(["gateway"], collected.io, injected)).toBe(0);
    expect(injected.runWorkerOnce).toHaveBeenCalledOnce();
    expect(injected.runSchedulerOnce).toHaveBeenCalledOnce();
    expect(injected.startMcp).toHaveBeenCalledWith(["--config", "cfg.yml"]);
    expect(injected.startGateway).toHaveBeenCalledOnce();
    expect(JSON.parse(collected.stdout.trim().split("\n")[0] ?? "")).toEqual({
      executed: false,
      reason: "no approved work item"
    });
  });

  it("invokes injected discovery before listing available actors", async () => {
    const collected = collectIo();
    const order: string[] = [];
    const discover = vi.fn(async () => {
      order.push("discover");
    });
    const injected = adapters({
      discoverLocalActors: discover,
      listAvailableActors: () => {
        order.push("list");
        return [];
      }
    });
    expect(await runAcsCli(["actor", "list", "--available", "--json"], collected.io, injected)).toBe(0);
    expect(order).toEqual(["discover", "list"]);
    expect(discover).toHaveBeenCalledOnce();
    expect(JSON.parse(collected.stdout)).toEqual([]);
  });

  describe("status", () => {
    it("prints a human-readable summary by default and exits 0 when healthy", async () => {
      const collected = collectIo();
      const injected = adapters({ readStatus: vi.fn(() => ({ health: { ok: true }, audit: { ok: true } })) });
      expect(await runAcsCli(["status"], collected.io, injected)).toBe(0);
      expect(collected.stdout).toBe("health=true audit=true\n");
    });

    it("prints JSON when --json is passed", async () => {
      const collected = collectIo();
      const injected = adapters({ readStatus: vi.fn(() => ({ health: { ok: true }, audit: { ok: true } })) });
      expect(await runAcsCli(["status", "--json"], collected.io, injected)).toBe(0);
      expect(JSON.parse(collected.stdout)).toEqual({ health: { ok: true }, audit: { ok: true } });
    });

    it("exits 1 when unhealthy, in both text and json modes", async () => {
      const collected = collectIo();
      const injected = adapters({ readStatus: vi.fn(() => ({ health: { ok: false }, audit: { ok: true } })) });
      expect(await runAcsCli(["status"], collected.io, injected)).toBe(1);

      const collectedJson = collectIo();
      expect(await runAcsCli(["status", "--json"], collectedJson.io, injected)).toBe(1);
      expect(JSON.parse(collectedJson.stdout)).toEqual({ health: { ok: false }, audit: { ok: true } });
    });
  });

  describe("doctor", () => {
    it("prints a human-readable summary by default and exits 0 when healthy", async () => {
      const collected = collectIo();
      const injected = adapters({ readStatus: vi.fn(() => ({ health: { ok: true }, audit: { ok: true } })) });
      expect(await runAcsCli(["doctor"], collected.io, injected)).toBe(0);
      expect(collected.stdout).toBe("health=true audit=true\n");
    });

    it("prints JSON when --json is passed, matching the status command's contract", async () => {
      const collected = collectIo();
      const injected = adapters({ readStatus: vi.fn(() => ({ health: { ok: true }, audit: { ok: true } })) });
      expect(await runAcsCli(["doctor", "--json"], collected.io, injected)).toBe(0);
      expect(collected.stdout.trim().startsWith("{")).toBe(true);
      expect(JSON.parse(collected.stdout)).toEqual({ health: { ok: true }, audit: { ok: true } });
    });

    it("exits 1 when unhealthy, in both text and json modes", async () => {
      const collected = collectIo();
      const injected = adapters({ readStatus: vi.fn(() => ({ health: { ok: true }, audit: { ok: false } })) });
      expect(await runAcsCli(["doctor"], collected.io, injected)).toBe(1);

      const collectedJson = collectIo();
      expect(await runAcsCli(["doctor", "--json"], collectedJson.io, injected)).toBe(1);
      expect(JSON.parse(collectedJson.stdout)).toEqual({ health: { ok: true }, audit: { ok: false } });
    });
  });
});
