import { ControlStackError } from "@agent-control-stack/shared";
import { WebMcpError, WebMcpErrorCode, type WebMcpAnnotations, type WebMcpRiskClass } from "./contracts.js";

/**
 * ACS-owned WebMCP policy.
 *
 * There is deliberately **no caller-supplied policy callback**. The adapter
 * never asks a caller "may I do this?" the way the discarded draft did: the
 * policy is a frozen, validated ACS configuration table, and the decision is
 * derived from it plus an ACS-owned escalation floor. A page's own annotations
 * may only make a tool *more* dangerous, never less.
 */

export interface WebMcpToolPolicyEntry {
  /** Bare serialized origin, matched exactly. */
  readonly origin: string;
  readonly toolName: string;
  /** ACS-declared risk. Never derived from page annotations. */
  readonly risk: WebMcpRiskClass;
  /** ACS-declared override. `reversible_mutation` always requires approval regardless. */
  readonly requiresApproval?: boolean;
}

export interface ResolvedWebMcpToolPolicy {
  readonly origin: string;
  readonly toolName: string;
  readonly risk: WebMcpRiskClass;
  readonly requiresApproval: boolean;
  /** Why the effective class is stricter than the declared one, when it is. */
  readonly escalatedBy?: "annotation_consequential" | "annotation_not_read_only" | "annotation_untrusted_content" | "annotation_unknown";
}

export interface WebMcpPolicyTable {
  readonly entries: readonly ResolvedWebMcpToolPolicy[];
  resolve(origin: string, toolName: string): ResolvedWebMcpToolPolicy | undefined;
  /** Every declared tool for an origin, for gateway-side decision support. */
  listForOrigin(origin: string): readonly ResolvedWebMcpToolPolicy[];
}

function policyKey(origin: string, toolName: string): string {
  return `${origin}\n${toolName}`;
}

/**
 * The escalation floor. Annotations are page-controlled, so they can only
 * increase the effective risk. Absent (`null`) annotations mean "unknown", and
 * unknown is not safe: a read-only declaration is not honoured when the page
 * supplied nothing to corroborate it.
 */
export function escalateRisk(
  declared: WebMcpRiskClass,
  annotations: WebMcpAnnotations | null
): ResolvedWebMcpToolPolicy["escalatedBy"] | undefined {
  if (declared === "reversible_mutation") return undefined;
  if (annotations === null) return "annotation_unknown";
  if (annotations.consequentialHint) return "annotation_consequential";
  if (!annotations.readOnlyHint) return "annotation_not_read_only";
  if (annotations.untrustedContentHint) return "annotation_untrusted_content";
  return undefined;
}

export function defineWebMcpPolicy(entries: readonly WebMcpToolPolicyEntry[]): WebMcpPolicyTable {
  const seen = new Map<string, ResolvedWebMcpToolPolicy>();
  for (const entry of entries) {
    if (!entry.origin || !entry.toolName) {
      throw new ControlStackError("webmcp_policy_invalid", "policy entries require an origin and a tool name");
    }
    const key = policyKey(entry.origin, entry.toolName);
    if (seen.has(key)) {
      throw new ControlStackError("webmcp_policy_invalid", `duplicate policy entry for ${entry.toolName}`);
    }
    if (entry.requiresApproval === true && entry.risk !== "reversible_mutation") {
      throw new ControlStackError(
        "webmcp_policy_invalid",
        `policy entry ${entry.toolName} sets requiresApproval on a read-only tool`
      );
    }
    seen.set(key, {
      origin: entry.origin,
      toolName: entry.toolName,
      risk: entry.risk,
      requiresApproval: entry.risk === "reversible_mutation"
    });
  }

  const frozen = Object.freeze([...seen.values()]);
  return Object.freeze({
    entries: frozen,
    resolve(origin: string, toolName: string): ResolvedWebMcpToolPolicy | undefined {
      const base = seen.get(policyKey(origin, toolName));
      if (!base) return undefined;
      return base;
    },
    listForOrigin(origin: string): readonly ResolvedWebMcpToolPolicy[] {
      return frozen.filter((entry) => entry.origin === origin);
    }
  });
}

/**
 * Decide the effective policy for a *discovered* tool. Unknown tools are
 * denied (no implicit allow), and annotations may only escalate.
 */
export function resolveEffectivePolicy(
  table: WebMcpPolicyTable,
  input: { origin: string; toolName: string; annotations: WebMcpAnnotations | null }
): ResolvedWebMcpToolPolicy {
  const declared = table.resolve(input.origin, input.toolName);
  if (!declared) {
    throw new WebMcpError(
      WebMcpErrorCode.ToolDenied,
      `tool ${input.toolName} is not declared in ACS policy for ${input.origin}`
    );
  }
  const escalatedBy = escalateRisk(declared.risk, input.annotations);
  if (!escalatedBy) return declared;
  return {
    origin: declared.origin,
    toolName: declared.toolName,
    risk: "reversible_mutation",
    requiresApproval: true,
    escalatedBy
  };
}
