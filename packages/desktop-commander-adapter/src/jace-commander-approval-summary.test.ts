/**
 * Regression for the PR #212 review, B3: the approver of an approval-gated
 * Jace Commander tool saw only {tool, invocationHash}. Every gated tool now
 * has a summary builder over its validated arguments (bounded, secret-looking
 * values redacted) and the invocation-hash binding is kept.
 */
import { describe, expect, it } from "vitest";
import {
  JACE_COMMANDER_APPROVAL_SUMMARY_BUILDERS,
  jaceCommanderApprovalSummary,
  jaceCommanderApprovalSummaryText,
  jaceCommanderWorkItemIntent,
  jaceCommanderWorkItemTitle,
  redactJaceCommanderPreview,
  validateJaceCommanderInvocation
} from "./jace-commander.js";
import {
  FAKE_SECRET,
  GATED,
  GATED_ARGS,
  REQUESTER,
  SUMMARY_FIELDS,
  invocationFor
} from "./jace-commander-approval.test-support.js";

describe("Jace Commander approval-gated tools (manifest-derived)", () => {
  it("the gated set is exactly the manifest's requiresApproval tools, and every one has fixtures", () => {
    expect(GATED).toEqual(
      [
        "create_directory",
        "edit_block",
        "git_add",
        "git_commit",
        "git_fetch",
        "git_push",
        "kill_process",
        "move_file",
        "privileged_exec",
        "start_process",
        "write_file"
      ].sort()
    );
    for (const tool of GATED) {
      expect(GATED_ARGS[tool], tool).toBeDefined();
      expect(SUMMARY_FIELDS[tool], tool).toBeDefined();
    }
  });
});

describe("B3: approvers see a bounded, redacted summary of the validated arguments", () => {
  it("every approval-gated manifest tool has a summary builder (no drift)", () => {
    for (const tool of GATED) expect(JACE_COMMANDER_APPROVAL_SUMMARY_BUILDERS[tool], tool).toBeTypeOf("function");
  });

  for (const tool of GATED) {
    it(`${tool}: the summary carries its fields and keeps the invocation-hash binding`, () => {
      const invocation = invocationFor(tool);
      const summary = jaceCommanderApprovalSummary(invocation);
      expect(summary).toMatchObject({ tool, ...SUMMARY_FIELDS[tool], invocationHash: invocation.invocationHash });
      expect(Object.keys(summary).length).toBeGreaterThan(2);
      expect(JSON.stringify(summary)).not.toContain(FAKE_SECRET);
      const text = jaceCommanderApprovalSummaryText(invocation);
      expect(text.startsWith(tool)).toBe(true);
      expect(text).not.toContain(FAKE_SECRET);
      expect(jaceCommanderWorkItemTitle(invocation).length).toBeLessThanOrEqual(200);
      if (tool !== "privileged_exec") {
        expect(jaceCommanderWorkItemIntent(invocation, REQUESTER)).toContain(`Approve exactly: ${text}`);
      }
    });
  }

  it("write_file shows path, byte count, sha256, a redacted ~200-char preview and the overwrite flag", () => {
    const content = `line one\nAPI_TOKEN=${FAKE_SECRET}\n${"x".repeat(1000)}`;
    const summary = jaceCommanderApprovalSummary(
      validateJaceCommanderInvocation("write_file", { path: "/srv/work/big.txt", content })
    );
    expect(summary.bytes).toBe(Buffer.byteLength(content));
    expect(summary.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(summary.overwrite).toBe(false);
    expect(String(summary.preview)).toContain("line one");
    expect(String(summary.preview)).toContain("API_TOKEN=[redacted]");
    expect(String(summary.preview).length).toBeLessThanOrEqual(201);
  });

  it("start_process shows argv with secret-looking values redacted; edit_block previews old and new text", () => {
    const process = jaceCommanderApprovalSummary(invocationFor("start_process"));
    expect(process.argv).toEqual(["/usr/bin/node", "script.js", "--token=[redacted]"]);
    const edit = jaceCommanderApprovalSummary(invocationFor("edit_block"));
    expect(edit.newPreview).toBe('const token = "[redacted]";');
  });

  it("non-gated tools keep the minimal summary", () => {
    const invocation = validateJaceCommanderInvocation("acs_read", { view: "health" });
    expect(jaceCommanderApprovalSummary(invocation)).toEqual({
      tool: "acs_read",
      invocationHash: invocation.invocationHash
    });
  });

  it("redaction covers common secret shapes", () => {
    for (const secret of [
      "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
      "Authorization: Bearer abcdefghijklmnop",
      `password=hunter2hunter2`,
      `"client_secret": "abcdef123456"`,
      "https://user:pa55word@example.com/repo.git",
      "AKIAABCDEFGHIJKLMNOP"
    ]) {
      const out = redactJaceCommanderPreview(secret);
      expect(out, secret).toContain("[redacted]");
      expect(out).not.toMatch(/hunter2hunter2|pa55word|abcdef123456|AKIAABCDEFGHIJKLMNOP|abcdefghijklmnop/u);
    }
  });
});
