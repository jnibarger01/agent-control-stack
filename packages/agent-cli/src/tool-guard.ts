/**
 * ACS tool guard for Claude Code: a PreToolUse hook that decides every tool call before it runs.
 *
 * Self-contained on purpose (no imports) so Node can run it directly from `dist/` or `src/`. It is a
 * deterministic deny-list plus an audit log, not a sandbox: file tools are contained to the run's worktree,
 * but Bash is matched by pattern and a determined command can still evade it. It governs Claude Code only.
 *
 * Usage as a hook: `node tool-guard.js <worktree> <log.jsonl>`; the tool call arrives as JSON on stdin.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

export interface GuardDecision {
  decision: "allow" | "deny";
  reason?: string;
}

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "NotebookRead"]);
const SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".config/gh", ".netrc", ".docker/config.json", ".kube"];

const BASH_DENY: Array<[RegExp, string]> = [
  [/\bgit\b[^;&|\n]*\bpush\b/u, "git push is not allowed in an agent run"],
  [/\bgit\b[^;&|\n]*\bremote\s+(?:add|set-url)\b/u, "changing git remotes is not allowed"],
  [/\bgh\s+(?:pr|release|repo|api|auth|secret)\b/u, "GitHub CLI mutations are not allowed"],
  [/\b(?:curl|wget|nc|ncat|netcat|ssh|scp|sftp|rsync|ftp|telnet)\b/u, "network and remote-shell tools are not allowed"],
  [/\b(?:sudo|su|doas|pkexec)\b/u, "privilege escalation is not allowed"],
  [/\b(?:npm|pnpm|yarn)\s+publish\b/u, "publishing packages is not allowed"],
  [
    /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(?:\/(?!\S*\/worktrees\/)\S*|~\S*|\$HOME\S*)/u,
    "recursive delete outside the worktree"
  ],
  [/\b(?:chmod|chown)\s+(?:-R\s+)?\S+\s+\/(?!\S*\/worktrees\/)/u, "changing permissions outside the worktree"],
  [/\bdd\s+[^|;&]*\bof=\/dev\//u, "writing to a device is not allowed"],
  [/>\s*(?:\/etc|\/usr|\/bin|\/var|~\/\.|\$HOME\/\.)/u, "redirecting output into system or dotfile paths"]
];

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function filePath(input: Record<string, unknown>): string | undefined {
  for (const key of ["file_path", "notebook_path", "path"]) {
    if (typeof input[key] === "string") return input[key] as string;
  }
  return undefined;
}

export function decideToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  worktree: string,
  home: string = homedir()
): GuardDecision {
  const root = resolve(worktree);
  if (WRITE_TOOLS.has(toolName) || READ_TOOLS.has(toolName)) {
    const raw = filePath(toolInput);
    if (raw === undefined) return { decision: "allow" };
    const target = resolve(root, raw.startsWith("~/") ? resolve(home, raw.slice(2)) : raw);
    if (WRITE_TOOLS.has(toolName) && !inside(root, target)) {
      return { decision: "deny", reason: `writes are limited to the run worktree (${root})` };
    }
    if (READ_TOOLS.has(toolName) && SECRET_DIRS.some((dir) => inside(resolve(home, dir), target))) {
      return { decision: "deny", reason: "credential stores are not readable by an agent run" };
    }
    return { decision: "allow" };
  }
  if (toolName === "Bash") {
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    for (const [pattern, reason] of BASH_DENY) {
      if (pattern.test(command)) return { decision: "deny", reason };
    }
  }
  return { decision: "allow" };
}

/** Where an online guard asks ACS for each decision. The token is read from a 0600 file, never from argv. */
export interface OnlineGuard {
  url: string;
  runId: string;
  tokenFile: string;
}

/** Shell command string for a hook entry. Arguments are single-quoted. */
export function toolGuardHookCommand(
  scriptPath: string,
  worktree: string,
  logPath: string,
  online?: OnlineGuard
): string {
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  const args = [
    process.execPath,
    scriptPath,
    worktree,
    logPath,
    ...(online ? [online.url, online.runId, online.tokenFile] : [])
  ];
  return args.map(quote).join(" ");
}

/** The `--settings` JSON that installs the guard for every tool. */
export function toolGuardSettings(hookCommand: string): string {
  return JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hookCommand }] }] }
  });
}

export interface ToolAuditSummary {
  total: number;
  denied: number;
  deniedCalls: Array<{ tool: string; reason: string }>;
}

export function summarizeToolLog(text: string): ToolAuditSummary {
  const summary: ToolAuditSummary = { total: 0, denied: 0, deniedCalls: [] };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { tool?: string; decision?: string; reason?: string };
      summary.total += 1;
      if (entry.decision === "deny") {
        summary.denied += 1;
        if (summary.deniedCalls.length < 20) {
          summary.deniedCalls.push({
            tool: String(entry.tool ?? ""),
            reason: String(entry.reason ?? "").slice(0, 200)
          });
        }
      }
    } catch {
      /* a torn final line is ignored */
    }
  }
  return summary;
}

/** Ask the ACS gateway to decide. Any failure is a denial: an unreachable authority grants nothing. */
async function askGateway(
  online: OnlineGuard,
  toolName: string,
  input: Record<string, unknown>
): Promise<GuardDecision & { answered: boolean }> {
  try {
    const token = readFileSync(online.tokenFile, "utf8").trim();
    const response = await fetch(`${online.url.replace(/\/$/u, "")}/api/agent-runs/${online.runId}/tool-check`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ tool: toolName, input }),
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) {
      return { decision: "deny", reason: `ACS refused the tool check (HTTP ${response.status})`, answered: false };
    }
    const body = (await response.json()) as GuardDecision;
    return body.decision === "allow"
      ? { decision: "allow", answered: true }
      : { decision: "deny", reason: String(body.reason ?? "denied by ACS"), answered: true };
  } catch {
    return { decision: "deny", reason: "ACS gateway unreachable; failing closed", answered: false };
  }
}

async function main(): Promise<void> {
  const [worktree, logPath, onlineUrl, onlineRun, onlineToken] = process.argv.slice(2);
  const online: OnlineGuard | undefined =
    onlineUrl && onlineRun && onlineToken ? { url: onlineUrl, runId: onlineRun, tokenFile: onlineToken } : undefined;
  if (!worktree || !logPath) {
    process.stderr.write("tool-guard: worktree and log path are required\n");
    process.exit(2);
  }
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let decision: GuardDecision;
  let toolName = "unknown";
  let summary = "";
  let onlineHandled = false;
  try {
    const payload = JSON.parse(raw) as { tool_name?: string; tool_input?: Record<string, unknown> };
    toolName = String(payload.tool_name ?? "unknown");
    const input = payload.tool_input ?? {};
    // The local deny-list is a floor: ACS can only add restrictions, never lift one.
    decision = decideToolCall(toolName, input, worktree);
    if (online && decision.decision === "allow") {
      const answer = await askGateway(online, toolName, input);
      decision = { decision: answer.decision, ...(answer.reason ? { reason: answer.reason } : {}) };
      onlineHandled = answer.answered;
    }
    summary = String(input.command ?? filePath(input) ?? "").slice(0, 300);
  } catch {
    // A guard that cannot read its input must fail closed.
    decision = { decision: "deny", reason: "tool guard could not parse the tool call" };
  }
  try {
    // When ACS decided, the gateway already recorded the call in its audit chain and this run's log.
    if (!onlineHandled)
      appendFileSync(
        logPath,
        `${JSON.stringify({ at: new Date().toISOString(), tool: toolName, decision: decision.decision, reason: decision.reason, summary })}\n`,
        { mode: 0o600 }
      );
  } catch {
    // An unwritable audit log must also fail closed: no unrecorded tool calls.
    decision = { decision: "deny", reason: "tool guard could not record the call" };
  }
  if (decision.decision === "deny") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `ACS tool guard: ${decision.reason}`
        }
      })
    );
  }
}

if (process.argv[1] && /tool-guard\.(?:js|ts)$/u.test(process.argv[1])) {
  void main();
}
