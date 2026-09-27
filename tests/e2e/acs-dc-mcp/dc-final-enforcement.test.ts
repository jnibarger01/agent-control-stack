/**
 * E2E 1b - Desktop Commander is the final enforcement boundary (ADR 0019
 * invariants 2, 3, 7).
 *
 * Capabilities here are minted by the REAL ACS gateway (runtime attested,
 * work item + lease + approval flow, durable issuance) and then delivered to a
 * REAL Desktop Commander child with no gateway in between, the way a buggy or
 * compromised transport would deliver them. Desktop Commander must reject every
 * tampered delivery on its own, and the executor must not run.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DC_CAPABILITY_OPTIONAL_DISCOVERY_TOOLS, dcToolContracts } from "@agent-control-stack/dc-tool-manifest";
import {
  DesktopCommanderStdio,
  E2E_ENABLED,
  attestDirect,
  dcRejection,
  desktopCommanderRuntimeId,
  requireDesktopCommanderBuild,
  sandbox,
  sleep,
  startAcs,
  type AcsHandle,
  type Sandbox
} from "../support/chain-harness.js";

// Short capability TTL so expiry is testable; DC allows 5s clock skew.
const TTL_MS = 2_000;

describe.skipIf(!E2E_ENABLED)("E2E 1b: DC rejects tampered ACS capabilities without a trusted gateway", () => {
  let box: Sandbox;
  let acs: AcsHandle;
  let dc: DesktopCommanderStdio;

  const issueApproved = async (tool: string, args: Record<string, unknown>) => {
    const held = await acs.issue(tool, args);
    if (held.status === 409) {
      expect(await acs.approve(held.body.workItemId, held.body.actionHash)).toBe(200);
      const issued = await acs.issue(tool, args);
      expect(issued.status, JSON.stringify(issued.body)).toBe(200);
      return issued.body.capability;
    }
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    return held.body.capability;
  };

  beforeAll(async () => {
    requireDesktopCommanderBuild();
    box = sandbox("acs-dc-final-e2e-");
    acs = await startAcs(box, await desktopCommanderRuntimeId(box), { ttlMs: TTL_MS });
    dc = new DesktopCommanderStdio(box, acs.keys.publicKey);
    await attestDirect(acs, dc);
  }, 60_000);

  afterAll(async () => {
    await dc?.close();
    await acs?.close();
    box?.cleanup();
  });

  it("rejects EVERY tool name without a capability except capability-optional discovery (executor untouched)", async () => {
    const probe = join(box.workspace, "sweep-probe.txt");
    const names = [...dcToolContracts().map((entry) => entry.name), "definitely_not_a_tool"];
    for (const name of names) {
      if ((DC_CAPABILITY_OPTIONAL_DISCOVERY_TOOLS as readonly string[]).includes(name)) continue;
      const response = await dc.call(name, { path: probe, content: "x", command: "touch " + probe });
      expect(dcRejection(response), name).toBe("ACS_CAPABILITY_MISSING");
    }
    expect(existsSync(probe)).toBe(false);
    const discovery = await dc.call(DC_CAPABILITY_OPTIONAL_DISCOVERY_TOOLS[0], {});
    expect(discovery.result.isError).toBeUndefined();
  });

  it("rejects a privileged call with no capability (ACS_CAPABILITY_MISSING)", async () => {
    const target = join(box.workspace, "no-capability.txt");
    const response = await dc.call("write_file", { path: target, content: "x" });
    expect(dcRejection(response)).toBe("ACS_CAPABILITY_MISSING");
    expect(existsSync(target)).toBe(false);
  });

  it("rejects a capability delivered for a different tool (ACS_CAPABILITY_TOOL_MISMATCH)", async () => {
    const file = join(box.workspace, "tool-binding.txt");
    writeFileSync(file, "x");
    const capability = await issueApproved("read_file", { path: file });
    const response = await dc.call("get_file_info", { path: file }, { acsCapability: capability });
    expect(dcRejection(response)).toBe("ACS_CAPABILITY_TOOL_MISMATCH");
  });

  it("rejects tampered arguments, does not burn the capability, executes the bound call once, then refuses replay", async () => {
    const target = join(box.workspace, "bound.txt");
    const bound = { path: target, content: "bound by ACS" };
    const capability = await issueApproved("write_file", bound);
    expect(capability.payload.approvalId).toEqual(expect.any(String));

    const tampered = await dc.call("write_file", { ...bound, content: "tampered" }, { acsCapability: capability });
    expect(dcRejection(tampered)).toBe("ACS_CAPABILITY_ARGUMENTS_MISMATCH");
    expect(existsSync(target)).toBe(false);

    // The rejection happened before the nonce is reserved, so the capability
    // is still usable for exactly the request ACS bound.
    const executed = await dc.call("write_file", bound, { acsCapability: capability });
    expect(executed.result.isError, JSON.stringify(executed)).toBeUndefined();
    expect(executed.result._meta.acsAuthorization.decision).toBe("granted");
    expect(readFileSync(target, "utf8")).toBe("bound by ACS");

    writeFileSync(target, "sentinel");
    const replayed = await dc.call("write_file", bound, { acsCapability: capability });
    expect(dcRejection(replayed)).toBe("ACS_CAPABILITY_NONCE_REPLAY");
    expect(readFileSync(target, "utf8")).toBe("sentinel");
  });

  it("rejects a payload altered after ACS signed it (ACS_CAPABILITY_SIGNATURE_INVALID)", async () => {
    const target = join(box.workspace, "widened.txt");
    const file = join(box.workspace, "readable.txt");
    writeFileSync(file, "x");
    const capability = await issueApproved("read_file", { path: file });
    const widened = {
      ...capability,
      payload: { ...capability.payload, toolName: "write_file", normalizedArguments: { path: target, content: "x" } }
    };
    const response = await dc.call("write_file", { path: target, content: "x" }, { acsCapability: widened });
    expect(dcRejection(response)).toBe("ACS_CAPABILITY_SIGNATURE_INVALID");
    expect(existsSync(target)).toBe(false);
  });

  it("rejects an expired capability (ACS_CAPABILITY_TIME_INVALID)", async () => {
    const target = join(box.workspace, "expired.txt");
    const capability = await issueApproved("write_file", { path: target, content: "late" });
    // expiresAt + DC's 5s clock-skew allowance.
    await sleep(Date.parse(capability.payload.expiresAt) - Date.now() + 5_500);
    const response = await dc.call("write_file", { path: target, content: "late" }, { acsCapability: capability });
    expect(dcRejection(response)).toBe("ACS_CAPABILITY_TIME_INVALID");
    expect(existsSync(target)).toBe(false);
  }, 30_000);

  it("rejects a capability presented under the wrong _meta key (the guard reads only acsCapability)", async () => {
    const target = join(box.workspace, "wrong-key.txt");
    const capability = await issueApproved("write_file", { path: target, content: "x" });
    const response = await dc.call("write_file", { path: target, content: "x" }, { capability });
    expect(dcRejection(response)).toBe("ACS_CAPABILITY_MISSING");
    expect(existsSync(target)).toBe(false);
  });
});

describe.skipIf(!E2E_ENABLED)("E2E 1c: DC rejects capabilities for a runtime that ACS did not attest", () => {
  let acsBox: Sandbox;
  let otherBox: Sandbox;
  let acs: AcsHandle;
  let attested: DesktopCommanderStdio;
  let other: DesktopCommanderStdio;

  beforeAll(async () => {
    requireDesktopCommanderBuild();
    acsBox = sandbox("acs-dc-runtime-a-");
    otherBox = sandbox("acs-dc-runtime-b-");
    acs = await startAcs(acsBox, await desktopCommanderRuntimeId(acsBox));
    attested = new DesktopCommanderStdio(acsBox, acs.keys.publicKey);
    await attestDirect(acs, attested);
    // A second, never-attested Desktop Commander runtime that trusts the same ACS key.
    other = new DesktopCommanderStdio(otherBox, acs.keys.publicKey);
  }, 60_000);

  afterAll(async () => {
    await other?.close();
    await attested?.close();
    await acs?.close();
    acsBox?.cleanup();
    otherBox?.cleanup();
  });

  it("refuses a managed initialize without an ACS bootstrap, and any call after it (ACS_RUNTIME_IDENTITY_MISSING)", async () => {
    // Current implementation fails closed at initialize already.
    const init = await other.initialize();
    expect(init.error?.message).toContain("ACS_RUNTIME_IDENTITY_MISSING");
    const file = join(otherBox.workspace, "pre-bootstrap.txt");
    writeFileSync(file, "x");
    const response = await other.call(
      "read_file",
      { path: file },
      { acsCapability: { payload: {}, keyId: "k", signature: "s" } }
    );
    expect(dcRejection(response)).toBe("ACS_RUNTIME_IDENTITY_MISSING");
  });

  it("refuses a valid ACS capability minted for another runtime (ACS_CAPABILITY_RUNTIME_MISMATCH)", async () => {
    const otherRuntimeId = await desktopCommanderRuntimeId(otherBox);
    expect(otherRuntimeId).not.toBe(acs.runtimeId);
    // Bootstrap `other` structurally with its own identity; ACS never attested it.
    const init = await other.initialize({
      acsRuntimeBootstrap: {
        schemaVersion: 1,
        runtimeId: otherRuntimeId,
        challenge: Buffer.alloc(32, 9).toString("base64url"),
        scopes: ["fs.read", "fs.write", "process.exec", "process.spawn"]
      }
    });
    expect(init.error).toBeUndefined();
    const file = join(acsBox.workspace, "runtime-bound.txt");
    writeFileSync(file, "x");
    const issued = await acs.issue("read_file", { path: file });
    expect(issued.status).toBe(200);
    const response = await other.call("read_file", { path: file }, { acsCapability: issued.body.capability });
    expect(dcRejection(response)).toBe("ACS_CAPABILITY_RUNTIME_MISMATCH");
  });
});
