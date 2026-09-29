import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createPolicyEngine } from "@agent-control-stack/policy-gate";
import { SqliteWorkItemStore, type WorkItem } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGateway } from "./server.js";

// PR #212 B4 / ADR 0021: trace is observational. Bad trace producer config fails at
// gateway boot; approver identity format can never deny an approval.

const directories: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "acs-trace-boot-"));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function bootError(dbPath: string): unknown {
  try {
    buildGateway({ dbPath, logger: false, auth: { token: "t", actor: "user", actorId: "user" } });
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("gateway trace producer config (PR #212 B4)", () => {
  it.each([
    ["ACS_RELEASE_SHA", "1c8dc83"],
    ["ACS_RELEASE_SHA", "not-a-sha"],
    ["ACS_TRACE_INSTANCE", "acs prod"],
    ["ACS_TRACE_INSTANCE", "acs/prod"]
  ])("refuses to boot with %s=%j", (name, value) => {
    vi.stubEnv(name, value);
    const dbPath = join(tempDir(), "control.db");
    const error = bootError(dbPath);
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe("trace_config_invalid");
    expect((error as Error).message).toContain(name);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("only the gateway refuses: a non-gateway store on the same env and path still opens", () => {
    vi.stubEnv("ACS_RELEASE_SHA", "1c8dc83");
    const dbPath = join(tempDir(), "control.db");
    expect((bootError(dbPath) as { code?: string }).code).toBe("trace_config_invalid");
    const store = new SqliteWorkItemStore(dbPath);
    try {
      expect(store.list()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("boots with a full release sha and a grammar-valid instance", async () => {
    vi.stubEnv("ACS_RELEASE_SHA", "1c8dc8334972680ee4520f416922ae58d78cbab8");
    vi.stubEnv("ACS_TRACE_INSTANCE", "acs-prod");
    const app = buildGateway({
      dbPath: join(tempDir(), "control.db"),
      logger: false,
      auth: { token: "t", actor: "user", actorId: "user" }
    });
    await app.close();
  });

  it.each(["jace@example.com", "auth0|123"])(
    "records an HTTP approval from actor %s and traces it under a normalised id",
    async (actorId) => {
      vi.stubEnv("ACS_RELEASE_SHA", "1c8dc8334972680ee4520f416922ae58d78cbab8");
      vi.stubEnv("ACS_TRACE_INSTANCE", "acs-prod");
      const dbPath = join(tempDir(), "control.db");
      const seed = new SqliteWorkItemStore(dbPath);
      let workItem: WorkItem;
      try {
        seed.registerActor({
          id: actorId,
          actorType: "HUMAN",
          displayName: actorId,
          externalRef: "local_bearer:local-dev"
        });
        workItem = seed.create({
          title: "Approve with an IdP-shaped actor",
          requester: "agent",
          intent: "write one file",
          requestedActions: [{ kind: "fs.write", description: "write file", params: { paths: ["src/index.ts"] } }],
          target: { cwd: "/repo" },
          risk: "high"
        });
      } finally {
        seed.close();
      }
      const actionHash = createPolicyEngine().evaluateWorkItem(workItem, actorId, "approve")[0]?.actionHash;
      expect(actionHash).toBeTruthy();
      const app = buildGateway({ dbPath, logger: false, auth: { token: "t", actor: "user", actorId } });
      try {
        const approved = await app.inject({
          method: "POST",
          url: `/work-items/${workItem.id}/approve`,
          headers: { authorization: "Bearer t" },
          payload: { reason: "exact action", actionHash }
        });
        expect(approved.statusCode).toBe(200);
      } finally {
        await app.close();
      }
      const check = new DatabaseSync(dbPath);
      try {
        const approval = check.prepare(`SELECT approved_by FROM approval_records`).get() as { approved_by: string };
        expect(approval.approved_by).toBe(actorId);
        const row = check.prepare(`SELECT canonical_json FROM trace_outbox`).get() as { canonical_json: string };
        const event = JSON.parse(row.canonical_json) as {
          actor: { id: string };
          source: { instance: string; release_sha: string };
        };
        expect(event.actor.id).toBe(`h:${createHash("sha256").update(actorId).digest("hex").slice(0, 32)}`);
        expect(event.source).toMatchObject({
          instance: "acs-prod",
          release_sha: "1c8dc8334972680ee4520f416922ae58d78cbab8"
        });
      } finally {
        check.close();
      }
    }
  );
});
