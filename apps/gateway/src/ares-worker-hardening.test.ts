import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildGateway } from "./server.js";

// One definition of an ARES item (work-items isAresWorkItem) is used by the claim route, the result route and the
// claim gate. An item that mixes ares.* with another action, repeats ARES actions, or uses an unknown ares.* kind
// can no longer be created, so those layers can never disagree about it. Synthetic tokens only.
const ALICE = "SYNTH-alice-requester-token-0123456789abcdef";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "acs-ares-hardening-"));
  const app = buildGateway({
    dbPath: join(directory, "control.db"),
    logger: false,
    auth: {
      token: "",
      actor: "user",
      credentials: [
        {
          id: "alice",
          token: ALICE,
          actor: "user",
          actorId: "alice",
          roles: ["service"],
          scopes: ["acs:read", "acs:write"]
        }
      ]
    }
  });
  return { directory, app };
}

const request = (kinds: string[]) => ({
  title: "ARES item",
  intent: "ares work",
  target: { services: ["ares"] },
  requestedActions: kinds.map((kind) => ({ kind, description: kind, params: {} })),
  risk: "medium"
});

describe("ARES work item shape at the gateway", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("refuses mixed, repeated and unknown ares.* items with a validation error and creates nothing", async () => {
    const { directory, app } = fixture();
    directories.push(directory);
    try {
      await app.ready();
      for (const kinds of [
        ["ares.analyze.local", "system.status"],
        ["system.status", "ares.spec.seal"],
        ["ares.analyze.local", "ares.spec.seal"],
        ["ares.shell.exec"]
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/work-items",
          headers: { authorization: `Bearer ${ALICE}` },
          payload: request(kinds)
        });
        expect(response.statusCode, kinds.join("+")).toBe(400);
      }
      const listed = await app.inject({
        method: "GET",
        url: "/work-items",
        headers: { authorization: `Bearer ${ALICE}` }
      });
      expect(listed.statusCode).toBe(200);
      const body = listed.json() as unknown;
      const items = Array.isArray(body) ? body : ((body as { items?: unknown[] }).items ?? []);
      expect(items).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("still accepts a single known ARES action", async () => {
    const { directory, app } = fixture();
    directories.push(directory);
    try {
      await app.ready();
      const response = await app.inject({
        method: "POST",
        url: "/work-items",
        headers: { authorization: `Bearer ${ALICE}` },
        payload: request(["ares.analyze.local"])
      });
      expect(response.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });
});
