/**
 * Cross-layer Desktop Commander tool-contract drift gate (ADR 0019).
 *
 * The bug class this exists for: one layer accepts a tool that another layer
 * does not recognize (or maps to a different scope / approval rule). Every
 * layer is compared against @agent-control-stack/dc-tool-manifest:
 *
 *   ACS      packages/desktop-commander-adapter  (issuer: policy, scopes, schemas)
 *   gateway  apps/dc-mcp-gateway/managed.js      (transport: _meta keys, anti-spoof)
 *   DC       vendor/desktop-commander/src/managed-acs.ts (enforcer: guard tables)
 *
 * and then exercised end to end in-process: ACS's real signer mints a
 * capability for every capability tool with ACS's own scope/approval rules and
 * Desktop Commander's real ManagedAcsGuard must accept it.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ACS_DC_CAPABILITY_VERSION,
  ACS_DC_SCOPES,
  DC_CAPABILITY_META_KEYS,
  DC_TRANSPORT_METADATA_ARGUMENT_KEYS,
  DC_TRANSPORT_METADATA_VALUES,
  dcCapabilityToolContracts,
  dcToolContracts,
  isAcsAuthorityMetaKey
} from "@agent-control-stack/dc-tool-manifest";
import {
  DC_TRANSPORT_METADATA_ARGUMENT_KEYS as ACS_TRANSPORT_KEYS,
  DESKTOP_COMMANDER_CAPABILITY_VERSION,
  allowlistedDesktopCommanderToolNames,
  desktopCommanderInvocationFingerprint,
  desktopCommanderManagedToolDispositions,
  desktopCommanderRequiredScopes,
  desktopCommanderToolPolicy,
  normalizeInvocation,
  signPreparedDesktopCommanderCapability,
  type DesktopCommanderCapabilityPayload
} from "@agent-control-stack/desktop-commander-adapter";
import * as dc from "../../vendor/desktop-commander/src/managed-acs.ts";
import * as gateway from "../../apps/dc-mcp-gateway/managed.js";

const REPO = new URL("../../", import.meta.url);
const RUNTIME_ID = "runtime_drift";
const KEY_ID = "drift-key-1";

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64url")
  };
}

function managedGuard(publicKey: string) {
  const guard = new dc.ManagedAcsGuard({
    mode: "managed",
    runtimeId: RUNTIME_ID,
    publicKey,
    keyId: KEY_ID,
    allowedScopes: dc.FIXED_ACS_SCOPES
  });
  guard.initialize({
    acsRuntimeBootstrap: {
      schemaVersion: 1,
      runtimeId: RUNTIME_ID,
      challenge: Buffer.alloc(32, 7).toString("base64url"),
      scopes: dc.FIXED_ACS_SCOPES
    }
  });
  return guard;
}

/** A payload built with ACS's own scope and approval rules for `toolName`. */
function acsPayload(toolName: string, normalizedArguments: Record<string, unknown>): DesktopCommanderCapabilityPayload {
  const policy = desktopCommanderToolPolicy(toolName);
  if (!policy) throw new Error(`ACS does not allowlist ${toolName}`);
  const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  return {
    version: DESKTOP_COMMANDER_CAPABILITY_VERSION,
    issuer: "acs",
    audience: "desktop-commander",
    runtimeId: RUNTIME_ID,
    workItemId: "work_drift",
    attemptId: "attempt_drift",
    leaseId: "lease_drift",
    leaseEpoch: 1,
    toolName,
    normalizedArguments,
    invocationHash: desktopCommanderInvocationFingerprint({ toolName, validatedArguments: normalizedArguments }),
    actionHash: "a".repeat(64),
    requestHash: "b".repeat(64),
    planHash: "c".repeat(64),
    scopes: desktopCommanderRequiredScopes(toolName),
    ...(policy.requiresApproval ? { approvalId: "approval_drift" } : {}),
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 29_000).toISOString(),
    nonce: randomBytes(32).toString("base64url")
  } as DesktopCommanderCapabilityPayload;
}

const rejectionCode = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
};

describe("DC tool contract: every layer agrees with the canonical manifest", () => {
  const manifestNames = dcToolContracts().map((entry) => entry.name);
  const capabilityNames = dcCapabilityToolContracts().map((entry) => entry.name);

  it("ACS issuer: allowlist, dispositions, scopes, approval, schemas, transport keys", () => {
    expect(allowlistedDesktopCommanderToolNames()).toEqual([...capabilityNames].sort());
    expect(
      desktopCommanderManagedToolDispositions().map(({ name, toolClass, managed }) => ({ name, toolClass, managed }))
    ).toEqual(dcToolContracts().map(({ name, toolClass, managed }) => ({ name, toolClass, managed })));
    for (const contract of dcCapabilityToolContracts()) {
      const policy = desktopCommanderToolPolicy(contract.name);
      expect(policy?.argsSchema, contract.name).toBe(contract.argsSchema);
      expect(policy?.requiresApproval, contract.name).toBe(contract.requiresApproval);
      expect(policy?.riskClass, contract.name).toBe(contract.riskClass);
      expect(desktopCommanderRequiredScopes(contract.name), contract.name).toEqual([contract.scope]);
    }
    expect([...ACS_TRANSPORT_KEYS]).toEqual([...DC_TRANSPORT_METADATA_ARGUMENT_KEYS]);
    expect(DESKTOP_COMMANDER_CAPABILITY_VERSION).toBe(ACS_DC_CAPABILITY_VERSION);
  });

  it("Desktop Commander enforcer: dispositions, guard scopes/approval, scope vocabulary, transport keys", () => {
    const dispositions = dc.listManagedToolDispositions();
    expect(Object.keys(dispositions).sort()).toEqual([...manifestNames].sort());
    for (const contract of dcToolContracts()) {
      expect({ ...dispositions[contract.name] }, contract.name).toEqual({
        toolClass: contract.toolClass,
        managed: contract.managed
      });
    }
    const policies = dc.listManagedAcsToolPolicies();
    expect(Object.keys(policies).sort()).toEqual([...capabilityNames].sort());
    for (const contract of dcCapabilityToolContracts()) {
      expect([...policies[contract.name].scopes], contract.name).toEqual([contract.scope]);
      expect(policies[contract.name].requiresApproval, contract.name).toBe(contract.requiresApproval);
    }
    expect([...dc.FIXED_ACS_SCOPES]).toEqual([...ACS_DC_SCOPES]);
    expect(dc.ACS_CAPABILITY_VERSION).toBe(ACS_DC_CAPABILITY_VERSION);
    expect([...dc.DC_TRANSPORT_METADATA_ARGUMENT_KEYS]).toEqual([...DC_TRANSPORT_METADATA_ARGUMENT_KEYS]);
    for (const [key, values] of Object.entries(DC_TRANSPORT_METADATA_VALUES)) {
      for (const value of values) expect(dc.authorizationArguments({ [key]: value, x: 1 })).toEqual({ x: 1 });
      expect(() => dc.authorizationArguments({ [key]: "not-an-allowed-value" })).toThrow();
    }
  });

  it("Desktop Commander's pinned fixtures are the generated contract bytes", () => {
    for (const [generated, pinned] of [
      ["contracts/desktop-commander/managed-tool-coverage.v1.json", "acs-managed-tool-coverage.v1.json"],
      ["contracts/desktop-commander/authorization-arguments.v1.json", "acs-authorization-arguments.v1.json"]
    ]) {
      const expected = readFileSync(new URL(generated, REPO));
      const actual = readFileSync(new URL(`vendor/desktop-commander/test/fixtures/${pinned}`, REPO));
      expect(actual.equals(expected), pinned).toBe(true);
    }
  });

  it("MCP gateway transport: envelope _meta keys and runtime scopes match the manifest", () => {
    expect(gateway.ACS_CAPABILITY_META_KEY).toBe(DC_CAPABILITY_META_KEYS.gateway);
    expect(gateway.ACS_GUARD_META_KEY).toBe(DC_CAPABILITY_META_KEYS.guard);
    for (const scope of gateway.sortedScopes(undefined)) expect(ACS_DC_SCOPES).toContain(scope);
  });

  it("MCP gateway holds no independent copy of the tool list", () => {
    // The gateway is transport: it must not decide per tool. A tool-name
    // literal in its runtime sources would be a second, unchecked contract.
    const sources = ["managed.js", "bridge.js", "server.js", "recycle-policy.js"].map((file) =>
      readFileSync(new URL(`apps/dc-mcp-gateway/${file}`, REPO), "utf8")
    );
    for (const name of manifestNames) {
      for (const source of sources) {
        expect(source.includes(`'${name}'`) || source.includes(`"${name}"`), `gateway hard-codes ${name}`).toBe(false);
      }
    }
  });
});

describe("DC tool contract: ACS-issued capabilities verify in Desktop Commander for every tool", () => {
  const signing = keys();

  it("accepts an ACS-signed capability for every capability tool (scope/approval agreement)", () => {
    const guard = managedGuard(signing.publicKey);
    for (const contract of dcCapabilityToolContracts()) {
      const envelope = signPreparedDesktopCommanderCapability(acsPayload(contract.name, {}), {
        keyId: KEY_ID,
        privateKey: signing.privateKey
      });
      const code = rejectionCode(() =>
        guard.authorize(contract.name, {}, { [DC_CAPABILITY_META_KEYS.guard]: envelope })
      );
      expect(code, `${contract.name}: DC rejected an ACS-issued capability`).toBeUndefined();
    }
  });

  it("rejects every unsupported tool even with a validly signed envelope", () => {
    const guard = managedGuard(signing.publicKey);
    for (const contract of dcToolContracts().filter((entry) => entry.managed === "unsupported")) {
      // ACS will not issue these; sign by hand with an arbitrary scope to prove DC refuses anyway.
      const payload = { ...acsPayload("get_config", {}), toolName: contract.name };
      payload.invocationHash = desktopCommanderInvocationFingerprint({
        toolName: contract.name,
        validatedArguments: {}
      });
      const envelope = signPreparedDesktopCommanderCapability(payload, {
        keyId: KEY_ID,
        privateKey: signing.privateKey
      });
      expect(
        rejectionCode(() => guard.authorize(contract.name, {}, { [DC_CAPABILITY_META_KEYS.guard]: envelope })),
        contract.name
      ).toBe("ACS_CAPABILITY_SCOPE_MISMATCH");
    }
  });

  it("only reads the capability from the guard _meta key", () => {
    const guard = managedGuard(signing.publicKey);
    const envelope = signPreparedDesktopCommanderCapability(acsPayload("get_config", {}), {
      keyId: KEY_ID,
      privateKey: signing.privateKey
    });
    expect(
      rejectionCode(() => guard.authorize("get_config", {}, { [DC_CAPABILITY_META_KEYS.gateway]: envelope }))
    ).toBe("ACS_CAPABILITY_MISSING");
  });

  it("replays every authorization-arguments conformance case: ACS normalize + sign -> DC guard", () => {
    const contract = JSON.parse(
      readFileSync(new URL("contracts/desktop-commander/authorization-arguments.v1.json", REPO), "utf8")
    ) as {
      fixtureFilesystem: { directories: string[]; symlinks: Record<string, string> };
      cases: Array<{ name: string; tool: string; raw: Record<string, unknown> }>;
    };
    const root = realpathSync(mkdtempSync(join(tmpdir(), "dc-drift-")));
    try {
      for (const dir of contract.fixtureFilesystem.directories) mkdirSync(join(root, dir), { recursive: true });
      for (const [link, target] of Object.entries(contract.fixtureFilesystem.symlinks)) {
        symlinkSync(join(root, target), join(root, link));
      }
      const substitute = (value: unknown): unknown => {
        if (typeof value === "string") return value.replaceAll("${ROOT}", root);
        if (Array.isArray(value)) return value.map(substitute);
        if (value && typeof value === "object") {
          return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substitute(entry)]));
        }
        return value;
      };
      const guard = managedGuard(signing.publicKey);
      const containment = { allowedRoots: [root], deniedRoots: [] };
      for (const testCase of contract.cases) {
        const raw = substitute(testCase.raw) as Record<string, unknown>;
        const invocation = normalizeInvocation(testCase.tool, raw, containment);
        const bound = invocation.validatedArguments as Record<string, unknown>;
        expect(dc.computeDesktopCommanderInvocationHash(testCase.tool, bound), testCase.name).toBe(
          desktopCommanderInvocationFingerprint(invocation)
        );
        expect(dc.strictCanonicalJsonV1(bound)).toBe(dc.strictCanonicalJsonV1(JSON.parse(JSON.stringify(bound))));
        const envelope = signPreparedDesktopCommanderCapability(acsPayload(testCase.tool, bound), {
          keyId: KEY_ID,
          privateKey: signing.privateKey
        });
        // The gateway forwards exactly envelope.payload.normalizedArguments.
        const auth = guard.authorize(
          testCase.tool,
          { ...envelope.payload.normalizedArguments },
          {
            [DC_CAPABILITY_META_KEYS.guard]: envelope
          }
        );
        expect(auth?.toolName, testCase.name).toBe(testCase.tool);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("DC tool contract: the gateway strips client authority metadata and forwards only ACS-bound arguments", () => {
  let acs: Server;
  let acsUrl = "";
  const received: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    acs = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        received.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            decision: "allow",
            capability: {
              keyId: KEY_ID,
              signature: "sig",
              payload: { normalizedArguments: { path: "/bound/by/acs" } }
            },
            claimActionHash: "a".repeat(64),
            inputHash: "b".repeat(64),
            workerId: "worker"
          })
        );
      });
    });
    await new Promise<void>((resolve) => acs.listen(0, "127.0.0.1", resolve));
    acsUrl = `http://127.0.0.1:${(acs.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => acs.close(() => resolve())));

  it("drops every client _meta key the manifest classifies as ACS authority", async () => {
    const rewrite = gateway.capabilityTransport(
      { enabled: true, acsGatewayUrl: acsUrl, acsGatewayToken: "t", timeoutMs: 5000 },
      { identity: { subject: "user", clientId: "client" }, requestId: "req-1" }
    );
    const spoofMeta = {
      capability: { forged: true },
      acsCapability: { forged: true },
      acsLeaseBinding: { forged: true },
      acsRuntimeBootstrap: { forged: true },
      progressToken: "keep-me"
    };
    const out = (await rewrite({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "read_file", arguments: { path: "raw", origin: "llm" }, _meta: spoofMeta }
    })) as { params: { arguments: unknown; _meta: Record<string, unknown> } };

    // ACS saw the tool name verbatim and the client's arguments as a summary only.
    expect(received.at(-1)?.tool).toBe("read_file");
    // Forwarded arguments are exactly what ACS normalized and signed.
    expect(out.params.arguments).toEqual({ path: "/bound/by/acs" });
    // Every client-supplied authority key is gone; the injected envelope replaced it.
    for (const key of Object.keys(spoofMeta).filter(isAcsAuthorityMetaKey)) {
      expect(JSON.stringify(out.params._meta[key] ?? null)).not.toContain("forged");
    }
    expect(out.params._meta.progressToken).toBe("keep-me");
    expect(out.params._meta[DC_CAPABILITY_META_KEYS.guard]).toEqual(out.params._meta[DC_CAPABILITY_META_KEYS.gateway]);
  });
});
