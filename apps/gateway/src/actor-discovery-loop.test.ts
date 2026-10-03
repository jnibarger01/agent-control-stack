import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGateway } from "./server.js";

let root: string;
let dbPath: string;
const open: Array<{ close: () => Promise<unknown> }> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "acs-discovery-loop-"));
  dbPath = join(root, "control.db");
});

afterEach(async () => {
  while (open.length) await open.pop()?.close();
  rmSync(root, { recursive: true, force: true });
});

const status = (id: string) => {
  const store = new SqliteWorkItemStore(dbPath);
  try {
    return store.getRegistryAgent(id);
  } finally {
    store.close();
  }
};

async function until(check: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("gateway actor discovery loop", () => {
  it("keeps agent heartbeats fresh on its own, so agents do not expire to offline", async () => {
    const probe = vi.fn(async () => ({ ok: true }));
    const app = buildGateway({
      dbPath,
      logger: false,
      actorDiscovery: { intervalMs: 20, resolveExecutable: (name) => `/fixed/${name}`, probe }
    });
    open.push(app);
    await app.ready();

    await until(() => status("codex-cli")?.status === "AVAILABLE");
    const first = status("codex-cli")?.lastHeartbeatAt;
    await until(() => status("codex-cli")?.lastHeartbeatAt !== first);
    expect(status("codex-cli")?.status).toBe("AVAILABLE");
  });

  it("marks an agent OFFLINE with the reason when its executable is not on PATH", async () => {
    const app = buildGateway({
      dbPath,
      logger: false,
      actorDiscovery: { intervalMs: 20, resolveExecutable: () => undefined, probe: async () => ({ ok: true }) }
    });
    open.push(app);
    await app.ready();
    await until(() => status("muse-code")?.lastError === "executable_not_found");
    expect(status("muse-code")?.status).toBe("OFFLINE");
  });

  it("does not start a probe loop unless configured", async () => {
    const probe = vi.fn(async () => ({ ok: true }));
    const app = buildGateway({ dbPath, logger: false, actorDiscovery: { intervalMs: 0, probe } });
    open.push(app);
    await app.ready();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(probe).not.toHaveBeenCalled();
  });

  it("never overlaps sweeps and stops after close", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const probe = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 60));
      inFlight -= 1;
      return { ok: true };
    };
    const app = buildGateway({
      dbPath,
      logger: false,
      actorDiscovery: { intervalMs: 5, resolveExecutable: () => "/fixed/x", probe }
    });
    await app.ready();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await app.close();
    expect(maxInFlight).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(inFlight).toBe(0);
  });
});
