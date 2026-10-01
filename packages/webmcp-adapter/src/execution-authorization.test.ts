import { describe, expect, it } from "vitest";
import { WebMcpError } from "./contracts.js";
import {
  authorizeWebMcpExecution,
  isWebMcpExecutionAuthorization,
  webmcpActionBinding,
  webmcpExecutionKey,
  type AuthorizeWebMcpExecutionInput,
  type WebMcpExecutionAuthorization
} from "./execution-authorization.js";
import { defineWebMcpPolicy } from "./policy.js";
import { invocationFingerprint, validateArguments } from "./normalize.js";
import { expectCode, makeDiscovery, rawTool, webmcpTestOrigin, webmcpTestUrl } from "./test-support.js";
import type { JsonValue } from "./json.js";
import type { AttemptLease, ClaimedWorkItem } from "@agent-control-stack/work-items";
import { executionActionHash } from "@agent-control-stack/work-items";

const READ_ANNOTATIONS = { readOnlyHint: true, consequentialHint: false, untrustedContentHint: false };
const HASH = (seed: string): string => seed.repeat(64).slice(0, 64).replace(/[^a-f0-9]/gu, "a");

const policy = defineWebMcpPolicy([
  { origin: webmcpTestOrigin, toolName: "get_showroom_hours", risk: "read_only" },
  { origin: webmcpTestOrigin, toolName: "set_preferred_contact", risk: "reversible_mutation" }
]);

const readDiscovery = makeDiscovery({
  tool: rawTool({ name: "get_showroom_hours", annotations: READ_ANNOTATIONS })
});
const mutationDiscovery = makeDiscovery({
  tool: rawTool({
    name: "set_preferred_contact",
    schema: {
      type: "object",
      properties: { method: { type: "string", enum: ["phone", "email"] } },
      required: ["method"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, consequentialHint: true, untrustedContentHint: false }
  })
});

interface FixtureOptions {
  discovery?: typeof readDiscovery;
  args?: Record<string, unknown>;
  /** Arguments the work-item binding was approved for, when they differ from `args`. */
  bindingArgs?: Record<string, unknown>;
  status?: string;
  approvalId?: string;
  leaseOverrides?: Record<string, unknown>;
  claimedOverrides?: Record<string, unknown>;
  actionCount?: number;
  bindingDiscovery?: typeof readDiscovery;
}

function fixture(options: FixtureOptions = {}) {
  const discovery = options.discovery ?? readDiscovery;
  const args = options.args ?? { day: "mon" };
  const bindingArgs = options.bindingArgs ?? args;
  const boundArguments = validateArguments(bindingArgs, discovery.tool.inputSchema) as Record<string, JsonValue>;
  const fingerprint = invocationFingerprint({
    identity: {
      sessionId: discovery.sessionId,
      pageId: discovery.pageId,
      origin: discovery.origin,
      pageUrl: discovery.pageUrl,
      navigationId: discovery.navigationId
    },
    toolName: discovery.tool.name,
    registrationHash: discovery.tool.registrationHash,
    schemaHash: discovery.tool.schemaHash,
    arguments: boundArguments
  });
  const bindingDiscovery = options.bindingDiscovery ?? discovery;
  const actions = Array.from({ length: options.actionCount ?? 1 }, () => ({
    kind: "webmcp.call_tool",
    description: "governed WebMCP call",
    params: webmcpActionBinding(bindingDiscovery, fingerprint, boundArguments)
  }));
  const trustedWorkItem = {
    id: "wi-webmcp-1",
    status: options.status ?? "running",
    requester: "agent" as const,
    intent: "call a page tool",
    target: discovery.origin,
    requestedActions: actions,
    risk: "low" as const
  } as unknown as AuthorizeWebMcpExecutionInput["trustedWorkItem"];
  const actionHash = executionActionHash(trustedWorkItem);
  const planHash = HASH("b");
  const claimed = {
    ...trustedWorkItem,
    workItemId: trustedWorkItem.id,
    workerId: "worker-1",
    attemptId: "att-1",
    leaseId: "lease-1",
    planHash,
    inputHash: HASH("c"),
    fencingEpoch: 1,
    actionHash,
    ...options.claimedOverrides
  } as unknown as ClaimedWorkItem;
  const lease = {
    leaseId: "lease-1",
    attemptId: "att-1",
    workItemId: trustedWorkItem.id,
    admissionId: "adm-1",
    approvalId: options.approvalId,
    workerId: "worker-1",
    tokenHash: HASH("d"),
    planHash,
    inputHash: HASH("c"),
    fencingEpoch: 1,
    protocolVersion: "acs-worker.v1",
    policyVersion: "policy-2026-01",
    policyDecisionHash: HASH("e"),
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    maxExpiresAt: "2099-01-02T00:00:00.000Z",
    lastRenewedAt: "2026-01-01T00:00:00.000Z",
    status: "active",
    ...options.leaseOverrides
  } as unknown as AttemptLease;
  return { claimed, trustedWorkItem, lease, discovery, args };
}

function authorize(options: FixtureOptions = {}): WebMcpExecutionAuthorization {
  const parts = fixture(options);
  return authorizeWebMcpExecution({
    claimed: parts.claimed,
    trustedWorkItem: parts.trustedWorkItem,
    lease: parts.lease,
    workerId: "worker-1",
    requestId: "req-1",
    discovery: parts.discovery,
    arguments: parts.args,
    policy,
    now: new Date("2026-01-01T00:00:00.000Z")
  });
}

describe("authorizeWebMcpExecution", () => {
  it("issues a frozen, branded authorization for an exact read-only binding", () => {
    const auth = authorize();
    expect(isWebMcpExecutionAuthorization(auth)).toBe(true);
    expect(Object.isFrozen(auth)).toBe(true);
    expect(auth.risk).toBe("read_only");
    expect(auth.requiresApproval).toBe(false);
    expect(auth.origin).toBe(webmcpTestOrigin);
    expect(auth.pageUrl).toBe(webmcpTestUrl);
    expect(auth.normalizedArguments).toEqual({ day: "mon" });
    expect(auth.schemaHash).toBe(readDiscovery.tool.schemaHash);
  });

  it("does not treat a plain object as an authorization", () => {
    expect(isWebMcpExecutionAuthorization({ workItemId: "wi-webmcp-1" })).toBe(false);
    expect(isWebMcpExecutionAuthorization(null)).toBe(false);
  });

  it("refuses a work item that is not running", () => {
    expectCode(() => authorize({ status: "approved" }), "webmcp_work_item_not_executable");
  });

  it("refuses when the action hash changed since the claim", () => {
    expectCode(() => authorize({ claimedOverrides: { actionHash: HASH("f") } }), "webmcp_action_hash_changed");
  });

  it("refuses an expired lease", () => {
    expectCode(
      () => authorize({ leaseOverrides: { expiresAt: "2020-01-01T00:00:00.000Z" } }),
      "webmcp_lease_expired"
    );
  });

  it("refuses an inactive lease", () => {
    expectCode(() => authorize({ leaseOverrides: { status: "consumed" } }), "webmcp_lease_inactive");
  });

  it("refuses a lease held by another worker", () => {
    expectCode(() => authorize({ leaseOverrides: { workerId: "worker-2" } }), "webmcp_lease_worker_mismatch");
  });

  it("refuses a fencing-epoch mismatch", () => {
    expectCode(() => authorize({ leaseOverrides: { fencingEpoch: 9 } }), "webmcp_lease_fencing_mismatch");
  });

  it("refuses a plan-hash mismatch", () => {
    expectCode(() => authorize({ leaseOverrides: { planHash: HASH("9") } }), "webmcp_plan_hash_mismatch");
  });

  it("refuses a claim that carries no attempt authority", () => {
    expectCode(
      () => authorize({ claimedOverrides: { attemptId: undefined } }),
      "webmcp_attempt_authority_missing"
    );
  });

  it.each([
    ["no action binding", 0],
    ["more than one action binding", 2]
  ])("refuses a work item with %s", (_label, actionCount) => {
    expectCode(() => authorize({ actionCount }), "webmcp_action_binding_missing");
  });

  it("refuses a binding that references a different discovery record", () => {
    expectCode(
      () => authorize({ discovery: mutationDiscovery, bindingDiscovery: readDiscovery, args: { method: "email" } }),
      "webmcp_discovery_binding_mismatch"
    );
  });

  it("refuses arguments that do not match the schema", () => {
    expectCode(() => authorize({ args: { day: "wed" } }), "webmcp_arguments_invalid");
  });

  it("refuses arguments that drifted from the approved fingerprint", () => {
    // Approval bound `day=mon`; the caller now supplies `day=tue`. Both validate
    // against the schema, so only the exact binding catches the swap.
    try {
      authorize({ args: { day: "tue" }, bindingArgs: { day: "mon" } });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(WebMcpError);
      expect((error as WebMcpError).code).toBe("webmcp_arguments_changed");
    }
  });

  it("refuses a tool that ACS policy does not declare", () => {
    const undeclared = makeDiscovery({ tool: rawTool({ name: "undeclared_tool", annotations: READ_ANNOTATIONS }) });
    expectCode(() => authorize({ discovery: undeclared, args: { day: "mon" } }), "webmcp_tool_denied");
  });
});

describe("approval binding", () => {
  it("requires ACS approval for a mutation and refuses without a lease approval reference", () => {
    try {
      authorize({ discovery: mutationDiscovery, args: { method: "email" } });
      throw new Error("expected an approval requirement");
    } catch (error) {
      expect(error).toBeInstanceOf(WebMcpError);
      expect((error as WebMcpError).code).toBe("webmcp_approval_required");
    }
  });

  it("issues the authorization once an approval is present on the lease", () => {
    const auth = authorize({ discovery: mutationDiscovery, args: { method: "email" }, approvalId: "appr-1" });
    expect(auth.risk).toBe("reversible_mutation");
    expect(auth.requiresApproval).toBe(true);
    expect(auth.approvalId).toBe("appr-1");
    expect(auth.approvalActionHash).toBe(auth.actionHash);
  });

  it("escalates a read-only declaration when the page supplied no annotations", () => {
    const opaque = makeDiscovery({ tool: rawTool({ name: "get_showroom_hours", annotations: null }) });
    try {
      authorize({ discovery: opaque, args: { day: "mon" } });
      throw new Error("expected an approval requirement");
    } catch (error) {
      expect((error as WebMcpError).code).toBe("webmcp_approval_required");
    }
    const approved = authorize({ discovery: opaque, args: { day: "mon" }, approvalId: "appr-2" });
    expect(approved.risk).toBe("reversible_mutation");
    expect(approved.requiresApproval).toBe(true);
  });
});

describe("replay key", () => {
  it("is stable for the same attempt and invocation", () => {
    expect(webmcpExecutionKey(authorize())).toBe(webmcpExecutionKey(authorize()));
  });

  it("changes with the attempt", () => {
    const base = authorize();
    const other = { ...base, attemptId: "att-2" } as WebMcpExecutionAuthorization;
    expect(webmcpExecutionKey(base)).not.toBe(webmcpExecutionKey(other));
  });
});
