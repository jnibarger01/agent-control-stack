import { generateKeyPairSync, createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACS_ADMIN_APPROVER,
  createPolicyEngine,
  createWorkItemTools,
  evaluateWorkItemPolicy,
  summarizePolicy
} from "@agent-control-stack/policy-gate";
import { strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import {
  JM_TOOL_NAMES,
  authorizeJaceMemExecution,
  jaceMemSigningConfigFromEnv,
  jaceMemSubjectHash,
  jaceMemVerificationKey,
  jmToolContracts,
  prepareJaceMemCapability,
  signPreparedJaceMemCapability,
  validateJaceMemInvocation,
  validateJaceMemSubject,
  SqliteJaceMemIssuanceRegistry,
  type JaceMemSubject
} from "./index.js";
import { HUMAN, RUNTIME, SUBJECT, TOOL_ARGS, WORKER, claimFor, workItemInput, type Claimed } from "./test-support.js";

const { privateKey } = generateKeyPairSync("ed25519");
const SIGNING = {
  privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
  keyId: "jm-test-key",
  runtimeId: RUNTIME
};

const directories: string[] = [];
const open: { close(): void }[] = [];
afterEach(() => {
  for (const handle of open.splice(0)) handle.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function database(): string {
  const directory = mkdtempSync(join(tmpdir(), "jm-issuer-"));
  directories.push(directory);
  return join(directory, "control.db");
}
function claim(dbPath: string, tool: string, options: Parameters<typeof claimFor>[2] = {}): Claimed {
  const result = claimFor(dbPath, tool, options);
  open.push(result.store);
  return result;
}
function registry(dbPath: string): SqliteJaceMemIssuanceRegistry {
  const r = new SqliteJaceMemIssuanceRegistry(dbPath);
  open.push(r);
  return r;
}

/** The full issuer path the route will run: authorize -> prepare -> record (commit) -> sign. */
function issue(dbPath: string, c: Claimed, subject: JaceMemSubject = SUBJECT) {
  const lease = c.store.getActiveLeaseForAttempt(c.claimed.attemptId!)!;
  const trusted = c.store.get(c.item.id)!;
  const approval = lease.approvalId ? c.store.getExecutionPlanApprovalById(lease.approvalId) : undefined;
  const authorization = authorizeJaceMemExecution({
    claimed: c.claimed,
    trustedWorkItem: trusted,
    lease,
    workerId: WORKER,
    invocation: c.invocation,
    subject,
    ...(approval ? { approvalActionHash: approval.actionHash } : {})
  });
  const payload = prepareJaceMemCapability(authorization, SIGNING);
  const recorded = registry(dbPath).recordIssuance({
    runtimeId: payload.runtimeId,
    toolName: payload.toolName,
    leaseId: payload.leaseId,
    attemptId: payload.attemptId,
    workItemId: payload.workItemId,
    workerId: WORKER,
    fencingEpoch: payload.leaseEpoch,
    planHash: payload.planHash,
    actionHash: payload.actionHash,
    invocationHash: payload.invocationHash,
    subject: payload.subject,
    requesterSubject: authorization.requesterSubject,
    ...(payload.approvalId ? { approvalId: payload.approvalId } : {}),
    keyId: SIGNING.keyId,
    nonce: payload.nonce,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt
  });
  expect(recorded.requestHash).toBe(payload.requestHash);
  return signPreparedJaceMemCapability(payload, SIGNING);
}

describe("acs.jm.v1 manifest", () => {
  it("covers exactly the ten Jace-Mem tools with one distinct scope each", () => {
    expect(jmToolContracts().map((tool) => tool.name)).toEqual([...JM_TOOL_NAMES]);
    expect([...new Set(jmToolContracts().map((tool) => tool.scopes[0]!))].sort()).toEqual([
      "memory.delete",
      "memory.read",
      "memory.share",
      "memory.write"
    ]);
    for (const tool of jmToolContracts()) {
      expect(tool.scopes).toHaveLength(1);
      expect(tool.requiresApproval).toBe(tool.scopes[0] === "memory.delete" || tool.scopes[0] === "memory.share");
    }
  });

  it("rejects unknown tools, extra keys, coercible values and blank text", () => {
    expect(() => validateJaceMemInvocation("memory_purge", {})).toThrow(
      expect.objectContaining({ code: "jace_mem_tool_not_allowlisted" })
    );
    expect(() => validateJaceMemInvocation("constructor", {})).toThrow(
      expect.objectContaining({ code: "jace_mem_tool_not_allowlisted" })
    );
    for (const [tool, args] of [
      ["memory_status", { principal: "other" }],
      ["memory_search", { query: "x", limit: "5" }],
      ["memory_search", { query: "x", limit: 101 }],
      ["memory_capture", { ...TOOL_ARGS.memory_capture, text: "   " }],
      ["memory_capture", { ...TOOL_ARGS.memory_capture, kind: "SECRET" }],
      ["memory_capture", { ...TOOL_ARGS.memory_capture, text: "x".repeat(65_537) }],
      ["memory_retain_since", { cutoff: "yesterday" }],
      ["memory_search_shared", { targetAgent: " agent-b", query: "x" }],
      ["session_end", { session: undefined }],
      ["session_start", []]
    ] as const) {
      expect(() => validateJaceMemInvocation(tool, args), `${tool} ${JSON.stringify(args)}`).toThrow(
        expect.objectContaining({ code: "jace_mem_argument_invalid" })
      );
    }
  });

  it("validates subjects with Jace-Mem's identity rules", () => {
    expect(validateJaceMemSubject(SUBJECT)).toEqual(SUBJECT);
    for (const bad of [
      { ...SUBJECT, agent: "" },
      { ...SUBJECT, agent: " agent-a" },
      { ...SUBJECT, agent: "agent\u0000a" },
      { ...SUBJECT, agent: "agent​a" },
      { ...SUBJECT, project: "p".repeat(257) },
      { ...SUBJECT, extra: "x" },
      { principal: "p", agent: "a", project: "x", worktree: "/w" }
    ]) {
      expect(() => validateJaceMemSubject(bad)).toThrow(expect.objectContaining({ code: "jace_mem_subject_invalid" }));
    }
  });
});

describe("acs.jm.v1 policy", () => {
  it("allows read and write, and requires a human other than the requester or admin for delete and share", () => {
    const store = new SqliteWorkItemStore(database());
    open.push(store);
    const tools = createWorkItemTools(store, createPolicyEngine());
    for (const tool of JM_TOOL_NAMES) {
      const invocation = validateJaceMemInvocation(tool, TOOL_ARGS[tool]);
      const item = tools.create_work_item(workItemInput(invocation, SUBJECT));
      if (!invocation.policy.requiresApproval) {
        expect(item.status, tool).toBe("approved");
        continue;
      }
      expect(item.status, tool).toBe("needs_approval");
      expect(summarizePolicy(evaluateWorkItemPolicy(item, SUBJECT.agent, "approve"))).toMatchObject({
        decision: "deny",
        matchedRules: ["deny:self-approval"]
      });
      expect(summarizePolicy(evaluateWorkItemPolicy(item, ACS_ADMIN_APPROVER, "approve"))).toMatchObject({
        decision: "deny",
        matchedRules: ["deny:jm-admin-approval"]
      });
      expect(summarizePolicy(evaluateWorkItemPolicy(item, HUMAN, "approve")).decision).toBe("require_approval");
    }
  });
});

describe("acs.jm.v1 issuance", () => {
  for (const tool of JM_TOOL_NAMES) {
    it(`${tool}: issues a capability whose signature and bindings verify`, () => {
      const dbPath = database();
      const c = claim(dbPath, tool);
      const capability = issue(dbPath, c);
      const { payload } = capability;
      const publicKey = createPublicKey({
        key: Buffer.from(jaceMemVerificationKey(SIGNING), "base64url"),
        format: "der",
        type: "spki"
      });
      expect(
        verify(
          null,
          Buffer.from(strictCanonicalJsonV1(payload), "utf8"),
          publicKey,
          Buffer.from(capability.signature, "base64url")
        )
      ).toBe(true);
      expect(payload).toMatchObject({
        version: "acs.jm.v1",
        issuer: "acs",
        audience: "jace-mem",
        runtimeId: RUNTIME,
        subject: SUBJECT,
        toolName: tool
      });
      expect(payload.normalizedArguments).toEqual(TOOL_ARGS[tool]);
      expect(payload.scopes).toEqual([...c.invocation.policy.scopes]);
      expect("approvalId" in payload).toBe(c.invocation.policy.requiresApproval);
      expect(Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt)).toBeLessThanOrEqual(30_000);
      // One capability per lease + invocation: a second issuance for the same claim is refused.
      expect(() => issue(dbPath, c)).toThrow(expect.objectContaining({ code: "jace_mem_capability_already_issued" }));
    });
  }

  it("refuses a subject for an agent other than the attested requester (impersonation)", () => {
    const dbPath = database();
    const c = claim(dbPath, "memory_search");
    expect(() => issue(dbPath, c, { ...SUBJECT, agent: "agent-b" })).toThrow(
      expect.objectContaining({ code: "jace_mem_subject_binding_mismatch" })
    );
    expect(() => issue(dbPath, c, { ...SUBJECT, worktree: "/srv/other" })).toThrow(
      expect.objectContaining({ code: "jace_mem_subject_binding_mismatch" })
    );
    // A work item whose bound subject names another agent than its requester is refused even though the hashes agree.
    const forged = claim(database(), "memory_search", {
      subject: { ...SUBJECT, agent: "agent-b" },
      requesterSubject: "agent-a"
    });
    expect(() => issue(dbPath, forged, { ...SUBJECT, agent: "agent-b" })).toThrow(
      expect.objectContaining({ code: "jace_mem_subject_agent_mismatch" })
    );
  });

  it("refuses a shared search that targets the requester itself", () => {
    const dbPath = database();
    const c = claim(dbPath, "memory_search_shared", { args: { targetAgent: SUBJECT.agent, query: "x" } });
    expect(() => issue(dbPath, c)).toThrow(expect.objectContaining({ code: "jace_mem_share_target_invalid" }));
  });

  for (const tool of JM_TOOL_NAMES.filter((name) =>
    ["memory_delete", "session_delete", "memory_retain_since", "memory_search_shared"].includes(name)
  )) {
    for (const [approver, code] of [
      [SUBJECT.agent, "jace_mem_self_approval_denied"],
      [ACS_ADMIN_APPROVER, "jace_mem_human_approval_required"]
    ] as const) {
      it(`${tool}: the registry refuses a forged approval by ${approver} (${code})`, () => {
        const dbPath = database();
        const c = claim(dbPath, tool, { approver, forge: true });
        expect(() => issue(dbPath, c)).toThrow(expect.objectContaining({ code }));
      });
    }
  }

  it("refuses a stale fencing epoch, an inactive lease and a missing approval", () => {
    const dbPath = database();
    const c = claim(dbPath, "memory_capture");
    const lease = c.store.getActiveLeaseForAttempt(c.claimed.attemptId!)!;
    const trusted = c.store.get(c.item.id)!;
    const base = {
      claimed: c.claimed,
      trustedWorkItem: trusted,
      lease,
      workerId: WORKER,
      invocation: c.invocation,
      subject: SUBJECT
    };
    expect(() =>
      authorizeJaceMemExecution({ ...base, lease: { ...lease, fencingEpoch: lease.fencingEpoch + 1 } })
    ).toThrow(expect.objectContaining({ code: "jace_mem_lease_fencing_mismatch" }));
    expect(() => authorizeJaceMemExecution({ ...base, lease: { ...lease, status: "revoked" as never } })).toThrow(
      expect.objectContaining({ code: "jace_mem_lease_inactive" })
    );
    expect(() => authorizeJaceMemExecution({ ...base, workerId: "other-worker" })).toThrow(
      expect.objectContaining({ code: "jace_mem_lease_worker_mismatch" })
    );
    expect(() => authorizeJaceMemExecution({ ...base, now: new Date(Date.parse(lease.expiresAt) + 1) })).toThrow(
      expect.objectContaining({ code: "jace_mem_lease_expired" })
    );
    expect(() =>
      authorizeJaceMemExecution({
        ...base,
        invocation: validateJaceMemInvocation("memory_capture", { ...TOOL_ARGS.memory_capture, text: "other" })
      })
    ).toThrow(expect.objectContaining({ code: "jace_mem_invocation_binding_mismatch" }));
    expect(() => authorizeJaceMemExecution({ ...base, approvalActionHash: "a".repeat(64) })).toThrow(
      expect.objectContaining({ code: "jace_mem_approval_unexpected" })
    );

    // The registry re-derives the lease from ACS state: a payload naming another epoch is refused.
    const payload = prepareJaceMemCapability(authorizeJaceMemExecution(base), SIGNING);
    expect(() =>
      registry(dbPath).recordIssuance({
        runtimeId: RUNTIME,
        toolName: "memory_capture",
        leaseId: payload.leaseId,
        attemptId: payload.attemptId,
        workItemId: payload.workItemId,
        workerId: WORKER,
        fencingEpoch: payload.leaseEpoch + 1,
        planHash: payload.planHash,
        actionHash: payload.actionHash,
        invocationHash: payload.invocationHash,
        subject: SUBJECT,
        requesterSubject: SUBJECT.agent,
        keyId: SIGNING.keyId,
        nonce: payload.nonce,
        issuedAt: payload.issuedAt,
        expiresAt: payload.expiresAt
      })
    ).toThrow(expect.objectContaining({ code: "jace_mem_capability_lease_rejected" }));
  });

  it("the issuance table itself rejects illegal rows even if the registry were bypassed", () => {
    const dbPath = database();
    const c = claim(dbPath, "memory_capture");
    issue(dbPath, c);
    const r = registry(dbPath) as unknown as { db: import("node:sqlite").DatabaseSync };
    const row = r.db.prepare("SELECT * FROM jace_mem_capability_issuances").get() as Record<string, unknown>;
    const insert = (overrides: Record<string, unknown>) => {
      const values = {
        ...row,
        capability_issuance_id: `x-${randomBytes(4).toString("hex")}`,
        nonce_hash: randomBytes(32).toString("hex"),
        invocation_hash: randomBytes(32).toString("hex"),
        ...overrides
      };
      const keys = Object.keys(values);
      r.db
        .prepare(
          `INSERT INTO jace_mem_capability_issuances (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`
        )
        .run(...(Object.values(values) as never[]));
    };
    expect(() => insert({ scope: "memory.delete" })).toThrow(/CHECK constraint/u);
    expect(() => insert({ tool_name: "memory_delete", scope: "memory.delete" })).toThrow(/CHECK constraint/u);
    expect(() => insert({ expires_at: new Date(Date.parse(row.issued_at as string) + 31_000).toISOString() })).toThrow(
      /CHECK constraint/u
    );
    expect(() => r.db.prepare("UPDATE jace_mem_capability_issuances SET key_id = 'k'").run()).toThrow(/append-only/u);
    expect(() => r.db.prepare("DELETE FROM jace_mem_capability_issuances").run()).toThrow(/append-only/u);
    expect(row.subject_hash).toBe(jaceMemSubjectHash(SUBJECT));
    expect(JSON.stringify(row)).not.toContain(SUBJECT.worktree);
  });
});

describe("acs.jm.v1 signing configuration", () => {
  it("is absent, complete, or rejected; and must not reuse another audience's key", () => {
    expect(jaceMemSigningConfigFromEnv({})).toBeUndefined();
    expect(() => jaceMemSigningConfigFromEnv({ ACS_JACE_MEM_CAPABILITY_KEY_ID: "k" })).toThrow(
      expect.objectContaining({ code: "jace_mem_capability_config_incomplete" })
    );
    const env = {
      ACS_JACE_MEM_CAPABILITY_PRIVATE_KEY: SIGNING.privateKey,
      ACS_JACE_MEM_CAPABILITY_KEY_ID: "k",
      ACS_JACE_MEM_RUNTIME_ID: RUNTIME
    };
    expect(jaceMemSigningConfigFromEnv(env)).toMatchObject({ keyId: "k", runtimeId: RUNTIME });
    expect(() =>
      jaceMemSigningConfigFromEnv({ ...env, ACS_JACE_COMMANDER_CAPABILITY_PRIVATE_KEY: SIGNING.privateKey })
    ).toThrow(expect.objectContaining({ code: "jace_mem_capability_key_shared" }));
    expect(() =>
      jaceMemSigningConfigFromEnv({ ...env, ACS_DESKTOP_COMMANDER_CAPABILITY_PRIVATE_KEY: SIGNING.privateKey })
    ).toThrow(expect.objectContaining({ code: "jace_mem_capability_key_shared" }));
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ format: "der", type: "pkcs8" })
      .toString("base64url");
    expect(() => jaceMemSigningConfigFromEnv({ ...env, ACS_JACE_MEM_CAPABILITY_PRIVATE_KEY: rsa })).toThrow(
      expect.objectContaining({ code: "jace_mem_capability_invalid" })
    );
    expect(() => jaceMemSigningConfigFromEnv({ ...env, ACS_JACE_MEM_RUNTIME_ID: "bad runtime" })).toThrow(
      expect.objectContaining({ code: "jace_mem_capability_invalid" })
    );
  });
});
