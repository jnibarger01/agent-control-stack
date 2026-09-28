/**
 * Shared fixtures for the Jace Commander approval tests (PR #212 review
 * B2/B3). Fake values only. The gated tool list is derived from the
 * canonical manifest so a new approval-gated tool cannot miss a guard.
 */
import { jcToolContracts } from "@agent-control-stack/jc-tool-manifest";
import { createWorkItemSchema } from "@agent-control-stack/work-items";
import {
  jaceCommanderApprovalSummary,
  jaceCommanderWorkItemIntent,
  jaceCommanderWorkItemTitle,
  validateJaceCommanderInvocation,
  type JaceCommanderInvocation
} from "./jace-commander.js";

export const REQUESTER = "chatgpt:jacen";
export const HUMAN = "operator-human";
export const WORKER = "acs-jc-bridge";
export const HEAD = "0123456789abcdef0123456789abcdef01234567";
export const FAKE_SECRET = "ghp_" + "F".repeat(36);

/** Valid arguments for every approval-gated tool (fake values only). */
export const GATED_ARGS: Readonly<Record<string, Record<string, unknown>>> = {
  privileged_exec: { argv: ["/usr/bin/apt-get", "update"], timeoutMs: 120000 },
  write_file: { path: "/srv/work/notes.txt", content: `hello world\nAPI_TOKEN=${FAKE_SECRET}\n`, overwrite: true },
  create_directory: { path: "/srv/work/new-dir", recursive: true },
  move_file: { from: "/srv/work/a.txt", to: "/srv/work/b.txt" },
  edit_block: { path: "/srv/work/app.ts", old: "const retries = 1;", new: `const token = "${FAKE_SECRET}";` },
  start_process: { argv: ["/usr/bin/node", "script.js", `--token=${FAKE_SECRET}`], cwd: "/srv/work", timeoutMs: 5000 },
  kill_process: { sessionId: "proc_abc123", pid: 4242 },
  git_add: { repo: "/srv/work/repo", paths: ["README.md", "src/index.ts"] },
  git_commit: { repo: "/srv/work/repo", message: "docs: update readme" },
  git_fetch: { repo: "/srv/work/repo", remote: "origin" },
  git_push: { repo: "/srv/work/repo", remote: "origin", branch: "main", expectedHead: HEAD }
};

/** The fields each tool's approval summary must show the approver. */
export const SUMMARY_FIELDS: Readonly<Record<string, Record<string, unknown>>> = {
  privileged_exec: { runAs: "root", argv: ["/usr/bin/apt-get", "update"], cwd: "/", timeoutMs: 120000, stdinBytes: 0 },
  write_file: { path: "/srv/work/notes.txt", overwrite: true },
  create_directory: { path: "/srv/work/new-dir" },
  move_file: { from: "/srv/work/a.txt", to: "/srv/work/b.txt" },
  edit_block: { path: "/srv/work/app.ts", oldPreview: "const retries = 1;" },
  start_process: { cwd: "/srv/work", timeoutMs: 5000 },
  kill_process: { sessionId: "proc_abc123", pid: 4242 },
  git_add: { repo: "/srv/work/repo", paths: ["README.md", "src/index.ts"] },
  git_commit: { repo: "/srv/work/repo", message: "docs: update readme" },
  git_fetch: { repo: "/srv/work/repo", remote: "origin" },
  git_push: { repo: "/srv/work/repo", remote: "origin", branch: "main", expectedHead: HEAD }
};

export const GATED = jcToolContracts()
  .filter((tool) => tool.requiresApproval)
  .map((tool) => tool.name)
  .sort();

export function invocationFor(tool: string): JaceCommanderInvocation {
  const args = GATED_ARGS[tool];
  if (!args) throw new Error(`no fixture arguments for approval-gated tool ${tool}`);
  return validateJaceCommanderInvocation(tool, args);
}

/** The work item /jc/capability/issue creates (apps/gateway/src/server.ts). */
export function jcWorkItemInput(invocation: JaceCommanderInvocation, requesterSubject: string) {
  return createWorkItemSchema.parse({
    title: jaceCommanderWorkItemTitle(invocation),
    intent: jaceCommanderWorkItemIntent(invocation, requesterSubject),
    requester: "agent",
    requesterSubject,
    target: {},
    requestedActions: [
      {
        kind: invocation.policy.actionKind,
        description: `Jace Commander tool ${invocation.toolName}`,
        params: {
          tool: invocation.toolName,
          contract: "acs.jc.v1",
          invocationHash: invocation.invocationHash,
          requesterSubject,
          approvalSummary: jaceCommanderApprovalSummary(invocation),
          write: invocation.policy.actionKind === "privileged.exec",
          network: false
        }
      }
    ],
    risk: invocation.policy.risk
  });
}
