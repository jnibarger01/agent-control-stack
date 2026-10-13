import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import { parseWorkUnitPayload } from "./mission-model.js";

/**
 * The execution contract of a `tool` work unit on the Desktop Commander lane: one named tool, its complete arguments, a hash
 * binding the two, and the unit's own runtime bound. The generic payload parser keeps the contract fields optional so
 * legacy tool payloads keep parsing; the strict parser below is what the lane adapter uses.
 */
export interface DcToolCall {
  toolName: string;
  arguments: Record<string, unknown>;
  /** `dcArgumentsHash(toolName, arguments)`. A mismatch means the arguments are not the ones that were admitted. */
  argsHash: string;
  maxRuntimeMs: number;
}

/** Binds the arguments to the tool they were written for, so they cannot be replayed under another tool name. */
export function dcArgumentsHash(toolName: string, args: Record<string, unknown>): string {
  return stableHash({ domain: "acs.work-unit.dc-tool-call.v1", toolName, arguments: args });
}

function invalid(reason: string): never {
  throw new ControlStackError("dc_tool_call_invalid", `dc tool call ${reason}`);
}

export function parseDcToolCall(payload: unknown): DcToolCall {
  if (!payload || typeof payload !== "object" || (payload as { kind?: unknown }).kind !== "tool") {
    return invalid("requires a tool payload");
  }
  let parsed: ReturnType<typeof parseWorkUnitPayload>;
  try {
    parsed = parseWorkUnitPayload("tool", payload);
  } catch {
    return invalid("has an invalid payload");
  }
  if (parsed.kind !== "tool") return invalid("requires a tool payload");
  const { toolName, arguments: args, argsHash, maxRuntimeMs } = parsed;
  if (args === undefined) return invalid("requires arguments");
  if (argsHash === undefined) return invalid("requires argsHash");
  if (argsHash !== dcArgumentsHash(toolName, args)) return invalid("argsHash does not match the arguments");
  if (maxRuntimeMs === undefined) return invalid("requires maxRuntimeMs");
  return { toolName, arguments: args, argsHash, maxRuntimeMs };
}
