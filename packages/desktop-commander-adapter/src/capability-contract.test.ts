import { generateKeyPairSync, verify } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import { prepareDesktopCommanderCapability, signPreparedDesktopCommanderCapability, type DesktopCommanderCapabilityPayload } from "./capability.js";
import { authorizeDesktopCommanderExecution } from "./execution-authorization.js";
import { makeClaimed, makeLease, makeRoot, makeWorkItem } from "./test-fixtures.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function authorizationFor(toolName: "read_file" | "write_file") {
  const { root, config } = makeRoot("dc-capability-contract-");
  roots.push(root);
  const requestedActions = toolName === "read_file"
    ? [{ kind: "read_file", description: "read", params: { tool: "read_file", arguments: { path: `${root}/a.txt` } } }]
    : [{ kind: "write_file", description: "write", params: { tool: "write_file", arguments: { path: `${root}/a.txt`, content: "x" } } }];
  const workItem = makeWorkItem(root, { requestedActions });
  const claimed = makeClaimed(workItem);
  return authorizeDesktopCommanderExecution({
    claimed,
    trustedWorkItem: workItem,
    lease: makeLease(claimed, toolName === "write_file" ? { approvalId: "appr_1" } : {}),
    workerId: "worker_1",
    containment: config,
    requestId: "request_1",
    now: new Date("2026-01-01T00:00:00.000Z")
  });
}

function signedCapability(toolName: "read_file" | "write_file" = "read_file") {
  const pair = generateKeyPairSync("ed25519");
  const authorization = authorizationFor(toolName);
  const signingConfig = {
    runtimeId: "runtime_1",
    keyId: "test-key-1",
    privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")
  };
  const capability = signPreparedDesktopCommanderCapability(
    prepareDesktopCommanderCapability(authorization, authorization.requestHash, signingConfig, new Date("2026-01-01T00:00:00.000Z")),
    signingConfig
  );
  return { capability, publicKey: pair.publicKey };
}

function signatureVerifies(payload: DesktopCommanderCapabilityPayload, signature: string, publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"]): boolean {
  return verify(null, Buffer.from(strictCanonicalJsonV1(payload), "utf8"), publicKey, Buffer.from(signature, "base64url"));
}

describe("acs.dc.v1 capability signed-claim binding", () => {
  it("rejects a forged signature and every security-sensitive single-claim mutation", () => {
    const { capability, publicKey } = signedCapability();
    expect(signatureVerifies(capability.payload, capability.signature, publicKey)).toBe(true);

    const changedHex = "f".repeat(64);
    const mutations: readonly [string, DesktopCommanderCapabilityPayload][] = [
      ["forged signature", capability.payload],
      ["runtime identity", { ...capability.payload, runtimeId: "runtime_other" }],
      ["tool name", { ...capability.payload, toolName: "write_file", scopes: ["fs.write"] }],
      ["normalized arguments", { ...capability.payload, normalizedArguments: { path: "/tmp/other" } }],
      ["invocation hash", { ...capability.payload, invocationHash: changedHex }],
      ["scope", { ...capability.payload, scopes: ["fs.write"] }],
      ["lease id", { ...capability.payload, leaseId: "lease_other" }],
      ["lease epoch", { ...capability.payload, leaseEpoch: capability.payload.leaseEpoch + 1 }],
      ["action hash", { ...capability.payload, actionHash: changedHex }],
      ["request hash", { ...capability.payload, requestHash: changedHex }],
      ["plan hash", { ...capability.payload, planHash: changedHex }],
      ["expiry", { ...capability.payload, expiresAt: "2000-01-01T00:00:00.000Z" }],
      ["nonce", { ...capability.payload, nonce: "A".repeat(43) }]
    ];

    for (const [name, payload] of mutations) {
      const signature = name === "forged signature"
        ? `${capability.signature.startsWith("A") ? "B" : "A"}${capability.signature.slice(1)}`
        : capability.signature;
      expect(signatureVerifies(payload, signature, publicKey), name).toBe(false);
    }
  });

  it("binds required approval IDs to signed write capabilities and rejects altered or omitted approval claims", () => {
    const { capability, publicKey } = signedCapability("write_file");
    expect(capability.payload.approvalId).toBe("appr_1");
    expect(signatureVerifies({ ...capability.payload, approvalId: "appr_other" }, capability.signature, publicKey)).toBe(false);
    const { approvalId: _approvalId, ...withoutApproval } = capability.payload;
    expect(signatureVerifies(withoutApproval as DesktopCommanderCapabilityPayload, capability.signature, publicKey)).toBe(false);
  });
});
