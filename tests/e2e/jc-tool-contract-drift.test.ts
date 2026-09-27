/**
 * Cross-layer Jace Commander tool-contract drift gate.
 *
 * The bug class this exists for: one layer accepts a tool that another layer
 * does not recognize (or maps to a different scope / approval rule) — the
 * same class of bug tests/e2e/dc-tool-contract-drift.test.ts guards against
 * for Desktop Commander. Two layers are compared against
 * @agent-control-stack/jc-tool-manifest:
 *
 *   ACS  packages/desktop-commander-adapter/src/jace-commander.ts (issuer: policy, schemas)
 *   JC   vendor/desktop-commander/src/jace-commander/contract.ts  (enforcer: scopes, policy table)
 *
 * Deliberately NOT imported here: vendor/desktop-commander/src/jace-commander/server.ts
 * (JC_TOOLS, the MCP tools/list surface). It pulls in @modelcontextprotocol/sdk,
 * which is only installed under vendor/desktop-commander's own node_modules —
 * a separate CI job installs those, but this root-level test file's job does
 * not (vendor/desktop-commander is a subtree, not an npm workspace member).
 * dc-tool-contract-drift.test.ts follows the same rule (it imports
 * managed-acs.ts, never Desktop Commander's server.ts) for the same reason.
 * JC_TOOLS vs. JC_TOOL_POLICIES name-set consistency is instead enforced by
 * vendor/desktop-commander's own assertToolPolicyCoverage(), which runs
 * every time its server starts and is exercised in its own test suite
 * (test/test-jace-commander-*.js, run where the SDK is installed);
 * transitively, that plus this file's manifest<->JC_TOOL_POLICIES check
 * covers manifest<->JC_TOOLS too.
 *
 * Exercised end to end in-process: a locally generated Ed25519 key mints an
 * acs.jc.v1 capability for a non-approval and an approval-gated tool, and
 * Jace Commander's own real JcCapabilityVerifier must accept or reject it
 * exactly as the manifest says it should — behavioral parity, not just data
 * parity.
 */
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  JC_ACTION_KINDS,
  JC_AUDIENCE,
  JC_CAPABILITY_VERSION,
  JC_SCOPES,
  jcToolContracts
} from "@agent-control-stack/jc-tool-manifest";
import { jaceCommanderToolNames, jaceCommanderToolPolicy } from "@agent-control-stack/desktop-commander-adapter";
import * as jcContract from "../../vendor/desktop-commander/src/jace-commander/contract.ts";
import { strictCanonicalJsonV1 } from "../../vendor/desktop-commander/src/managed-acs.ts";

const KEY_ID = "drift-jc-key-1";
const RUNTIME_ID = "runtime_jc_drift";

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64url")
  };
}

function mint(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  toolName: string,
  normalizedArguments: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
) {
  const policy = jcContract.JC_TOOL_POLICIES[toolName]!;
  const now = Date.now();
  const payload = {
    version: JC_CAPABILITY_VERSION,
    issuer: "acs",
    audience: JC_AUDIENCE,
    runtimeId: RUNTIME_ID,
    workItemId: "wi-drift-1",
    attemptId: "att-drift-1",
    leaseId: "lease-drift-1",
    leaseEpoch: 1,
    toolName,
    normalizedArguments,
    invocationHash: jcContract.computeJcInvocationHash(toolName, normalizedArguments),
    actionHash: randomBytes(32).toString("hex"),
    requestHash: randomBytes(32).toString("hex"),
    planHash: randomBytes(32).toString("hex"),
    scopes: [...policy.scopes],
    ...(policy.requiresApproval ? { approvalId: "appr-drift-1" } : {}),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 20_000).toISOString(),
    nonce: randomBytes(32).toString("base64url"),
    ...overrides
  };
  for (const [key, value] of Object.entries(overrides))
    if (value === undefined) delete (payload as Record<string, unknown>)[key];
  const signature = sign(null, Buffer.from(strictCanonicalJsonV1(payload), "utf8"), privateKey).toString("base64url");
  return { payload, signature, keyId: KEY_ID };
}

describe("jc-tool-manifest drift gate", () => {
  it("lists the same tool set in the manifest, ACS's adapter, and DC's policy table", () => {
    const manifestNames = jcToolContracts()
      .map((entry) => entry.name)
      .sort();
    expect(jaceCommanderToolNames().sort()).toEqual(manifestNames);
    expect(Object.keys(jcContract.JC_TOOL_POLICIES).sort()).toEqual(manifestNames);
  });

  it("agrees on scopes and approval requirement for every tool, across the manifest, ACS and DC", () => {
    for (const entry of jcToolContracts()) {
      const acsPolicy = jaceCommanderToolPolicy(entry.name);
      expect(acsPolicy, `ACS is missing a policy for ${entry.name}`).toBeDefined();
      expect(acsPolicy!.scopes).toEqual(entry.scopes);
      expect(acsPolicy!.requiresApproval).toBe(entry.requiresApproval);
      expect(acsPolicy!.actionKind).toBe(entry.actionKind);
      expect(acsPolicy!.risk).toBe(entry.risk);

      const dcPolicy = jcContract.JC_TOOL_POLICIES[entry.name];
      expect(dcPolicy, `DC is missing a policy for ${entry.name}`).toBeDefined();
      expect([...dcPolicy!.scopes]).toEqual(entry.scopes);
      expect(dcPolicy!.requiresApproval).toBe(entry.requiresApproval);

      for (const scope of entry.scopes) expect(JC_SCOPES).toContain(scope);
      expect(JC_ACTION_KINDS).toContain(entry.actionKind);
    }
  });

  it("has no DC policy for a tool the manifest doesn't define, and vice versa", () => {
    const manifestNames = new Set(jcToolContracts().map((entry) => entry.name));
    expect(new Set(Object.keys(jcContract.JC_TOOL_POLICIES))).toEqual(manifestNames);
  });

  describe("behavioral parity: DC's real verifier enforces exactly what the manifest says", () => {
    let dir: string;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    function verifier(publicKey: string) {
      dir = mkdtempSync(join(tmpdir(), "jc-drift-nonces-"));
      return new jcContract.JcCapabilityVerifier({
        publicKey,
        keyId: KEY_ID,
        runtimeId: RUNTIME_ID,
        nonceStore: new jcContract.FileNonceStore(dir)
      });
    }

    it("accepts a correctly-scoped capability for a non-approval tool (jc_status)", () => {
      const { privateKey, publicKey } = keys();
      const capability = mint(privateKey, "jc_status", {});
      const result = verifier(publicKey).verify("jc_status", {}, capability);
      expect(result.toolName).toBe("jc_status");
      expect(result.scopes).toEqual(["integration.read"]);
    });

    it("rejects privileged_exec without an approvalId, even with a valid signature", () => {
      const { privateKey, publicKey } = keys();
      const args = { argv: ["/bin/true"] };
      const capability = mint(privateKey, "privileged_exec", args, { approvalId: undefined });
      expect(() => verifier(publicKey).verify("privileged_exec", args, capability)).toThrow(
        /JC_CAPABILITY_APPROVAL_REQUIRED/
      );
    });

    it("accepts privileged_exec with an approvalId bound to the exact argv", () => {
      const { privateKey, publicKey } = keys();
      const args = { argv: ["/bin/true"] };
      const capability = mint(privateKey, "privileged_exec", args);
      const result = verifier(publicKey).verify("privileged_exec", args, capability);
      expect(result.approvalId).toBe("appr-drift-1");
      expect(result.scopes).toEqual(["process.privileged"]);
    });

    it("rejects a capability whose scopes claim authority the tool's policy doesn't grant, even though it verifies", () => {
      // The signature is over whatever was minted, so this is a signed-but-
      // over-scoped capability, not a forgery: the verifier must still bind
      // scopes to the tool's OWN policy, not merely check the signature.
      const { privateKey, publicKey } = keys();
      const capability = mint(privateKey, "jc_status", {}, { scopes: ["process.privileged"] });
      expect(() => verifier(publicKey).verify("jc_status", {}, capability)).toThrow(/JC_CAPABILITY_SCOPE_MISMATCH/);
    });

    it("rejects a capability minted for a different tool than the one actually called", () => {
      const { privateKey, publicKey } = keys();
      const capability = mint(privateKey, "jc_status", {});
      expect(() => verifier(publicKey).verify("acs_read", { view: "health" }, capability)).toThrow(
        /JC_CAPABILITY_TOOL_MISMATCH/
      );
    });

    it("rejects a replayed nonce on a second, otherwise-identical call", () => {
      const { privateKey, publicKey } = keys();
      const capability = mint(privateKey, "jc_status", {});
      const v = verifier(publicKey);
      v.verify("jc_status", {}, capability);
      expect(() => v.verify("jc_status", {}, capability)).toThrow(/JC_CAPABILITY_NONCE_REPLAY/);
    });
  });
});
