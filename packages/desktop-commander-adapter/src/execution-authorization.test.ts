import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executionActionHash } from "@agent-control-stack/work-items";
import { authorizeDesktopCommanderExecution, isExecutionAuthorization } from "./execution-authorization.js";
import type { ContainmentConfig } from "./containment.js";
import { makeClaimed, makeLease, makeRoot, makeWorkItem } from "./test-fixtures.js";

let root: string;
let config: ContainmentConfig;

beforeAll(() => {
  const made = makeRoot("dc-authz-");
  root = made.root;
  config = made.config;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function baseInput() {
  const workItem = makeWorkItem(root);
  const claimed = makeClaimed(workItem);
  const lease = makeLease(claimed);
  return {
    claimed,
    trustedWorkItem: workItem,
    lease,
    workerId: "worker_1",
    containment: config,
    requestId: "req_1",
    now: new Date("2026-08-30T00:00:05.000Z")
  };
}

describe("authorizeDesktopCommanderExecution", () => {
  it("produces a branded authorization on the happy path", () => {
    const auth = authorizeDesktopCommanderExecution(baseInput());
    expect(isExecutionAuthorization(auth)).toBe(true);
    expect(auth.toolName).toBe("read_file");
    expect(auth.actionHash).toBe(executionActionHash(makeWorkItem(root)));
    expect(auth.invocationFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(auth)).toBe(true);
  });

  it("a plain object is not an ExecutionAuthorization", () => {
    expect(isExecutionAuthorization({ toolName: "read_file", actionHash: "x" })).toBe(false);
    expect(isExecutionAuthorization(null)).toBe(false);
  });

  it("rejects a non-running work item", () => {
    const input = baseInput();
    input.trustedWorkItem = { ...input.trustedWorkItem, status: "approved" } as typeof input.trustedWorkItem;
    expect(() => authorizeDesktopCommanderExecution(input)).toThrow(/not executable|not running/);
  });

  it("rejects a worker mismatch", () => {
    const input = baseInput();
    input.workerId = "worker_2";
    expect(() => authorizeDesktopCommanderExecution(input)).toThrow(/lease is not held by this worker/);
  });

  it("rejects an expired lease", () => {
    const input = baseInput();
    input.lease = makeLease(input.claimed, { expiresAt: "2000-01-01T00:00:00.000Z" });
    expect(() => authorizeDesktopCommanderExecution(input)).toThrow(/lease has expired/);
  });

  it("rejects an inactive lease", () => {
    const input = baseInput();
    input.lease = makeLease(input.claimed, { status: "revoked" });
    expect(() => authorizeDesktopCommanderExecution(input)).toThrow(/lease is revoked/);
  });

  it("rejects a lease bound to a different work item", () => {
    const input = baseInput();
    input.lease = makeLease(input.claimed, { workItemId: "wi_other" });
    expect(() => authorizeDesktopCommanderExecution(input)).toThrow(/does not belong to this work item/);
  });

  it("rejects a fencing epoch mismatch", () => {
    const input = baseInput();
    input.lease = makeLease(input.claimed, { fencingEpoch: 2 });
    expect(() => authorizeDesktopCommanderExecution(input)).toThrow(/fencing epoch/);
  });

  it("rejects when the action hash changed after claim", () => {
    const input = baseInput();
    // Trusted state now asks for a different file than what was claimed/approved.
    input.trustedWorkItem = makeWorkItem(root, {
      requestedActions: [
        {
          kind: "read_file",
          description: "read a file",
          params: { tool: "read_file", arguments: { path: `${root}/pkg/OTHER.txt` } }
        }
      ]
    });
    expect(() => authorizeDesktopCommanderExecution(input)).toThrow(/action hash changed/);
  });

  it("rejects a requires-approval tool without an approval reference", () => {
    const workItem = makeWorkItem(root, {
      requestedActions: [
        {
          kind: "write_file",
          description: "write a file",
          params: { tool: "write_file", arguments: { path: `${root}/pkg/a.txt`, content: "x" } }
        }
      ]
    });
    const claimed = makeClaimed(workItem);
    const lease = makeLease(claimed, { approvalId: undefined });
    expect(() =>
      authorizeDesktopCommanderExecution({
        claimed,
        trustedWorkItem: workItem,
        lease,
        workerId: "worker_1",
        containment: config,
        requestId: "req_2",
        now: new Date("2026-08-30T00:00:05.000Z")
      })
    ).toThrow(/requires approval but the lease carries no approval reference/);
  });

  it("accepts a requires-approval tool with an approval reference", () => {
    const workItem = makeWorkItem(root, {
      requestedActions: [
        {
          kind: "write_file",
          description: "write a file",
          params: { tool: "write_file", arguments: { path: `${root}/pkg/a.txt`, content: "x" } }
        }
      ]
    });
    const claimed = makeClaimed(workItem);
    const lease = makeLease(claimed, { approvalId: "appr_1" });
    const auth = authorizeDesktopCommanderExecution({
      claimed,
      trustedWorkItem: workItem,
      lease,
      workerId: "worker_1",
      containment: config,
      requestId: "req_3",
      now: new Date("2026-08-30T00:00:05.000Z")
    });
    expect(auth.approvalId).toBe("appr_1");
    expect(auth.requiresApproval).toBe(true);
  });

  it("rejects a path that escapes the allow root at authorization time", () => {
    const workItem = makeWorkItem(root, {
      requestedActions: [
        {
          kind: "read_file",
          description: "read",
          params: { tool: "read_file", arguments: { path: "/etc/shadow" } }
        }
      ]
    });
    const claimed = makeClaimed(workItem);
    expect(() =>
      authorizeDesktopCommanderExecution({
        claimed,
        trustedWorkItem: workItem,
        lease: makeLease(claimed),
        workerId: "worker_1",
        containment: config,
        requestId: "req_4",
        now: new Date("2026-08-30T00:00:05.000Z")
      })
    ).toThrow(/outside every allow root/);
  });
});
