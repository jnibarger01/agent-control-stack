// TEMP benchmark — not part of the change. Deleted before commit.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyControlPlaneMigrations, auditEventHash } from "@agent-control-stack/shared";
import { buildGateway } from "./apps/gateway/dist/server.js";

const EVENTS = Number(process.env.BENCH_EVENTS ?? 20000);

function seed(db, n) {
  let previousHash = "";
  const insert = db.prepare(
    `INSERT INTO audit_events (sequence, id, name, time_unix_nano, attributes, body, previous_hash, event_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (let i = 1; i <= n; i += 1) {
    const base = {
      sequence: i,
      id: `evt_${i}`,
      name: "work_item.status_changed",
      timeUnixNano: String(BigInt(Date.now()) * 1000000n + BigInt(i)),
      attributes: { "work_item.id": `wi_${i}`, "work_item.status": "pending_policy" },
      body: { id: `wi_${i}`, status: "pending_policy", note: "seeded benchmark row" },
      previousHash
    };
    const eventHash = auditEventHash(base);
    insert.run(
      base.sequence,
      base.id,
      base.name,
      base.timeUnixNano,
      JSON.stringify(base.attributes),
      JSON.stringify(base.body),
      previousHash,
      eventHash
    );
    previousHash = eventHash;
  }
}

const dir = mkdtempSync(join(tmpdir(), "acs-health-bench-"));
const dbPath = join(dir, "control.db");
const seedDb = new DatabaseSync(dbPath);
seedDb.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
applyControlPlaneMigrations(seedDb);
seed(seedDb, EVENTS);
seedDb.close();

const app = buildGateway({ dbPath, logger: false, auth: { token: "t", actor: "user", actorId: "user" } });
const samples = [];
for (let i = 0; i < 7; i += 1) {
  const startedAt = performance.now();
  const response = await app.inject({ method: "GET", url: "/health" });
  samples.push(performance.now() - startedAt);
  if (response.statusCode !== 200) {
    console.log(`unexpected status ${response.statusCode}`);
  }
}
const sorted = [...samples].sort((a, b) => a - b);
console.log(
  `variant=${process.env.BENCH_VARIANT ?? "?"} audit_events=${EVENTS} /health min=${sorted[0].toFixed(1)}ms median=${sorted[
    Math.floor(sorted.length / 2)
  ].toFixed(1)}ms max=${sorted[sorted.length - 1].toFixed(1)}ms (n=${samples.length})`
);
await app.close();
rmSync(dir, { recursive: true, force: true });