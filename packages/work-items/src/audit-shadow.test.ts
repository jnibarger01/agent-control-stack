import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CoreBackendError,
  createCoreVerifier,
  type CoreVerification,
  type CoreVerifier
} from "@agent-control-stack/shared";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteWorkItemStore } from "./index.js";

/**
 * Slice R1: the Rust core verifies the audit chain as a non-authoritative shadow of the TypeScript verifier.
 * Acceptance: TypeScript stays authoritative; every shadow disagreement, indeterminate verdict or shadow error fails
 * the audit health check closed; a shadow pass never masks a TypeScript failure; comparisons over different
 * committed data are skipped and counted, never guessed.
 */

const directories: string[] = [];
const stores: SqliteWorkItemStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function dbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "acs-audit-shadow-"));
  directories.push(directory);
  return join(directory, "control.db");
}

function open(path: string, verifier?: CoreVerifier | null): SqliteWorkItemStore {
  const store = new SqliteWorkItemStore(path, verifier === undefined ? {} : { auditShadowVerifier: verifier });
  stores.push(store);
  return store;
}

function seed(store: SqliteWorkItemStore): void {
  store.create({
    title: "Audit shadow fixture",
    requester: "user",
    requesterSubject: "actor-user",
    intent: "produce audit events",
    target: { cwd: "/repo", files: [] },
    requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["a"], write: false } }],
    risk: "low"
  });
}

/**
 * A shadow that reads the database file with the TypeScript file verifier (an independent second read of the same
 * committed data), optionally altering its verdict.
 */
function fileShadow(alter: (v: CoreVerification) => CoreVerification = (v) => v): CoreVerifier & { calls: number } {
  const typescriptFile = createCoreVerifier({ env: {} });
  const verifier = {
    calls: 0,
    verifyAuditChainFromDatabaseFile(path: string): CoreVerification {
      verifier.calls += 1;
      return alter(typescriptFile.verifyAuditChainFromDatabaseFile(path));
    }
  };
  return verifier;
}

describe("audit shadow verification (slice R1)", () => {
  it("is off unless ACS_CORE_BACKEND selects rust", () => {
    const previous = process.env.ACS_CORE_BACKEND;
    delete process.env.ACS_CORE_BACKEND;
    try {
      const store = open(dbPath());
      expect(store.auditShadowStatus()).toEqual({ backend: undefined, compared: 0, skipped: 0, failed: 0 });
      expect(store.health().ok).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.ACS_CORE_BACKEND;
      else process.env.ACS_CORE_BACKEND = previous;
    }
  });

  it("refuses an invalid ACS_CORE_BACKEND before opening the database", () => {
    const previous = process.env.ACS_CORE_BACKEND;
    process.env.ACS_CORE_BACKEND = "rusty";
    try {
      expect(() => new SqliteWorkItemStore(dbPath())).toThrow(CoreBackendError);
    } finally {
      if (previous === undefined) delete process.env.ACS_CORE_BACKEND;
      else process.env.ACS_CORE_BACKEND = previous;
    }
  });

  it("passes and counts a comparison when both verdicts agree", () => {
    const store = open(dbPath(), fileShadow());
    seed(store);
    const health = store.health();
    expect(health.checks.auditChain).toEqual({ ok: true });
    expect(health.ok).toBe(true);
    expect(store.auditShadowStatus()).toMatchObject({ backend: "rust", failed: 0 });
    expect(store.auditShadowStatus().compared).toBeGreaterThanOrEqual(2);
  });

  it.each([
    [
      "a different head hash",
      (v: CoreVerification) => ({ ...v, headHash: "0".repeat(64) }),
      "audit_chain_backend_disagreement"
    ],
    [
      "a different event count",
      (v: CoreVerification) => ({ ...v, eventCount: v.eventCount + 1 }),
      "audit_chain_backend_disagreement"
    ],
    [
      "a Rust failure",
      (v: CoreVerification) =>
        ({ ...v, ok: false, failure: { sequence: 1, reason: "hash_mismatch" } }) as unknown as CoreVerification,
      "audit_chain_backend_disagreement"
    ],
    [
      "an indeterminate Rust verdict",
      (v: CoreVerification) =>
        ({ ...v, ok: null, indeterminate: { sequence: 1, reason: "locale_dependent" } }) as CoreVerification,
      "audit_chain_backend_indeterminate"
    ]
  ])("fails readiness closed on %s", (_label, alter, code) => {
    let armed = false;
    const store = open(
      dbPath(),
      fileShadow((v) => (armed ? alter(v) : v))
    );
    seed(store);
    armed = true;
    const health = store.health();
    expect(health.checks.auditChain).toEqual({ ok: false, code });
    expect(health.ok).toBe(false);
    expect(store.readinessHealth().ok).toBe(false);
    expect(store.auditShadowStatus().failed).toBe(1);
  });

  it("fails closed when the shadow verifier throws", () => {
    let throwing = false;
    const inner = fileShadow();
    const store = open(dbPath(), {
      verifyAuditChainFromDatabaseFile(path) {
        if (throwing) throw new CoreBackendError("ACS_CORE_CALL_FAILED", "ACS core verification failed (store)");
        return inner.verifyAuditChainFromDatabaseFile(path);
      }
    });
    throwing = true;
    expect(store.health().checks.auditChain).toEqual({ ok: false, code: "audit_chain_backend_unavailable" });
  });

  it("never lets a shadow pass mask a TypeScript failure, and does not consult the shadow then", () => {
    const path = dbPath();
    const verifier = fileShadow((v) => ({ ...v, ok: true }) as CoreVerification);
    const store = open(path, verifier);
    seed(store);
    const callsBefore = verifier.calls;
    const tamper = new DatabaseSync(path);
    const row = tamper.prepare("SELECT sequence FROM audit_events ORDER BY sequence ASC LIMIT 1").get() as {
      sequence: number;
    };
    tamper.prepare("UPDATE audit_events SET body = ? WHERE sequence = ?").run('{"tampered":true}', row.sequence);
    tamper.close();
    const health = store.health();
    expect(health.checks.auditChain.ok).toBe(false);
    expect((health.checks.auditChain as { code: string }).code).not.toMatch(/backend/u);
    expect(verifier.calls).toBe(callsBefore);
  });

  it("skips and counts the comparison when another writer appends audit events between the two reads", () => {
    const path = dbPath();
    let interfere = false;
    const disagreeing = fileShadow((v) => ({ ...v, headHash: "f".repeat(64) }));
    const store = open(path, {
      verifyAuditChainFromDatabaseFile(file) {
        if (!interfere) return fileShadow().verifyAuditChainFromDatabaseFile(file);
        // A second store (another writer) commits audit events while the shadow reads. The comparison now covers
        // different audit data, so it must be neither trusted nor reported as a disagreement.
        const other = new SqliteWorkItemStore(path, { auditShadowVerifier: null });
        seed(other);
        other.close();
        return disagreeing.verifyAuditChainFromDatabaseFile(file);
      }
    });
    seed(store);
    interfere = true;
    const before = store.auditShadowStatus();
    expect(store.health().checks.auditChain).toEqual({ ok: true });
    const after = store.auditShadowStatus();
    expect(after.skipped).toBe(before.skipped + 1);
    expect(after.failed).toBe(before.failed);
  });
});

describe.skipIf(process.env.ACS_TEST_CORE_NATIVE !== "1")(
  "audit shadow with the compiled Rust core (ACS_TEST_CORE_NATIVE=1)",
  () => {
    it("agrees with TypeScript on a live store across writes and fails closed on tampering", () => {
      const path = dbPath();
      const store = open(path, createCoreVerifier({ env: { ACS_CORE_BACKEND: "rust" } }));
      for (let index = 0; index < 5; index += 1) seed(store);
      const health = store.health();
      expect(health.checks.auditChain).toEqual({ ok: true });
      expect(store.auditShadowStatus()).toMatchObject({ backend: "rust", failed: 0 });
      expect(store.auditShadowStatus().compared).toBeGreaterThanOrEqual(2);

      const tamper = new DatabaseSync(path);
      tamper.exec(
        "UPDATE audit_events SET body = '{\"tampered\":true}' WHERE sequence = (SELECT MAX(sequence) FROM audit_events)"
      );
      tamper.close();
      expect(store.health().checks.auditChain.ok).toBe(false);
    });
  }
);
