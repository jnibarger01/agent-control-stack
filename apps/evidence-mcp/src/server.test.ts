import { describe, expect, it } from "vitest";
import {
  EVIDENCE_READ_CAPABILITIES,
  FORBIDDEN_CAPABILITY_PATTERNS,
  assertNoForbiddenCapability,
  type EvidenceReadSurface
} from "@agent-control-stack/evidence";
import { EVIDENCE_MCP_TOOL_NAMES, handleEvidenceMcpRequest } from "./server.js";

// A surface whose every capability just echoes what it was asked, so we can
// observe dispatch without any real store/workspace.
function fakeSurface(): EvidenceReadSurface {
  const make = (name: string) => async (input?: unknown) => ({ capability: name, input: input ?? null });
  return Object.fromEntries(
    EVIDENCE_READ_CAPABILITIES.map((name) => [name, make(name)])
  ) as unknown as EvidenceReadSurface;
}

const rpc = (method: string, params?: unknown) => ({ jsonrpc: "2.0", id: 1, method, params });

describe("evidence-mcp — the tool surface cannot act (proof 3)", () => {
  it("tools/list advertises EXACTLY the read capabilities and nothing privileged", async () => {
    const response = (await handleEvidenceMcpRequest(fakeSurface(), rpc("tools/list"))) as {
      result: { tools: Array<{ name: string }> };
    };
    const names = response.result.tools.map((t) => t.name);
    expect([...names].sort()).toEqual([...EVIDENCE_READ_CAPABILITIES].sort());
    expect(names).toEqual([...EVIDENCE_MCP_TOOL_NAMES]);
    expect(assertNoForbiddenCapability(names)).toEqual([]);
  });

  it("no advertised tool matches a write/exec/approve/mutate pattern", async () => {
    const response = (await handleEvidenceMcpRequest(fakeSurface(), rpc("tools/list"))) as {
      result: { tools: Array<{ name: string }> };
    };
    for (const { name } of response.result.tools) {
      for (const pattern of FORBIDDEN_CAPABILITY_PATTERNS) {
        expect(pattern.test(name), `${name} matched ${pattern}`).toBe(false);
      }
    }
  });

  it("calling a privileged tool name is a plain 'method not found' — the branch does not exist", async () => {
    for (const forbidden of ["write_file", "start_process", "approve_work_item", "submit_work_result", "git_commit"]) {
      const response = (await handleEvidenceMcpRequest(fakeSurface(), rpc("tools/call", { name: forbidden, arguments: {} }))) as {
        error?: { code: number; message: string };
      };
      expect(response.error).toBeDefined();
      // -32602 (schema rejects the enum) — there is no handler to reach.
      expect(response.error!.code).toBe(-32602);
    }
  });

  it("a read tool dispatches to the read surface and returns structuredContent", async () => {
    const response = (await handleEvidenceMcpRequest(
      fakeSurface(),
      rpc("tools/call", { name: "git_status", arguments: {} })
    )) as { result: { structuredContent: { capability: string } } };
    expect(response.result.structuredContent.capability).toBe("git_status");
  });

  it("initialize returns a read-only server identity", async () => {
    const response = (await handleEvidenceMcpRequest(fakeSurface(), rpc("initialize"))) as {
      result: { serverInfo: { name: string } };
    };
    expect(response.result.serverInfo.name).toBe("acs-evidence-mcp");
  });
});
