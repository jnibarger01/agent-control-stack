import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EVIDENCE_READ_CAPABILITIES,
  FORBIDDEN_CAPABILITY_PATTERNS,
  assertNoForbiddenCapability
} from "./read-surface.js";
import { EvidenceReader, type EvidenceStoreReader } from "./reader.js";

describe("evidence read surface — forbidden capabilities cannot exist", () => {
  it("the capability list contains no privileged operation", () => {
    const violations = assertNoForbiddenCapability([...EVIDENCE_READ_CAPABILITIES]);
    expect(violations).toEqual([]);
  });

  it("assertNoForbiddenCapability flags injected privileged names", () => {
    const injected = [
      "write_file",
      "delete_file",
      "exec_command",
      "start_process",
      "npm_install",
      "git_commit",
      "restart_service",
      "http_fetch",
      "approve_work_item",
      "retry_work_item",
      "transition_work_item",
      "submit_work_result"
    ];
    const violations = assertNoForbiddenCapability(injected).map((v) => v.name);
    expect(violations.sort()).toEqual(injected.sort());
  });

  it("read-only names (git_status, git_diff, approval_summary) are NOT flagged", () => {
    expect(assertNoForbiddenCapability(["git_status", "git_diff", "approval_summary", "policy_decision"])).toEqual(
      []
    );
  });

  it("every forbidden pattern is a RegExp", () => {
    for (const p of FORBIDDEN_CAPABILITY_PATTERNS) expect(p).toBeInstanceOf(RegExp);
  });
});

describe("EvidenceReader — instance exposes exactly the read capabilities", () => {
  let dir: string;
  let reader: EvidenceReader;

  const fakeStore: EvidenceStoreReader = {
    getWorkItemSummary: () => ({ id: "wrk_1", status: "running" }),
    getAttemptSummary: () => ({ attemptId: "attempt_1", status: "running" }),
    getWorkspaceAllocationSummary: () => ({ allocationId: "workspace_1" }),
    getValidationRunSummary: () => ({ passed: true, checks: [] }),
    getExecutionPlanSummary: () => ({ planHash: "a".repeat(64) }),
    getExecutionSummary: () => ({ outcome: "succeeded" }),
    getSandboxSummary: () => ({ profile: "desktop_commander", network: "none" }),
    getPolicyDecisions: () => [{ decision: "allow" }],
    getApprovalSummary: () => ({ approved: false }),
    getAuditExcerpt: () => [{ name: "work_item.running" }],
    getEvidenceManifest: () => ({ manifestHash: "b".repeat(64) })
  };

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "acs-ereader-")));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "export const x = 1;\n// TODO fix\n");
    reader = new EvidenceReader({
      workItemId: "wrk_1",
      attemptId: "attempt_1",
      workspaceHostPath: dir,
      store: fakeStore
    });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("its own-enumerable + prototype method names contain no forbidden capability", () => {
    const names = new Set<string>();
    for (const k of Object.keys(reader as unknown as Record<string, unknown>)) names.add(k);
    let proto = Object.getPrototypeOf(reader);
    while (proto && proto !== Object.prototype) {
      for (const k of Object.getOwnPropertyNames(proto)) if (k !== "constructor") names.add(k);
      proto = Object.getPrototypeOf(proto);
    }
    // Drop the private git helper; it is not a capability.
    names.delete("git");
    const violations = assertNoForbiddenCapability([...names]);
    expect(violations).toEqual([]);
    for (const cap of EVIDENCE_READ_CAPABILITIES) expect(names.has(cap)).toBe(true);
  });

  it("read_file is contained to the workspace and refuses traversal / credential paths", async () => {
    const ok = (await reader.read_file({ path: "src/a.ts" })) as { content: string };
    expect(ok.content).toContain("export const x");
    await expect(reader.read_file({ path: "../../../etc/passwd" })).rejects.toThrow(/escape|outside/);
    await expect(reader.read_file({ path: "/etc/passwd" })).rejects.toThrow(/outside/);
  });

  it("search_workspace and list_directory only observe", async () => {
    const search = (await reader.search_workspace({ query: "TODO" })) as { matches: Array<{ text: string }> };
    expect(Array.isArray(search.matches)).toBe(true);
    expect(search.matches.some((m) => m.text.includes("TODO"))).toBe(true);
    const list = (await reader.list_directory({ path: "src" })) as { entries: Array<{ path: string }> };
    expect(list.entries.some((e) => e.path.endsWith("a.ts"))).toBe(true);
  });
});
