import { generateKeyPairSync } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { prepareDesktopCommanderCapability } from "./capability.js";
import { authorizeDesktopCommanderExecution } from "./execution-authorization.js";
import { isReadOnlyDesktopCommanderTool, readOnlyDesktopCommanderToolNames } from "./tool-policy.js";
import { makeClaimed, makeLease, makeRoot, makeWorkItem } from "./test-fixtures.js";

/**
 * Hardening item #3: the read-only execution profile must be built from the
 * canonical tool-policy registry (never a second policy system) and must
 * fail closed - a "read-only" signing config can never mint a capability for
 * a mutating tool, and unknown tools are never read-only-eligible.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function authorizationFor(toolName: "read_file" | "write_file" | "start_process") {
  const { root, config } = makeRoot("dc-readonly-profile-");
  roots.push(root);
  const requestedActions =
    toolName === "read_file"
      ? [{ kind: "read_file", description: "read", params: { tool: "read_file", arguments: { path: `${root}/a.txt` } } }]
      : toolName === "write_file"
        ? [{ kind: "write_file", description: "write", params: { tool: "write_file", arguments: { path: `${root}/a.txt`, content: "x" } } }]
        : [{ kind: "start_process", description: "spawn", params: { tool: "start_process", arguments: { command: "git commit -m test", cwd: root, timeout_ms: 1000 } } }];
  const workItem = makeWorkItem(root, { requestedActions });
  const claimed = makeClaimed(workItem);
  return authorizeDesktopCommanderExecution({
    claimed,
    trustedWorkItem: workItem,
    lease: makeLease(claimed, toolName !== "read_file" ? { approvalId: "appr_1" } : {}),
    workerId: "worker_1",
    containment: config,
    requestId: "request_1",
    now: new Date("2026-01-01T00:00:00.000Z")
  });
}

function signingConfig(profile?: "read-only" | "full") {
  const pair = generateKeyPairSync("ed25519");
  return { runtimeId: "runtime_1", keyId: "test-key-1", privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"), profile };
}

describe("read-only Desktop Commander execution profile", () => {
  it("derives the read-only tool set from mutating:false in the canonical policy registry", () => {
    const names = readOnlyDesktopCommanderToolNames();
    expect(names).toContain("read_file");
    expect(names).toContain("list_directory");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("start_process");
    expect(names).not.toContain("edit_block");
    expect(names).not.toContain("move_file");
    expect(names).not.toContain("create_directory");
  });

  it("fails closed for an unlisted/unknown tool name", () => {
    expect(isReadOnlyDesktopCommanderTool("definitely_not_a_real_tool")).toBe(false);
  });

  it("a read-only profile mints a capability for a genuinely read-only tool", () => {
    const authorization = authorizationFor("read_file");
    const config = signingConfig("read-only");
    const payload = prepareDesktopCommanderCapability(authorization, authorization.requestHash, config, new Date("2026-01-01T00:00:00.000Z"));
    expect(payload.toolName).toBe("read_file");
    expect(payload.scopes).toEqual(["fs.read"]);
  });

  it("a read-only profile REFUSES to mint a capability for write_file (fs mutation)", () => {
    const authorization = authorizationFor("write_file");
    const config = signingConfig("read-only");
    expect(() => prepareDesktopCommanderCapability(authorization, authorization.requestHash, config, new Date("2026-01-01T00:00:00.000Z"))).toThrow(
      /read-only profile cannot mint a capability for mutating tool "write_file"/
    );
  });

  it("a read-only profile REFUSES to mint a capability for start_process (process spawn)", () => {
    const authorization = authorizationFor("start_process");
    const config = signingConfig("read-only");
    expect(() => prepareDesktopCommanderCapability(authorization, authorization.requestHash, config, new Date("2026-01-01T00:00:00.000Z"))).toThrow(
      /read-only profile cannot mint a capability for mutating tool "start_process"/
    );
  });

  it("a full-profile (default) config is unaffected: write_file still mints normally", () => {
    const authorization = authorizationFor("write_file");
    const config = signingConfig(); // profile omitted -> "full", unchanged existing behavior
    const payload = prepareDesktopCommanderCapability(authorization, authorization.requestHash, config, new Date("2026-01-01T00:00:00.000Z"));
    expect(payload.toolName).toBe("write_file");
    expect(payload.scopes).toEqual(["fs.write"]);
  });
});
