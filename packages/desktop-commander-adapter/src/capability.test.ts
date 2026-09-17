import { generateKeyPairSync, verify } from "node:crypto";
import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import { desktopCommanderCapabilityNonceHash, prepareDesktopCommanderCapability, signPreparedDesktopCommanderCapability } from "./capability.js";
import { authorizeDesktopCommanderExecution } from "./execution-authorization.js";
import { makeClaimed, makeLease, makeRoot, makeWorkItem } from "./test-fixtures.js";

describe("internal Desktop Commander capability signing helpers", () => {
  it("signs strict canonical payloads with the exact v1 claims and a 32-byte nonce", () => {
    const { root, config } = makeRoot("dc-capability-");
    try {
      const workItem = makeWorkItem(root, {
        requestedActions: [{ kind: "read_file", description: "read", params: { tool: "read_file", arguments: { path: `${root}/a.txt` } } }]
      });
      const claimed = makeClaimed(workItem);
      const authorization = authorizeDesktopCommanderExecution({
        claimed,
        trustedWorkItem: workItem,
        lease: makeLease(claimed),
        workerId: "worker_1",
        containment: config,
        requestId: "request_1",
        now: new Date("2026-01-01T00:00:00.123Z")
      });
      const pair = generateKeyPairSync("ed25519");
      const signingConfig = { runtimeId: "runtime_1", keyId: "test-key-1", privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url") };
      const capability = signPreparedDesktopCommanderCapability(
        prepareDesktopCommanderCapability(authorization, authorization.requestHash, signingConfig, new Date("2026-01-01T00:00:00.123Z")),
        signingConfig
      );
      expect(capability.payload).toMatchObject({
        version: "acs.dc.v1",
        issuer: "acs",
        audience: "desktop-commander",
        runtimeId: "runtime_1",
        scopes: ["fs.read"],
        requestHash: authorization.requestHash,
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T00:00:29.000Z"
      });
      expect(capability.payload.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(verify(null, Buffer.from(strictCanonicalJsonV1(capability.payload), "utf8"), pair.publicKey, Buffer.from(capability.signature, "base64url"))).toBe(true);
      expect(desktopCommanderCapabilityNonceHash(capability.payload.nonce)).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid signing configuration and overlong capability lifetimes", () => {
    expect(() => desktopCommanderCapabilityNonceHash("not-a-nonce")).toThrow(/nonce is invalid/);
  });
});
