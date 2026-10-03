// TEMP benchmark — not part of the change. Deleted before commit.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  applyControlPlaneMigrations,
  inspectControlPlaneDatabase,
  auditEventHash,
  verifyAuditChain
} from "@agent-control-stack/shared";
import { gatewayMcpInputSchemas, remoteMcpToolNames } from "./apps/gateway/dist/public-contracts.js";
import { z } from "zod";

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
      attributes: { "work_item.id": `wi_${i}`, "work_item.status": "pending_policy", "actor.id": "actor_system_bootstrap" },
      body: { id: `wi_${i}`, status: "pending_policy", note: "seeded benchmark row" },
      previousHash
    };
    const eventHash = auditEventHash(base);
    insert.run(base.sequence, base.id, base.name, base.timeUnixNano, JSON.stringify(base.attributes), JSON.stringify(base.body), previousHash, eventHash);
    previousHash = eventHash;
  }
}

function time(fn, runs = 5) {
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    const t = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  return { min: Math.min(...samples), median: samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)] };
}

const dir = mkdtempSync(join(tmpdir(), "acs-perf-"));
for (const n of [200, 5000, 20000]) {
  const path = join(dir, `n${n}.sqlite`);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  applyControlPlaneMigrations(db);
  seed(db, n);
  const full = time(() => inspectControlPlaneDatabase(db));
  const integrity = time(() => db.prepare("PRAGMA integrity_check").all());
  const fk = time(() => db.prepare("PRAGMA foreign_key_check").all());
  const rows = db.prepare("SELECT * FROM audit_events ORDER BY sequence ASC").all();
  const chain = time(() =>
    verifyAuditChain(
      rows.map((row) => ({
        sequence: row.sequence,
        id: row.id,
        name: row.name,
        timeUnixNano: row.time_unix_nano,
        attributes: JSON.parse(row.attributes),
        body: JSON.parse(row.body),
        previousHash: row.previous_hash,
        eventHash: row.event_hash
      }))
    )
  );
  const readRows = time(() => db.prepare("SELECT * FROM audit_events ORDER BY sequence ASC").all());
  console.log(
    `audit_events=${n} fullHealth=${full.min.toFixed(2)}ms integrity_check=${integrity.min.toFixed(
      2
    )}ms foreign_key_check=${fk.min.toFixed(2)}ms auditChain(parse+hash)=${chain.min.toFixed(
      2
    )}ms selectAll=${readRows.min.toFixed(2)}ms`
  );
  db.close();
}

// two full health() probes = what one /readyz success path costs today
console.log("--- MCP tools/list payload cost");
const names = [...remoteMcpToolNames];
const one = time(() => {
  for (const name of names) {
    z.toJSONSchema(gatewayMcpInputSchemas[name], { target: "draft-7", io: "input" });
  }
}, 20);
console.log(`tools=${names.length} toJSONSchema-per-tools/list min=${one.min.toFixed(2)}ms median=${one.median.toFixed(2)}ms`);

const cache = new Map();
const warm = time(() => {
  for (const name of names) {
    let schema = cache.get(name);
    if (!schema) {
      schema = z.toJSONSchema(gatewayMcpInputSchemas[name], { target: "draft-7", io: "input" });
      cache.set(name, schema);
    }
  }
}, 20);
console.log(`memoized min=${warm.min.toFixed(2)}ms median=${warm.median.toFixed(2)}ms`);

rmSync(dir, { recursive: true, force: true });