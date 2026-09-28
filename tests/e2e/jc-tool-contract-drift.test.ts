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
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  JC_ACTION_KINDS,
  JC_AUDIENCE,
  JC_CAPABILITY_VERSION,
  JC_SCOPES,
  jcMcpToolDescriptors,
  jcPortableManifest,
  jcToolContracts
} from "@agent-control-stack/jc-tool-manifest";
import { applyControlPlaneMigrations } from "@agent-control-stack/shared";
import { JC_GENERATED_MANIFEST_PATH, renderJcGeneratedManifest } from "../../scripts/jc-tool-manifest.ts";
import { JC_MANIFEST } from "../../vendor/desktop-commander/src/jace-commander/manifest.generated.ts";
import { CLI_COMMANDS } from "../../vendor/desktop-commander/src/jace-commander/cli-commands.ts";
import {
  JACE_COMMANDER_AUDIENCE,
  JACE_COMMANDER_CAPABILITY_VERSION,
  JACE_COMMANDER_INVOCATION_DOMAIN,
  jaceCommanderToolNames,
  jaceCommanderToolPolicy,
  prepareJaceCommanderCapability,
  signPreparedJaceCommanderCapability,
  validateJaceCommanderInvocation
} from "@agent-control-stack/desktop-commander-adapter";
import * as jcContract from "../../vendor/desktop-commander/src/jace-commander/contract.ts";
import { JC_TOOLS } from "../../vendor/desktop-commander/src/jace-commander/tool-descriptors.ts";

const KEY_ID = "drift-jc-key-1";
const RUNTIME_ID = "runtime_jc_drift";

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64url")
  };
}

function mint(
  privateKey: string,
  toolName: string,
  normalizedArguments: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
) {
  const invocation = validateJaceCommanderInvocation(toolName, normalizedArguments);
  const actionHash = randomBytes(32).toString("hex");
  const authorization = {
    workItemId: "wi-drift-1",
    attemptId: "att-drift-1",
    leaseId: "lease-drift-1",
    workerId: "worker-drift-1",
    planHash: randomBytes(32).toString("hex"),
    inputHash: randomBytes(32).toString("hex"),
    fencingEpoch: 1,
    actionHash,
    invocation,
    ...(invocation.policy.requiresApproval
      ? { approvalId: "appr-drift-1", approvalActionHash: actionHash }
      : {})
  } as Parameters<typeof prepareJaceCommanderCapability>[0];
  const config = { runtimeId: RUNTIME_ID, keyId: KEY_ID, privateKey, ttlMs: 20_000 };
  const prepared = prepareJaceCommanderCapability(authorization, config, new Date());
  const payload = { ...prepared, ...overrides } as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete payload[key];
  }
  return signPreparedJaceCommanderCapability(
    payload as Parameters<typeof signPreparedJaceCommanderCapability>[0],
    config
  );
}

describe("jc-tool-manifest drift gate", () => {
  it("keeps capability constants aligned across manifest, ACS issuer, and JC verifier", () => {
    expect(JACE_COMMANDER_CAPABILITY_VERSION).toBe(JC_CAPABILITY_VERSION);
    expect(JACE_COMMANDER_CAPABILITY_VERSION).toBe(jcContract.JC_CAPABILITY_VERSION);
    expect(JACE_COMMANDER_AUDIENCE).toBe(JC_AUDIENCE);
    expect(JACE_COMMANDER_AUDIENCE).toBe(jcContract.JC_AUDIENCE);
    expect(JACE_COMMANDER_INVOCATION_DOMAIN).toBe(jcContract.JC_INVOCATION_DOMAIN);
  });

  it("lists the same tool set in the manifest, ACS's adapter, DC's policy table, and MCP surface", () => {
    const manifestNames = jcToolContracts()
      .map((entry) => entry.name)
      .sort();
    expect(jaceCommanderToolNames().sort()).toEqual(manifestNames);
    expect(Object.keys(jcContract.JC_TOOL_POLICIES).sort()).toEqual(manifestNames);
    expect(JC_TOOLS.map((tool) => tool.name).sort()).toEqual(manifestNames);
  });

  it("matches the exact MCP descriptors Jace Commander advertises", () => {
    const byName = <T extends { name: string }>(left: T, right: T) => left.name.localeCompare(right.name);
    expect([...JC_TOOLS].sort(byName)).toEqual(jcMcpToolDescriptors().sort(byName));
  });

  it("agrees on scopes and approval requirement for every tool, across the manifest, ACS and DC", () => {
    for (const entry of jcToolContracts()) {
      const acsPolicy = jaceCommanderToolPolicy(entry.name);
      expect(acsPolicy, `ACS is missing a policy for ${entry.name}`).toBeDefined();
      expect(acsPolicy!.scopes).toEqual(entry.scopes);
      expect(Object.isFrozen(acsPolicy!.scopes), `${entry.name} ACS scopes must be immutable`).toBe(true);
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

  it("Jace Commander's generated manifest is byte-identical to the generator output (npm run jc-contracts:generate)", () => {
    const onDisk = readFileSync(new URL(`../../${JC_GENERATED_MANIFEST_PATH}`, import.meta.url), "utf8");
    expect(onDisk).toBe(renderJcGeneratedManifest());
    expect(JC_MANIFEST).toEqual(jcPortableManifest());
  });

  it("the CLI command table implements exactly the manifest's CLI verbs, each bound to its tool", () => {
    const fromManifest = jcToolContracts().flatMap((entry) => entry.cliCommands.map((verb) => `${verb} -> ${entry.name}`));
    const fromCli = CLI_COMMANDS.map((command) => `${command.verb} -> ${command.tool}`);
    expect([...fromCli].sort()).toEqual([...fromManifest].sort());
  });

  it("ACS's database tool allowlist (migration 029+) is exactly the manifest's tool set", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyControlPlaneMigrations(db);
      const known = (db.prepare("SELECT tool_name FROM jace_commander_tools ORDER BY tool_name").all() as Array<{
        tool_name: string;
      }>).map((entry) => entry.tool_name);
      expect(known).toEqual(jcToolContracts().map((entry) => entry.name).sort());
    } finally {
      db.close();
    }
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
