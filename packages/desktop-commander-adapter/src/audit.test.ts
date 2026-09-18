import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authorizeDesktopCommanderExecution } from "./execution-authorization.js";
import { toolCalledEvent, toolOutcomeEvent } from "./audit.js";
import { makeClaimed, makeLease, makeRoot, makeWorkItem } from "./test-fixtures.js";
import type { ContainmentConfig } from "./containment.js";

let root: string;
let config: ContainmentConfig;
beforeAll(() => {
  const made = makeRoot("dc-audit-");
  root = made.root;
  config = made.config;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SENTINEL_SECRET = "SENTINEL-TOKEN-sk-abc123xyz";
const SENTINEL_CONTENT = "SENTINEL-FILE-CONTENTS-topsecret";

function authFor(extraArguments: Record<string, unknown> = {}) {
  const workItem = makeWorkItem(root, {
    requestedActions: [
      {
        kind: "read_file",
        description: "read",
        params: { tool: "read_file", arguments: { path: `${root}/pkg/a.txt`, ...extraArguments } }
      }
    ]
  });
  const claimed = makeClaimed(workItem);
  return authorizeDesktopCommanderExecution({
    claimed,
    trustedWorkItem: workItem,
    lease: makeLease(claimed),
    workerId: "worker_1",
    containment: config,
    requestId: "req_audit",
    now: new Date("2026-08-30T00:00:05.000Z")
  });
}

function serializeDraft(draft: { name: string; body: Record<string, unknown>; attributes: Record<string, unknown> }): string {
  return JSON.stringify(draft);
}

describe("desktop_commander audit redaction", () => {
  it("never persists raw arguments, secrets, or file contents in tool_called events", () => {
    // The extra argument would be rejected by the read_file args schema in the
    // real policy path, but audit builders must be safe regardless of shape.
    const auth = {
      ...authFor(),
      normalizedArguments: {
        path: `${root}/pkg/a.txt`,
        content: SENTINEL_CONTENT,
        apiToken: SENTINEL_SECRET
      }
    } as ReturnType<typeof authFor>;

    const event = toolCalledEvent(auth);
    const serialized = serializeDraft(event);

    expect(serialized).not.toContain(SENTINEL_SECRET);
    expect(serialized).not.toContain(SENTINEL_CONTENT);
    expect(serialized).not.toContain("normalizedArguments");
    expect(event.body.arguments).toBeUndefined();
    // Forensic metadata is retained and deterministic.
    expect(event.body.argumentsDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(event.body.argumentCount).toBe(3);
    expect(event.body.canonicalPaths).toEqual([`${root}/pkg/a.txt`]);
  });

  it("produces a stable digest for identical arguments (deterministic auditability)", () => {
    const first = toolCalledEvent(authFor());
    const second = toolCalledEvent(authFor());
    expect(first.body.argumentsDigest).toBe(second.body.argumentsDigest);
  });

  it("records terminal outcome classification and ACS error codes without raw errors", () => {
    const auth = authFor();
    const succeeded = toolOutcomeEvent(auth, {
      ok: true,
      durationMs: 12,
      resultHash: "a".repeat(64),
      truncated: false,
      isError: false,
      outcome: "succeeded"
    });
    expect(succeeded.body.outcome).toBe("succeeded");
    expect(succeeded.attributes["execution.terminal_outcome"]).toBe("succeeded");

    const timedOut = toolOutcomeEvent(auth, {
      ok: false,
      durationMs: 30_000,
      resultHash: "",
      truncated: false,
      isError: true,
      outcome: "timeout",
      errorCode: "desktop_commander_tool_timeout"
    });
    expect(timedOut.body.outcome).toBe("timeout");
    expect(timedOut.body.errorCode).toBe("desktop_commander_tool_timeout");
    expect(timedOut.attributes["execution.terminal_outcome"]).toBe("timeout");
    expect(serializeDraft(timedOut)).not.toContain(SENTINEL_SECRET);
  });
});
