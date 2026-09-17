/**
 * Per-identity MCP tool allowlist (issue #112).
 *
 * Config maps authenticated MCP identity (connectorId ?? subject) → allowed tool names.
 * When no allowlist is configured, every identity may call any tool (feature off).
 * When configured:
 * - Listed identity: only tools on its list.
 * - Unknown identity: denied in production mode; allowed in local mode (permissive default).
 */

export type McpToolAllowlistMode = "production" | "local";

export interface McpToolAllowlistConfig {
  /** identity → allowed tool names. Empty means feature off. */
  entries: ReadonlyMap<string, ReadonlySet<string>>;
  /** When true, identities absent from `entries` are denied. */
  defaultDenyUnknown: boolean;
  mode: McpToolAllowlistMode;
}

export type McpToolAllowlistDecision = { allowed: true } | { allowed: false; reason: string };

export function resolveMcpToolAllowlistMode(
  env: NodeJS.ProcessEnv = process.env,
  override?: McpToolAllowlistMode
): McpToolAllowlistMode {
  if (override) return override;
  return env.NODE_ENV === "production" ? "production" : "local";
}

export function parseMcpToolAllowlistJson(raw: string | undefined): Record<string, string[]> | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("ACS_MCP_TOOL_ALLOWLIST_JSON must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ACS_MCP_TOOL_ALLOWLIST_JSON must be a JSON object of identity → tool name arrays");
  }
  const result: Record<string, string[]> = {};
  for (const [identity, tools] of Object.entries(parsed as Record<string, unknown>)) {
    if (!identity.trim()) {
      throw new Error("ACS_MCP_TOOL_ALLOWLIST_JSON identities must be non-empty strings");
    }
    if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string" || !tool.trim())) {
      throw new Error(
        `ACS_MCP_TOOL_ALLOWLIST_JSON[${JSON.stringify(identity)}] must be an array of non-empty tool names`
      );
    }
    result[identity] = tools.map((tool) => tool.trim());
  }
  return result;
}

export function resolveMcpToolAllowlist(input: {
  allowlist?: Record<string, readonly string[]>;
  env?: NodeJS.ProcessEnv;
  mode?: McpToolAllowlistMode;
}): McpToolAllowlistConfig {
  const env = input.env ?? process.env;
  const mode = resolveMcpToolAllowlistMode(env, input.mode);
  const raw = input.allowlist ?? parseMcpToolAllowlistJson(env.ACS_MCP_TOOL_ALLOWLIST_JSON) ?? undefined;
  const entries = new Map<string, ReadonlySet<string>>();
  if (raw) {
    for (const [identity, tools] of Object.entries(raw)) {
      entries.set(identity, new Set(tools));
    }
  }
  return {
    entries,
    // Production always default-denies unknowns once an allowlist is active.
    // Local keeps the permissive default for identities not listed.
    defaultDenyUnknown: mode === "production",
    mode
  };
}

export function evaluateMcpToolAllowlist(
  config: McpToolAllowlistConfig,
  identity: string,
  toolName: string
): McpToolAllowlistDecision {
  if (config.entries.size === 0) {
    return { allowed: true };
  }
  const allowedTools = config.entries.get(identity);
  if (!allowedTools) {
    if (config.defaultDenyUnknown) {
      return {
        allowed: false,
        reason: `MCP identity not in tool allowlist: ${identity}`
      };
    }
    return { allowed: true };
  }
  if (!allowedTools.has(toolName)) {
    return {
      allowed: false,
      reason: `MCP tool not allowed for identity ${identity}: ${toolName}`
    };
  }
  return { allowed: true };
}

export function isMcpToolAllowed(config: McpToolAllowlistConfig, identity: string, toolName: string): boolean {
  return evaluateMcpToolAllowlist(config, identity, toolName).allowed;
}
