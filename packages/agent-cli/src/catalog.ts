/**
 * The CLI agents ACS can dispatch from Mission Control.
 *
 * Every invocation below was checked against the installed CLI's own `--help` on 2026-10-02
 * (claude 2.1.284, codex 0.159.2, opencode 1.18.34, agy 1.2.13, hermes 0.21.5, openclaw 2026.9.7,
 * cursor-agent 2026.09.28, goose 1.45.0, cline 3.0.61). Flags drift between releases, so the probe
 * reports the installed version and the catalog records the version it was verified against.
 *
 * Containment is the CLI's own sandbox plus a dedicated git worktree; ACS does not claim more.
 */
export const AGENT_CLI_IDS = [
  "claude",
  "codex",
  "opencode",
  "antigravity",
  "hermes",
  "openclaw",
  "cursor-agent",
  "goose",
  "cline"
] as const;
export type AgentCliId = (typeof AGENT_CLI_IDS)[number];
export type AgentRunMode = "edit" | "read-only";

export interface AgentCliInvocationInput {
  prompt: string;
  mode: AgentRunMode;
  timeoutSec: number;
  /** Absolute worktree path. Always also the process cwd. */
  cwd: string;
  /** `--settings` JSON installing the ACS tool guard. Only honoured by CLIs that support hooks (Claude Code). */
  guardSettings?: string;
}

export interface AgentCliSpec {
  id: AgentCliId;
  displayName: string;
  binary: string;
  provider: string;
  verifiedAgainst: string;
  versionArgs: readonly string[];
  /** Paths under $HOME whose existence suggests the CLI is signed in. Existence only; never read. */
  loginPaths: readonly string[];
  /** Environment variable name prefixes passed through so the CLI can reach its provider. */
  envPassthrough: readonly string[];
  /** What the CLI itself enforces in `edit` mode. Shown to the operator in the dispatch dialog. */
  editContainment: string;
  readOnlySupported: boolean;
  /**
   * Set when the CLI cannot be dispatched safely today. Dispatch is refused with this reason instead of
   * failing mid-run. Verified by a real run on 2026-10-02; clear it once the cause is fixed.
   */
  dispatchBlockedReason?: string;
  buildArgs(input: AgentCliInvocationInput): string[];
}

function unsupported(id: string): never {
  throw new Error(`${id} has no verified read-only mode`);
}

export const AGENT_CLI_CATALOG: Readonly<Record<AgentCliId, AgentCliSpec>> = {
  claude: {
    id: "claude",
    displayName: "Claude Code",
    binary: "claude",
    provider: "anthropic",
    verifiedAgainst: "2.1.284",
    versionArgs: ["--version"],
    loginPaths: [".claude"],
    envPassthrough: ["ANTHROPIC_", "CLAUDE_CODE_"],
    editContainment:
      "acceptEdits permission mode plus the ACS tool guard: every tool call is logged, file writes outside the worktree, git push, network and privilege tools are denied (a deny-list, not a sandbox)",
    readOnlySupported: true,
    buildArgs: ({ prompt, mode, guardSettings }) => [
      "-p",
      prompt,
      "--permission-mode",
      mode === "edit" ? "acceptEdits" : "plan",
      ...(guardSettings ? ["--settings", guardSettings] : [])
    ]
  },
  codex: {
    id: "codex",
    displayName: "Codex",
    binary: "codex",
    provider: "openai",
    verifiedAgainst: "0.159.2",
    versionArgs: ["--version"],
    loginPaths: [".codex"],
    envPassthrough: ["OPENAI_", "CODEX_"],
    editContainment: "codex --sandbox workspace-write: writes limited to the worktree by Codex's own sandbox",
    readOnlySupported: true,
    buildArgs: ({ prompt, mode }) => [
      "exec",
      "--sandbox",
      mode === "edit" ? "workspace-write" : "read-only",
      "--skip-git-repo-check",
      prompt
    ]
  },
  opencode: {
    id: "opencode",
    displayName: "OpenCode",
    binary: "opencode",
    provider: "multi",
    verifiedAgainst: "1.18.34",
    versionArgs: ["--version"],
    loginPaths: [".local/share/opencode", ".config/opencode"],
    envPassthrough: ["OPENCODE_", "OPENAI_", "ANTHROPIC_"],
    editContainment: "default OpenCode permissions (no --auto); the 'plan' agent in read-only mode",
    readOnlySupported: true,
    buildArgs: ({ prompt, mode, cwd }) => [
      "run",
      "--dir",
      cwd,
      ...(mode === "read-only" ? ["--agent", "plan"] : []),
      prompt
    ]
  },
  antigravity: {
    id: "antigravity",
    displayName: "Antigravity",
    binary: "agy",
    provider: "google",
    verifiedAgainst: "1.2.13",
    versionArgs: ["--version"],
    loginPaths: [".gemini/antigravity-cli"],
    envPassthrough: ["AGY_", "GOOGLE_"],
    editContainment:
      "--mode accept-edits: file edits auto-approved, other tools gated by Antigravity's own permissions; plan mode is read-only",
    readOnlySupported: true,
    buildArgs: ({ prompt, mode }) => ["--print", prompt, "--mode", mode === "edit" ? "accept-edits" : "plan"]
  },
  hermes: {
    id: "hermes",
    displayName: "Hermes",
    binary: "hermes",
    provider: "multi",
    verifiedAgainst: "0.21.5",
    versionArgs: ["--version"],
    loginPaths: [".hermes"],
    envPassthrough: ["HERMES_", "OPENAI_", "ANTHROPIC_"],
    editContainment: "Hermes' own dangerous-command approvals (no --yolo); non-interactive one-shot",
    readOnlySupported: false,
    buildArgs: ({ prompt, mode, cwd }) => (mode === "read-only" ? unsupported("hermes") : ["-z", prompt, "--in", cwd])
  },
  openclaw: {
    id: "openclaw",
    displayName: "OpenClaw",
    binary: "openclaw",
    provider: "multi",
    verifiedAgainst: "2026.9.7",
    versionArgs: ["--version"],
    loginPaths: [".openclaw"],
    envPassthrough: ["OPENCLAW_", "OPENAI_", "ANTHROPIC_"],
    editContainment: "OpenClaw headless embedded turn (`agent exec`) with stored credentials allowed",
    readOnlySupported: false,
    dispatchBlockedReason:
      "`openclaw agent exec` crashes while the OpenClaw Gateway owns its state directory, and `--isolated` loses the stored credentials. No headless path that targets an ACS worktree works yet.",
    buildArgs: ({ prompt, mode, cwd }) =>
      mode === "read-only" ? unsupported("openclaw") : ["agent", "exec", "--cwd", cwd, "--no-auth-env-only", prompt]
  },
  "cursor-agent": {
    id: "cursor-agent",
    displayName: "Cursor Agent",
    binary: "cursor-agent",
    provider: "cursor",
    verifiedAgainst: "2026.09.28",
    versionArgs: ["--version"],
    loginPaths: [".cursor"],
    envPassthrough: ["CURSOR_"],
    editContainment:
      "print mode with tool access but without --force; --trust only marks the ACS-created worktree trusted; 'ask' mode is read-only",
    readOnlySupported: true,
    buildArgs: ({ prompt, mode }) => [
      "-p",
      prompt,
      "--output-format",
      "text",
      "--trust",
      ...(mode === "read-only" ? ["--mode", "ask"] : [])
    ]
  },
  goose: {
    id: "goose",
    displayName: "Goose",
    binary: "goose",
    provider: "multi",
    verifiedAgainst: "1.45.0",
    versionArgs: ["--version"],
    loginPaths: [".config/goose"],
    envPassthrough: ["GOOSE_", "OPENAI_", "ANTHROPIC_", "GOOGLE_"],
    editContainment: "Goose's configured permission mode; single non-interactive run without a saved session",
    readOnlySupported: false,
    dispatchBlockedReason:
      "Goose's configured provider returns 401 Invalid API key (and still exits 0). Fix the provider key with `goose configure`, then re-test.",
    buildArgs: ({ prompt, mode }) =>
      mode === "read-only" ? unsupported("goose") : ["run", "--no-session", "-q", "-t", prompt]
  },
  cline: {
    id: "cline",
    displayName: "Cline",
    binary: "cline",
    provider: "multi",
    verifiedAgainst: "3.0.61",
    versionArgs: ["--version"],
    loginPaths: [".cline"],
    envPassthrough: ["CLINE_"],
    editContainment:
      "act mode with Cline's default auto-approve (it runs its own tools freely); plan mode is read-only",
    readOnlySupported: true,
    buildArgs: ({ prompt, mode, cwd, timeoutSec }) => [
      ...(mode === "read-only" ? ["--plan"] : []),
      "--cwd",
      cwd,
      "--timeout",
      String(timeoutSec),
      prompt
    ]
  }
};

export function agentCliSpec(id: string): AgentCliSpec | undefined {
  return (AGENT_CLI_IDS as readonly string[]).includes(id) ? AGENT_CLI_CATALOG[id as AgentCliId] : undefined;
}

/**
 * How much of a CLI's own tool use ACS can see and govern. Shown to the operator, so it must never
 * overstate: only `acs_guarded` runs have a per-call ACS decision, and even those are a deny-list.
 */
export type AgentGovernance = "acs_guarded" | "os_sandboxed" | "host_permissions";
export const AGENT_GOVERNANCE: Readonly<Record<AgentCliId, { level: AgentGovernance; summary: string }>> = {
  claude: {
    level: "acs_guarded",
    summary:
      "ACS decides and audits every tool call through a PreToolUse hook (a deny-list, not a sandbox). Per-call decisions come from the gateway when ACS_AGENT_GUARD_URL is set; otherwise the hook enforces the same deny-list locally."
  },
  codex: {
    level: "os_sandboxed",
    summary:
      "Codex's own OS sandbox limits writes to the worktree. ACS cannot see or decide individual tool calls and does not audit them."
  },
  opencode: {
    level: "host_permissions",
    summary: "Runs with your host permissions under OpenCode's own rules. ACS cannot see or govern its tool calls."
  },
  antigravity: {
    level: "host_permissions",
    summary: "Runs with your host permissions under Antigravity's own rules. ACS cannot see or govern its tool calls."
  },
  hermes: {
    level: "host_permissions",
    summary: "Runs with your host permissions under Hermes' own approvals. ACS cannot see or govern its tool calls."
  },
  openclaw: {
    level: "host_permissions",
    summary: "Runs with your host permissions. ACS cannot see or govern its tool calls."
  },
  "cursor-agent": {
    level: "host_permissions",
    summary: "Runs with your host permissions under Cursor's own trust model. ACS cannot see or govern its tool calls."
  },
  goose: {
    level: "host_permissions",
    summary: "Runs with your host permissions under Goose's configured mode. ACS cannot see or govern its tool calls."
  },
  cline: {
    level: "host_permissions",
    summary: "Runs its own tools with your host permissions. ACS cannot see or govern its tool calls."
  }
};
