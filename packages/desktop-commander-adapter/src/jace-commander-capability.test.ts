import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import {
  JACE_COMMANDER_SCOPES,
  jaceCommanderInvocationHash,
  jaceCommanderToolNames,
  jaceCommanderToolPolicy,
  normalizeJaceCommanderInvocation,
  prepareJaceCommanderCapability,
  signJaceCommanderCapability,
  type JaceCommanderCapability
} from "./jace-commander-capability.js";

/**
 * Pinned byte-identically in desktop-commander test/fixtures/, where
 * test/test-jace-commander-acs-interop.js verifies it with JcCapabilityVerifier.
 */
const vector = JSON.parse(
  readFileSync(new URL("./fixtures/acs-jc-v1-interop-vector.json", import.meta.url), "utf8")
) as {
  publicKey: string;
  keyId: string;
  runtimeId: string;
  cases: Array<{
    toolName: string;
    arguments: Record<string, unknown>;
    invocationHash: string;
    canonicalPayloadSha256: string;
    capability: JaceCommanderCapability;
  }>;
  negatives: Array<{ capability: JaceCommanderCapability }>;
};

/** TEST-ONLY deterministic key: sha256(seed label) as the raw Ed25519 seed. */
function interopSigningConfig() {
  const seed = createHash("sha256").update("acs.jc.v1 interop vector seed v1").digest();
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  return { runtimeId: vector.runtimeId, keyId: vector.keyId, privateKey: pkcs8.toString("base64url") };
}

describe("acs.jc.v1 interop vector", () => {
  it("derives the pinned public key from the test seed", () => {
    const config = interopSigningConfig();
    const publicKey = createPublicKey(
      createPrivateKey({ key: Buffer.from(config.privateKey, "base64url"), format: "der", type: "pkcs8" })
    )
      .export({ format: "der", type: "spki" })
      .toString("base64url");
    expect(publicKey).toBe(vector.publicKey);
  });

  it.each(vector.cases.map((entry) => [entry.toolName, entry] as const))(
    "re-signs the %s case to the exact pinned signature",
    (_name, entry) => {
      const invocation = normalizeJaceCommanderInvocation(entry.toolName, entry.arguments);
      expect(invocation.invocationHash).toBe(entry.invocationHash);
      expect(jaceCommanderInvocationHash(entry.toolName, entry.arguments)).toBe(entry.invocationHash);
      const payload = entry.capability.payload;
      expect(payload.normalizedArguments).toEqual(invocation.normalizedArguments);
      expect(createHash("sha256").update(strictCanonicalJsonV1(payload), "utf8").digest("hex")).toBe(
        entry.canonicalPayloadSha256
      );
      const resigned = signJaceCommanderCapability(payload, interopSigningConfig());
      expect(resigned).toEqual(entry.capability);
    }
  );

  it("pins the approval rule: privileged_exec carries approvalId, reads never do", () => {
    for (const entry of vector.cases) {
      const policy = jaceCommanderToolPolicy(entry.toolName)!;
      expect(Object.hasOwn(entry.capability.payload, "approvalId")).toBe(policy.requiresApproval);
      expect(entry.capability.payload.scopes).toEqual(policy.scopes);
    }
  });
});

describe("acs.jc.v1 tool table", () => {
  it("matches desktop-commander JC_TOOL_POLICIES exactly", () => {
    const table = Object.fromEntries(
      jaceCommanderToolNames().map((name) => {
        const policy = jaceCommanderToolPolicy(name)!;
        return [name, { scopes: [...policy.scopes], requiresApproval: policy.requiresApproval }];
      })
    );
    expect(table).toEqual({
      jc_status: { scopes: ["integration.read"], requiresApproval: false },
      acs_read: { scopes: ["integration.read"], requiresApproval: false },
      acs_submit_mission: { scopes: ["integration.write"], requiresApproval: false },
      swarm_read: { scopes: ["integration.read"], requiresApproval: false },
      visualizer_read: { scopes: ["integration.read"], requiresApproval: false },
      mission_router_list: { scopes: ["fs.read"], requiresApproval: false },
      looptrace_verify: { scopes: ["fs.read"], requiresApproval: false },
      privileged_exec: { scopes: ["process.privileged"], requiresApproval: true }
    });
    expect([...JACE_COMMANDER_SCOPES]).toEqual([
      "fs.read",
      "integration.read",
      "integration.write",
      "process.privileged"
    ]);
    expect(jaceCommanderToolPolicy("__proto__")).toBeUndefined();
    expect(jaceCommanderToolPolicy("run_command")).toBeUndefined();
  });

  it("uses the strict canonical invocation domain, not the legacy acs.dc.v1 canonicalJson", () => {
    const args = { argv: ["/usr/bin/id"], timeoutMs: 5 };
    const expected = createHash("sha256")
      .update(
        `acs:jace-commander-invocation:v1\n{"arguments":{"argv":["/usr/bin/id"],"timeoutMs":5},"toolName":"privileged_exec"}`
      )
      .digest("hex");
    expect(jaceCommanderInvocationHash("privileged_exec", args)).toBe(expected);
  });
});

describe("normalizeJaceCommanderInvocation", () => {
  it("binds exact arguments without rewriting them", () => {
    const args = { stdin: "y\n", argv: ["/usr/bin/apt-get", "install", "-y", "jq"], cwd: "/srv/../srv" };
    const invocation = normalizeJaceCommanderInvocation("privileged_exec", args);
    expect(invocation.normalizedArguments).toEqual(args);
    expect(Object.isFrozen(invocation.normalizedArguments)).toBe(true);
  });

  it.each([
    [{ argv: ["sudo", "id"] }, /normalized absolute/u],
    [{ argv: ["/usr/bin/./id"] }, /normalized absolute/u],
    [{ argv: ["/usr/bin/id", "a\0b"] }, /NUL/u],
    [{ argv: [] }, /argv/u],
    [{ argv: ["/usr/bin/id"], env: {} }, /unknown argument: env/u],
    [{ argv: ["/usr/bin/id"], timeoutMs: 0 }, /timeoutMs/u],
    [{ argv: ["/usr/bin/id"], timeoutMs: 1.5 }, /timeoutMs/u],
    [{ argv: ["/usr/bin/id"], cwd: "tmp" }, /cwd/u],
    [{ cwd: "/" }, /missing argument: argv/u]
  ])("rejects privileged_exec arguments %j", (args, message) => {
    expect(() => normalizeJaceCommanderInvocation("privileged_exec", args)).toThrow(message);
  });

  it("rejects unknown tools, non-object arguments, and extra read arguments", () => {
    expect(() => normalizeJaceCommanderInvocation("read_file", {})).toThrow(/not an acs.jc.v1 tool/u);
    expect(() => normalizeJaceCommanderInvocation("jc_status", [])).toThrow(/object/u);
    expect(() => normalizeJaceCommanderInvocation("jc_status", { verbose: true })).toThrow(/unknown argument/u);
    expect(() => normalizeJaceCommanderInvocation("swarm_read", { view: "delete" })).toThrow(/view/u);
    expect(() => normalizeJaceCommanderInvocation("looptrace_verify", { path: "rel.jsonl" })).toThrow(/absolute/u);
  });
});

describe("prepareJaceCommanderCapability", () => {
  const authority = {
    workItemId: "wi_1",
    attemptId: "attempt_1",
    leaseId: "lease_1",
    leaseEpoch: 1,
    planHash: "a".repeat(64),
    actionHash: "b".repeat(64),
    requestHash: "c".repeat(64)
  };

  it("refuses to mint privileged_exec without an approval", () => {
    const invocation = normalizeJaceCommanderInvocation("privileged_exec", { argv: ["/usr/bin/id"] });
    expect(() => prepareJaceCommanderCapability(invocation, authority, interopSigningConfig())).toThrow(
      /required approval/u
    );
  });

  it("refuses an approval on a non-approval tool and TTLs above 30s", () => {
    const invocation = normalizeJaceCommanderInvocation("jc_status", {});
    expect(() =>
      prepareJaceCommanderCapability(invocation, { ...authority, approvalId: "appr_1" }, interopSigningConfig())
    ).toThrow(/unexpected approval/u);
    expect(() =>
      prepareJaceCommanderCapability(invocation, authority, { ...interopSigningConfig(), ttlMs: 30_001 })
    ).toThrow(/TTL/u);
  });

  it("emits the exact acs.jc.v1 field set with a 29s window and fresh nonce", () => {
    const invocation = normalizeJaceCommanderInvocation("privileged_exec", { argv: ["/usr/bin/id"] });
    const now = new Date("2026-09-26T12:00:00.750Z");
    const payload = prepareJaceCommanderCapability(
      invocation,
      { ...authority, approvalId: "plan_approval_1" },
      interopSigningConfig(),
      now
    );
    expect(Object.keys(payload).sort()).toEqual(
      [
        "actionHash",
        "approvalId",
        "attemptId",
        "audience",
        "expiresAt",
        "invocationHash",
        "issuedAt",
        "issuer",
        "leaseEpoch",
        "leaseId",
        "nonce",
        "normalizedArguments",
        "planHash",
        "requestHash",
        "runtimeId",
        "scopes",
        "toolName",
        "version",
        "workItemId"
      ].sort()
    );
    expect(payload).toMatchObject({
      version: "acs.jc.v1",
      audience: "jace-commander",
      issuedAt: "2026-09-26T12:00:00.000Z",
      expiresAt: "2026-09-26T12:00:29.000Z",
      scopes: ["process.privileged"]
    });
    expect(payload.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });
});
