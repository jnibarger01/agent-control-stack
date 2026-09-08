import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import {
  defaultExecutionPlanForWorkItem,
  executionActionHash,
  SqliteWorkItemStore,
  type ClaimedWorkItem,
  type WorkItem
} from "@agent-control-stack/work-items";
import type { ManagedCapabilityConfig } from "./capability-issuance.js";
import type { ContainmentConfig } from "./containment.js";
import { issueDesktopCommanderCapabilityForRequest } from "./http-issuer.js";
import { SqliteDesktopCommanderRuntimeRegistry } from "./runtime-registry.js";
import { makeRoot } from "./test-fixtures.js";

const HASH64 = "b".repeat(64);
const IDENTITY_FINGERPRINT = "c".repeat(64);
const WORKER_ID = "worker_1";

const directories: string[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  dbPath: string;
  store: SqliteWorkItemStore;
  registry: SqliteDesktopCommanderRuntimeRegistry;
  workItem: WorkItem;
  claimed: ClaimedWorkItem;
  config: ManagedCapabilityConfig;
  containment: ContainmentConfig;
  root: string;
  privateKeyDer: Buffer;
  publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"];
}

interface FixtureOptions {
  executionMode?: "dry_run" | "desktop_commander";
  toolKind?: string;
  toolName?: string;
  /** Given the fixture's own containment root, produce the tool arguments. */
  toolArguments?: (root: string) => Record<string, unknown>;
  requiresApproval?: boolean;
  registerRuntime?: boolean;
  runtimeScopes?: string[];
  runtimeFingerprint?: string;
  leaseTtlMs?: number;
}

function seedFixture(options: FixtureOptions = {}): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "dc-http-issuer-"));
  directories.push(directory);
  const dbPath = join(directory, "control.db");
  const { root, config: containment } = makeRoot("dc-http-issuer-root-");
  roots.push(root);

  const store = new SqliteWorkItemStore(dbPath);
  const toolKind = options.toolKind ?? "read_file";
  const toolName = options.toolName ?? toolKind;
  const toolArguments = (options.toolArguments ?? ((r: string) => ({ path: join(r, "pkg", "a.txt") })))(root);
  const workItem = store.create({
    title: "read a file via desktop commander",
    requester: "agent",
    intent: "inspect a file",
    target: {},
    requestedActions: [{ kind: toolKind, description: "dc action", params: { tool: toolName, arguments: toolArguments } }],
    risk: "low"
  });
  store.approveWorkItem(workItem.id, { via: "domain_service" });

  const plan = store.createExecutionPlan({
    workItemId: workItem.id,
    definition: defaultExecutionPlanForWorkItem(workItem, { executionMode: options.executionMode ?? "desktop_commander" }),
    createdByActorId: "actor-operator"
  });
  const requiresApproval = options.requiresApproval ?? false;
  const admission = store.admitExecutionPlan(
    {
      workItemId: workItem.id,
      planHash: plan.planHash,
      policyVersion: "acs.policy.v1",
      policyDecisionHash: HASH64,
      requiresApproval,
      admittedByActorId: "policy-gate"
    },
    { via: "policy_gate" }
  );

  let approvalId: string | undefined;
  if (requiresApproval) {
    const actionHash = executionActionHash(workItem);
    const approval = store.grantExecutionPlanApproval(
      { workItemId: workItem.id, planHash: plan.planHash, actionHash, approvedByActorId: "human-approver" },
      { via: "domain_service" }
    );
    approvalId = approval.approvalId;
  }

  const claimed = store.claimNextApprovedWorkItem(WORKER_ID, {
    leaseMs: options.leaseTtlMs,
    attemptAuthority: {
      planHash: plan.planHash,
      admissionId: admission.admissionId,
      approvalId,
      policyVersion: admission.policyVersion,
      policyDecisionHash: admission.policyDecisionHash
    }
  });
  if (!claimed) throw new Error("expected a claimed work item");

  const pair = generateKeyPairSync("ed25519");
  const privateKeyDer = pair.privateKey.export({ format: "der", type: "pkcs8" });
  const runtimeFingerprint = options.runtimeFingerprint ?? IDENTITY_FINGERPRINT;
  const config: ManagedCapabilityConfig = {
    runtimeId: "runtime_1",
    runtimeIdentityConfigFingerprint: runtimeFingerprint,
    runtimeScopes: options.runtimeScopes ?? ["fs.read"],
    keyId: "test-key-1",
    privateKey: privateKeyDer.toString("base64url"),
    databasePath: dbPath
  };

  const registry = new SqliteDesktopCommanderRuntimeRegistry(dbPath);
  if (options.registerRuntime ?? true) {
    const bootstrap = registry.issueBootstrap({
      runtimeId: config.runtimeId,
      identityConfigFingerprint: IDENTITY_FINGERPRINT,
      scopes: config.runtimeScopes
    });
    registry.completeBootstrap(bootstrap);
  }

  return { dbPath, store, registry, workItem, claimed, config, containment, root, privateKeyDer, publicKey: pair.publicKey };
}

function auditSink(events: Array<{ name: string; body: Record<string, unknown> }>) {
  return (event: { name: string; body: Record<string, unknown> }) => {
    events.push(event);
  };
}

async function requestFor(fixture: Fixture, overrides: Partial<Parameters<typeof issueDesktopCommanderCapabilityForRequest>[0]> = {}) {
  const events: Array<{ name: string; body: Record<string, unknown> }> = [];
  const result = await issueDesktopCommanderCapabilityForRequest({
    store: fixture.store,
    config: fixture.config,
    containment: fixture.containment,
    capabilityRegistry: fixture.registry,
    persistAuditEvent: auditSink(events),
    workItemId: fixture.workItem.id,
    attemptId: fixture.claimed.attemptId!,
    workerId: fixture.claimed.workerId,
    requestId: "req_test",
    ...overrides
  });
  return { result, events };
}

function verifiesAgainst(fixture: Fixture, capability: { payload: unknown; signature: string }): boolean {
  return verify(null, Buffer.from(strictCanonicalJsonV1(capability.payload), "utf8"), fixture.publicKey, Buffer.from(capability.signature, "base64url"));
}

describe("issueDesktopCommanderCapabilityForRequest", () => {
  it("issues a valid, independently verifiable capability for an authorized, managed invocation", async () => {
    const fixture = seedFixture();
    try {
      const { result: capability, events } = await requestFor(fixture);
      expect(capability.keyId).toBe("test-key-1");
      expect(capability.payload.toolName).toBe("read_file");
      expect(capability.payload.workItemId).toBe(fixture.workItem.id);
      expect(capability.payload.attemptId).toBe(fixture.claimed.attemptId);
      expect(capability.payload.scopes).toEqual(["fs.read"]);
      expect(capability.payload.approvalId).toBeUndefined();
      expect(verifiesAgainst(fixture, capability)).toBe(true);
      expect(events.some((event) => event.name === "desktop_commander.capability_issued")).toBe(true);
      // Nothing about the private key or raw nonce ever appears in audit evidence.
      expect(JSON.stringify(events)).not.toContain(fixture.config.privateKey);
    } finally {
      fixture.registry.close();
      fixture.store.close();
    }
  });

  it("denies a tool that is not on the Desktop Commander allowlist", async () => {
    const fixture = seedFixture({ toolKind: "not_a_real_tool", toolName: "not_a_real_tool", toolArguments: () => ({}) });
    try {
      await expect(requestFor(fixture)).rejects.toThrow(/allowlist/);
    } finally {
      fixture.registry.close();
      fixture.store.close();
    }
  });

  it("denies arguments that fail schema validation for the tool", async () => {
    const fixture = seedFixture({ toolArguments: () => ({ path: 12345 }) });
    try {
      await expect(requestFor(fixture)).rejects.toThrow(/invalid arguments/);
    } finally {
      fixture.registry.close();
      fixture.store.close();
    }
  });

  it("denies a path that escapes every allow root", async () => {
    const fixture = seedFixture({ toolArguments: () => ({ path: "/etc/shadow" }) });
    try {
      await expect(requestFor(fixture)).rejects.toThrow(/outside every allow root/);
    } finally {
      fixture.registry.close();
      fixture.store.close();
    }
  });

  it("denies a plan not admitted for desktop_commander execution (no standalone-mode path)", async () => {
    const fixture = seedFixture({ executionMode: "dry_run" });
    try {
      await expect(requestFor(fixture)).rejects.toThrow(/execution mode/);
    } finally {
      fixture.registry.close();
      fixture.store.close();
    }
  });

  it("denies an unregistered/wrong-fingerprint runtime (wrong runtime/audience binding)", async () => {
    const fixture = seedFixture({ registerRuntime: false });
    try {
      await expect(requestFor(fixture)).rejects.toThrow();
    } finally {
      fixture.registry.close();
      fixture.store.close();
    }

    const drifted = seedFixture({ runtimeFingerprint: "d".repeat(64) });
    try {
      await expect(requestFor(drifted)).rejects.toThrow();
    } finally {
      drifted.registry.close();
      drifted.store.close();
    }
  });

  it("denies a runtime lacking a required scope", async () => {
    const fixture = seedFixture({ runtimeScopes: ["network.read"] });
    try {
      await expect(requestFor(fixture)).rejects.toThrow(/scope/);
    } finally {
      fixture.registry.close();
      fixture.store.close();
    }
  });

  it("requires approval for an approval-gated tool and binds the exact approval id", async () => {
    const fixture = seedFixture({
      toolKind: "write_file",
      toolArguments: (root) => ({ path: join(root, "pkg", "a.txt"), content: "x" }),
      requiresApproval: true,
      runtimeScopes: ["fs.write"]
    });
    try {
      const { result: capability } = await requestFor(fixture);
      expect(capability.payload.approvalId).toBeTruthy();
      expect(capability.payload.scopes).toEqual(["fs.write"]);
    } finally {
      fixture.registry.close();
      fixture.store.close();
    }
  });

  it("rejects an expired lease", async () => {
    const fixture = seedFixture({ leaseTtlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 15));
    try {
      await expect(requestFor(fixture)).rejects.toThrow(/expired/);
    } finally {
      fixture.registry.close();
      fixture.store.close();
    }
  });

  it("denies a caller whose worker identity does not match the attempt's claimant", async () => {
    const fixture = seedFixture();
    try {
      await expect(requestFor(fixture, { workerId: "worker_impersonator" })).rejects.toThrow();
    } finally {
      fixture.registry.close();
      fixture.store.close();
    }
  });

  it("denies an unknown work item id and an unknown attempt id (malformed/unknown references)", async () => {
    const fixture = seedFixture();
    try {
      await expect(requestFor(fixture, { workItemId: "wi_missing" })).rejects.toThrow(/not found/);
      await expect(requestFor(fixture, { attemptId: "attempt_missing" })).rejects.toThrow(/not found/);
    } finally {
      fixture.registry.close();
      fixture.store.close();
    }
  });

  it("rejects a second issuance for the same attempt lease (replay) and a concurrent race yields exactly one winner", async () => {
    const fixture = seedFixture();
    try {
      await requestFor(fixture);
      await expect(requestFor(fixture)).rejects.toThrow();

      const race = seedFixture();
      try {
        const attempts = await Promise.allSettled([requestFor(race), requestFor(race), requestFor(race)]);
        const fulfilled = attempts.filter((entry) => entry.status === "fulfilled");
        const rejected = attempts.filter((entry) => entry.status === "rejected");
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(2);
      } finally {
        race.registry.close();
        race.store.close();
      }
    } finally {
      fixture.registry.close();
      fixture.store.close();
    }
  });

  it("never signs when the durable issuance commit is rejected (issuer/policy unavailable fails closed, nothing is signed)", async () => {
    const fixture = seedFixture();
    try {
      const rejectingRegistry = { recordIssuance: () => { throw new Error("issuance store unavailable"); } };
      const events: Array<{ name: string; body: Record<string, unknown> }> = [];
      await expect(
        issueDesktopCommanderCapabilityForRequest({
          store: fixture.store,
          config: fixture.config,
          containment: fixture.containment,
          capabilityRegistry: rejectingRegistry,
          persistAuditEvent: auditSink(events),
          workItemId: fixture.workItem.id,
          attemptId: fixture.claimed.attemptId!,
          workerId: fixture.claimed.workerId,
          requestId: "req_unavailable"
        })
      ).rejects.toThrow(/unavailable/);
      expect(events.some((event) => event.name === "desktop_commander.capability_denied")).toBe(true);
    } finally {
      fixture.registry.close();
      fixture.store.close();
    }
  });

  it("fails closed when the configured signing key is unusable (signing key unavailable)", async () => {
    const fixture = seedFixture();
    try {
      const brokenConfig: ManagedCapabilityConfig = { ...fixture.config, privateKey: Buffer.from("not-a-real-key").toString("base64url") };
      await expect(requestFor(fixture, { config: brokenConfig })).rejects.toThrow();
    } finally {
      fixture.registry.close();
      fixture.store.close();
    }
  });

  it("mutating the signed payload after issuance invalidates the signature (mutated args / forged signature)", async () => {
    const fixture = seedFixture();
    try {
      const { result: capability } = await requestFor(fixture);
      const mutated = { ...capability.payload, normalizedArguments: { path: "/tmp/somewhere-else" } };
      expect(verify(null, Buffer.from(strictCanonicalJsonV1(mutated), "utf8"), fixture.publicKey, Buffer.from(capability.signature, "base64url"))).toBe(false);
      const forgedSignature = `${capability.signature.startsWith("A") ? "B" : "A"}${capability.signature.slice(1)}`;
      expect(verify(null, Buffer.from(strictCanonicalJsonV1(capability.payload), "utf8"), fixture.publicKey, Buffer.from(forgedSignature, "base64url"))).toBe(false);
    } finally {
      fixture.registry.close();
      fixture.store.close();
    }
  });

  it("wrong child public key: a capability signed by this issuer does not verify against an unrelated key", async () => {
    const fixture = seedFixture();
    try {
      const { result: capability } = await requestFor(fixture);
      const other = generateKeyPairSync("ed25519");
      expect(verify(null, Buffer.from(strictCanonicalJsonV1(capability.payload), "utf8"), other.publicKey, Buffer.from(capability.signature, "base64url"))).toBe(false);
    } finally {
      fixture.registry.close();
      fixture.store.close();
    }
  });
});
