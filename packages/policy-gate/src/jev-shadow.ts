/**
 * Shadow-mode Jev advisory emission for mission intake (log-only).
 *
 * ADVISORY ONLY: the emitted telemetry NEVER alters classifier evidence,
 * risk ranking, policy decisions, approvals, or any deterministic check.
 * This module is wired fire-and-forget at the gateway MCP `create_work_item`
 * boundary (apps/gateway/src/mcp.ts) and writes telemetry lines to stderr.
 * When `ACS_JEV_ENABLED` is not `1` it is fully inert.
 */

import {
  classifyJev,
  buildJevTelemetryEvent,
  formatJevTelemetry,
  isJevEnabled,
  type ClassifyJevOptions
} from "@agent-control-stack/jev-advisor";
import { missionIntakeSchema } from "@agent-control-stack/work-items";

export const JEV_ROUTING_SIGNALS = [
  "actionable",
  "needs_code",
  "needs_shell",
  "needs_browser",
  "needs_mobile",
  "needs_desktop"
] as const;

export const JEV_RISK_SIGNALS = ["destructive", "auth_sensitive", "runtime_mutation", "approval_likely"] as const;

const SHADOW_SIGNAL_QUESTIONS: Record<string, string> = {
  actionable: "Does this request require an action rather than only conversation?",
  needs_code: "Does fulfilling this request require writing or modifying code?",
  needs_shell: "Does fulfilling this request require running shell commands?",
  needs_browser: "Does fulfilling this request require browser or web interaction?",
  needs_mobile: "Does fulfilling this request require a mobile device?",
  needs_desktop: "Does fulfilling this request require desktop or GUI automation?",
  destructive: "Would fulfilling this request be destructive or irreversible?",
  auth_sensitive: "Does this request involve credentials, secrets, or authentication material?",
  runtime_mutation: "Would fulfilling this request mutate runtime or system state?",
  approval_likely: "Is human approval likely required for this request?"
};

export type JevShadowOptions = ClassifyJevOptions & {
  /** Telemetry sink; defaults to a stderr line writer. */
  sink?: (line: string) => void;
};

function defaultSink(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function classifyShadowBatch(
  state: string,
  signals: readonly string[],
  options: JevShadowOptions
): Promise<Record<string, number>> {
  const questions: Record<string, string> = {};
  for (const signal of signals) questions[signal] = SHADOW_SIGNAL_QUESTIONS[signal];
  const result = await classifyJev(state, questions, options);
  const event = buildJevTelemetryEvent({ result, consumer: "mission-router" });
  (options.sink ?? defaultSink)(formatJevTelemetry(event));
  return event.signals;
}

/**
 * Run the two shadow batches (routing + risk) for a mission intake and emit
 * log-only telemetry. Never throws: Jev failures degrade inside the adapter.
 */
export async function runJevShadowAdvisory(state: string, options: JevShadowOptions = {}): Promise<void> {
  const classifyOptions: JevShadowOptions = { ...options, sink: options.sink ?? defaultSink };
  await classifyShadowBatch(state, JEV_ROUTING_SIGNALS, classifyOptions);
  await classifyShadowBatch(state, JEV_RISK_SIGNALS, classifyOptions);
}

/**
 * Gateway boundary helper: when `ACS_JEV_ENABLED=1` and the input is a valid
 * mission intake, emit shadow advisory telemetry for its goal text. Fully
 * inert (no network call) when the feature gate is off; no-ops on invalid
 * intake shapes. Never throws.
 */
export async function maybeRunJevShadowAdvisory(intakeInput: unknown, options: JevShadowOptions = {}): Promise<void> {
  try {
    // Explicit opt-out via options must always win, even when the env gate is on.
    if (options.enabled === false) return;
    const explicitlyEnabled = options.enabled === true;
    if (!explicitlyEnabled && !isJevEnabled()) return;
    const parsed = missionIntakeSchema.safeParse(intakeInput);
    if (!parsed.success) return;
    await runJevShadowAdvisory(parsed.data.goal, options);
  } catch {
    // Shadow telemetry must never break the request path.
  }
}
