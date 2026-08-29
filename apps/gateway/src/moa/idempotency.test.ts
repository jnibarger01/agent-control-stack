import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteMoaIdempotencyStore } from "./idempotency.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SqliteMoaIdempotencyStore", () => {
  it("waits on a pending reservation without double-closing the database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-idempotency-"));
    dirs.push(dir);
    const store = new SqliteMoaIdempotencyStore(join(dir, "control.db"));

    await expect(store.tryReserve("same-key")).resolves.toEqual({ reserved: true });

    const waiting = store.tryReserve("same-key");
    setTimeout(() => void store.put("same-key", { workItemId: "work-1" }), 25);

    await expect(waiting).resolves.toEqual({
      reserved: false,
      existing: { workItemId: "work-1" }
    });
  });
});
