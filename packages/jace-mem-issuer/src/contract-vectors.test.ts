/**
 * acs.jm.v1 shared contract vectors.
 *
 * The committed file (packages/jace-mem-issuer/vectors/acs-jm-v1-contract-vectors.json) holds capabilities
 * minted by the REAL issuer path (work item -> policy -> approval -> lease -> registry -> sign) for every tool,
 * plus negative cases derived from them, each naming the rejection code Jace-Mem's verifier must return. Jace-Mem
 * runs the same file through its verifier (jace-mem test/acs-vectors.test.ts); that is the drift check between
 * the issuer here and the verifier there.
 *
 * Regenerate with: UPDATE_JM_VECTORS=1 npx vitest run packages/jace-mem-issuer/src/contract-vectors.test.ts
 * Each regeneration uses a fresh throwaway key pair; only its public key is committed, so the file holds no
 * private key material.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import {
  JM_TOOL_NAMES,
  authorizeJaceMemExecution,
  jaceMemInvocationHash,
  jmToolContract,
  prepareJaceMemCapability,
  signPreparedJaceMemCapability,
  SqliteJaceMemIssuanceRegistry,
  type JaceMemCapability
} from "./index.js";
import { RUNTIME, SUBJECT, TOOL_ARGS, WORKER, claimFor } from "./test-support.js";

const VECTOR_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "vectors", "acs-jm-v1-contract-vectors.json");
const KEY_ID = "acs-jm-v1-vector-key";

interface Case {
  name: string;
  toolName: string;
  arguments: Record<string, unknown>;
  identity: typeof SUBJECT;
  capability: unknown;
  /** ISO time the verifier must use as "now". */
  verifyAt: string;
  /** Expected Jace-Mem rejection code; absent for positive cases. */
  expect?: string;
}
interface VectorFile {
  contract: "acs.jm.v1";
  note: string;
  keyId: string;
  publicKey: string;
  runtimeId: string;
  positive: Case[];
  negative: Case[];
}

function mint(privateKey: string): Case[] {
  const directory = mkdtempSync(join(tmpdir(), "jm-vectors-"));
  try {
    return JM_TOOL_NAMES.map((tool) => {
      const dbPath = join(directory, `${tool}.db`);
      const c = claimFor(dbPath, tool);
      const registry = new SqliteJaceMemIssuanceRegistry(dbPath);
      try {
        const lease = c.store.getActiveLeaseForAttempt(c.claimed.attemptId!)!;
        const approval = lease.approvalId ? c.store.getExecutionPlanApprovalById(lease.approvalId) : undefined;
        const authorization = authorizeJaceMemExecution({
          claimed: c.claimed,
          trustedWorkItem: c.store.get(c.item.id)!,
          lease,
          workerId: WORKER,
          invocation: c.invocation,
          subject: SUBJECT,
          ...(approval ? { approvalActionHash: approval.actionHash } : {})
        });
        const config = { privateKey, keyId: KEY_ID, runtimeId: RUNTIME };
        const payload = prepareJaceMemCapability(authorization, config);
        registry.recordIssuance({
          runtimeId: RUNTIME,
          toolName: tool,
          leaseId: payload.leaseId,
          attemptId: payload.attemptId,
          workItemId: payload.workItemId,
          workerId: WORKER,
          fencingEpoch: payload.leaseEpoch,
          planHash: payload.planHash,
          actionHash: payload.actionHash,
          invocationHash: payload.invocationHash,
          subject: SUBJECT,
          requesterSubject: authorization.requesterSubject,
          ...(payload.approvalId ? { approvalId: payload.approvalId } : {}),
          keyId: KEY_ID,
          nonce: payload.nonce,
          issuedAt: payload.issuedAt,
          expiresAt: payload.expiresAt
        });
        const capability = signPreparedJaceMemCapability(payload, config);
        return {
          name: `${tool} issued by ACS`,
          toolName: tool,
          arguments: TOOL_ARGS[tool]!,
          identity: SUBJECT,
          capability,
          verifyAt: new Date(Date.parse(payload.issuedAt) + 1_000).toISOString()
        };
      } finally {
        registry.close();
        c.store.close();
      }
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Re-sign a mutated payload with the vector key so only the mutation (not the signature) is under test. */
function resign(
  capability: JaceMemCapability,
  privateKey: string,
  mutate: (payload: Record<string, unknown>) => void
): JaceMemCapability {
  const payload = structuredClone(capability.payload) as unknown as Record<string, unknown>;
  mutate(payload);
  const key = createPrivateKey({ key: Buffer.from(privateKey, "base64url"), format: "der", type: "pkcs8" });
  return {
    payload: payload as never,
    keyId: capability.keyId,
    signature: sign(null, Buffer.from(strictCanonicalJsonV1(payload), "utf8"), key).toString("base64url")
  };
}

function negatives(positive: Case[], privateKey: string): Case[] {
  const byTool = Object.fromEntries(positive.map((c) => [c.toolName, c]));
  const search = byTool.memory_search!;
  const del = byTool.memory_delete!;
  const share = byTool.memory_search_shared!;
  const cap = (c: Case) => c.capability as JaceMemCapability;
  const variant = (base: Case, name: string, expectCode: string, change: Partial<Case>): Case => ({
    ...base,
    ...change,
    name,
    expect: expectCode
  });
  return [
    variant(search, "capability minted for agent-a used by a process launched as agent-b", "subject_mismatch", {
      identity: { ...SUBJECT, agent: "agent-b" }
    }),
    variant(search, "capability used from another worktree of the same agent", "subject_mismatch", {
      identity: { ...SUBJECT, worktree: "/srv/synthetic/other" }
    }),
    variant(search, "subject re-signed for another agent", "subject_mismatch", {
      capability: resign(cap(search), privateKey, (p) => {
        (p.subject as Record<string, string>).agent = "agent-b";
      })
    }),
    variant(search, "subject with an extra field", "subject_malformed", {
      capability: resign(cap(search), privateKey, (p) => {
        (p.subject as Record<string, string>).role = "admin";
      })
    }),
    variant(search, "acs.jc.v1 version", "version_mismatch", {
      capability: resign(cap(search), privateKey, (p) => {
        p.version = "acs.jc.v1";
      })
    }),
    variant(search, "jace-commander audience", "audience_mismatch", {
      capability: resign(cap(search), privateKey, (p) => {
        p.audience = "jace-commander";
      })
    }),
    variant(search, "other issuer", "issuer_mismatch", {
      capability: resign(cap(search), privateKey, (p) => {
        p.issuer = "not-acs";
      })
    }),
    variant(search, "other runtime", "runtime_mismatch", {
      capability: resign(cap(search), privateKey, (p) => {
        p.runtimeId = "other-runtime";
      })
    }),
    variant(search, "read capability presented for memory_get", "tool_mismatch", {
      toolName: "memory_get",
      arguments: { id: "obs-1" }
    }),
    variant(search, "delivered arguments differ from the signed arguments", "arguments_mismatch", {
      arguments: { query: "other", limit: 10 }
    }),
    variant(search, "read capability widened to delete scope", "scope_mismatch", {
      capability: resign(cap(search), privateKey, (p) => {
        p.scopes = ["memory.delete", "memory.read"];
      })
    }),
    variant(search, "read capability carrying an approvalId", "payload_keys", {
      capability: resign(cap(search), privateKey, (p) => {
        p.approvalId = "approval-x";
      })
    }),
    variant(search, "extra payload key", "payload_keys", {
      capability: resign(cap(search), privateKey, (p) => {
        p.admin = true;
      })
    }),
    variant(search, "lifetime over 30 seconds", "lifetime_invalid", {
      capability: resign(cap(search), privateKey, (p) => {
        p.expiresAt = new Date(Date.parse(p.issuedAt as string) + 31_000).toISOString();
      })
    }),
    variant(search, "verified after expiry plus skew", "expired", {
      verifyAt: new Date(Date.parse(cap(search).payload.expiresAt) + 6_000).toISOString()
    }),
    variant(search, "verified before issuance minus skew", "not_yet_valid", {
      verifyAt: new Date(Date.parse(cap(search).payload.issuedAt) - 6_000).toISOString()
    }),
    variant(search, "tampered payload without re-signing", "signature_invalid", {
      capability: {
        ...cap(search),
        payload: { ...cap(search).payload, leaseEpoch: cap(search).payload.leaseEpoch + 1 }
      }
    }),
    variant(search, "unknown key id", "key_unknown", { capability: { ...cap(search), keyId: "other-key" } }),
    variant(search, "envelope with an extra field", "capability_malformed", {
      capability: { ...cap(search), extra: 1 }
    }),
    variant(search, "malformed nonce", "nonce_malformed", {
      capability: resign(cap(search), privateKey, (p) => {
        p.nonce = "short";
      })
    }),
    variant(del, "delete capability without its approval (approval bypass)", "approval_missing", {
      capability: resign(cap(del), privateKey, (p) => {
        delete p.approvalId;
      })
    }),
    variant(del, "delete capability presented for another observation", "arguments_mismatch", {
      arguments: { id: "obs-2" }
    }),
    variant(share, "share capability presented against another target agent", "arguments_mismatch", {
      arguments: { targetAgent: "agent-c", query: "synthetic" }
    })
  ];
}

function load(): VectorFile {
  return JSON.parse(readFileSync(VECTOR_FILE, "utf8")) as VectorFile;
}

describe("acs.jm.v1 contract vectors", () => {
  it.runIf(process.env.UPDATE_JM_VECTORS === "1")("regenerates the vector file from the real issuer", () => {
    const privateKey = generateKeyPairSync("ed25519")
      .privateKey.export({ format: "der", type: "pkcs8" })
      .toString("base64url");
    const publicKey = createPublicKey(
      createPrivateKey({ key: Buffer.from(privateKey, "base64url"), format: "der", type: "pkcs8" })
    )
      .export({ format: "der", type: "spki" })
      .toString("base64url");
    const positive = mint(privateKey);
    const file: VectorFile = {
      contract: "acs.jm.v1",
      note: "Synthetic identities and a throwaway key (private half discarded). Positive capabilities were minted by the ACS issuer path; negatives name the Jace-Mem rejection code.",
      keyId: KEY_ID,
      publicKey,
      runtimeId: RUNTIME,
      positive,
      negative: negatives(positive, privateKey)
    };
    mkdirSync(dirname(VECTOR_FILE), { recursive: true });
    writeFileSync(VECTOR_FILE, `${JSON.stringify(file, null, 2)}\n`);
  });

  it("committed positive vectors verify and match the current manifest", () => {
    const file = load();
    const publicKey = createPublicKey({ key: Buffer.from(file.publicKey, "base64url"), format: "der", type: "spki" });
    expect(file.positive.map((c) => c.toolName)).toEqual([...JM_TOOL_NAMES]);
    for (const c of file.positive) {
      const { payload, signature, keyId } = c.capability as JaceMemCapability;
      expect(keyId).toBe(file.keyId);
      expect(
        verify(
          null,
          Buffer.from(strictCanonicalJsonV1(payload), "utf8"),
          publicKey,
          Buffer.from(signature, "base64url")
        ),
        c.name
      ).toBe(true);
      expect(payload.invocationHash).toBe(jaceMemInvocationHash(c.toolName, c.arguments));
      expect(payload.normalizedArguments).toEqual(c.arguments);
      expect(payload.scopes).toEqual([...jmToolContract(c.toolName)!.scopes]);
      expect("approvalId" in payload).toBe(jmToolContract(c.toolName)!.requiresApproval);
      expect(payload.subject).toEqual(c.identity);
    }
  });

  it("committed negative vectors each name one expected rejection and cover the required attack classes", () => {
    const file = load();
    expect(file.negative.length).toBeGreaterThanOrEqual(20);
    const codes = new Set(file.negative.map((c) => c.expect));
    for (const required of [
      "subject_mismatch",
      "approval_missing",
      "scope_mismatch",
      "arguments_mismatch",
      "signature_invalid",
      "expired",
      "audience_mismatch",
      "version_mismatch"
    ]) {
      expect(codes, required).toContain(required);
    }
  });
});
