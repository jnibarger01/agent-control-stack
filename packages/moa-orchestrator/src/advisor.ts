import type { AdvisorConfig } from "./config.js";
import type { ModelCaller, Redactor } from "./ports.js";
import { AdvisorOutputSchema, type AdvisorOutput, type TaskEnvelope } from "./types.js";
import { parseJsonBlock, sha256, withTimeout } from "./util.js";

export const ADVISOR_SYSTEM_PROMPT = `You are a reference advisor in a multi-agent review process.

You are NOT the acting agent.
You cannot call tools, run commands, browse, edit files, create work items, talk to workers, or execute anything.
Return ONLY a single JSON object.`;

export interface BoundedContext {
  text: string;
  sha256: string;
  truncated: boolean;
}

export function buildBoundedContext(task: TaskEnvelope, redactor: Redactor, maxChars = 24_000): BoundedContext {
  const parts = [
    `GOAL: ${task.goal}`,
    `KIND: ${task.kind}`,
    `DECLARED RISK (advisory): ${task.risk}`,
    task.context.repo ? `REPO: ${task.context.repo}${task.context.branch ? ` @ ${task.context.branch}` : ""}` : "",
    task.context.files.length ? `FILES IN SCOPE:\n${task.context.files.join("\n")}` : "",
    ...task.context.snippets.map((snippet) => `--- SNIPPET ${snippet.path} ---\n${snippet.content}`)
  ].filter(Boolean);
  let text = redactor.redact(parts.join("\n\n"));
  let truncated = false;
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n[TRUNCATED at ${maxChars} chars]`;
    truncated = true;
  }
  return { text, sha256: sha256(text), truncated };
}

export type AdvisorRun =
  | { ok: true; advisor_id: string; output: AdvisorOutput; input_sha256: string; output_sha256: string }
  | { ok: false; advisor_id: string; reason: string };

export async function runAdvisor(
  deps: { caller: ModelCaller },
  advisor: AdvisorConfig,
  task: TaskEnvelope,
  context: BoundedContext,
  timeoutMs: number
): Promise<AdvisorRun> {
  const user = `TASK ${task.task_id}\n\n${context.text}\n\nAdvise the aggregator. JSON only.`;
  try {
    const raw = await withTimeout(
      (signal) =>
        deps.caller.complete({
          model: advisor.model,
          system: ADVISOR_SYSTEM_PROMPT,
          user,
          maxTokens: Math.min(advisor.max_tokens, task.constraints.max_advisor_tokens),
          timeoutMs,
          signal
        }),
      timeoutMs,
      `advisor ${advisor.id}`
    );
    const output = AdvisorOutputSchema.parse({ ...(parseJsonBlock(raw) as Record<string, unknown>), advisor_id: advisor.id });
    return {
      ok: true,
      advisor_id: advisor.id,
      output,
      input_sha256: context.sha256,
      output_sha256: sha256(JSON.stringify(output))
    };
  } catch (error) {
    return { ok: false, advisor_id: advisor.id, reason: error instanceof Error ? error.message : String(error) };
  }
}
