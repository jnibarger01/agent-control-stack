import { stripAnsi } from "./runner.js";

export const TEST_FAILURE_KINDS = ["usage_limit", "auth", "ineligible", "timeout", "cancelled", "no_reply", "error"] as const;
export type TestFailureKind = (typeof TEST_FAILURE_KINDS)[number];

export interface TestFailureSummary {
  kind: TestFailureKind;
  /** One readable sentence for the operator; never a stack frame, hook banner or half a URL. */
  summary: string;
}

export const TEST_SUMMARY_MAX_CHARS = 180;

const USAGE_LIMIT = /usage limit|quota|rate.?limit|too many requests|resource_exhausted|\b429\b/iu;
const AUTH =
  /\b401\b|unauthori[sz]ed|authentication|re-?authenticat|not (?:logged|signed) in|sign in|log ?in|invalid api key|api key/iu;
const INELIGIBLE = /ineligible|no longer supported|not eligible/iu;
const RESET_HINT = /\bresets?\b.*\b(?:at|in)\b|try again (?:at|in)/iu;
const ERRORISH = /\berror\b|\bfailed\b|exception|denied|refused/iu;
const STACK_FRAME = /^\s*at\s+\S/u;
const LEADING_LABEL = /^(?:ran into this error|error|fatal|failed|\[spawn error\])\s*:\s*/iu;

/** Keep the host, drop scheme/path/query, so a cut-off URL never ends a sentence. */
function hostOnly(text: string): string {
  return text
    .replace(/file:\/\/\S+/gu, "")
    .replace(/https?:\/\/([^\s/)]+)[^\s)]*?([.,;:]*)(?=\s|\)|$)/gu, "$1$2");
}

function tidy(line: string): string {
  let text = hostOnly(line).replace(/\s+/gu, " ").trim();
  // Strip nested "error: " prefixes ("ERROR: ..." after "Ran into this error: ...").
  for (let i = 0; i < 3 && LEADING_LABEL.test(text); i += 1) text = text.replace(LEADING_LABEL, "");
  return text.replace(/\s+([.,;:])/gu, "$1").trim();
}

export function truncateAtWord(text: string, max = TEST_SUMMARY_MAX_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/u, "")}…`;
}

function candidateLines(output: string): string[] {
  return stripAnsi(output)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !STACK_FRAME.test(line) && !/^AGY_ERROR:/u.test(line));
}

/**
 * Turn a failed connection test's raw output into a short, classified reason.
 * Providers bury the real cause among hook banners, stack frames and upgrade links, so the last few
 * lines are the wrong thing to show; this picks the line that explains the failure instead.
 */
export function summarizeTestFailure(output: string, outcome: string): TestFailureSummary {
  if (outcome === "timed_out") return { kind: "timeout", summary: "Timed out before the agent replied." };
  if (outcome === "cancelled") return { kind: "cancelled", summary: "The test was cancelled." };
  const lines = candidateLines(output);
  if (!lines.length) return { kind: "no_reply", summary: "The agent exited without printing anything." };

  const kinds: Array<[TestFailureKind, RegExp]> = [
    ["usage_limit", USAGE_LIMIT],
    ["ineligible", INELIGIBLE],
    ["auth", AUTH]
  ];
  for (const [kind, pattern] of kinds) {
    const index = lines.findIndex((line) => pattern.test(line));
    if (index === -1) continue;
    let summary = tidy(lines[index]!);
    // Providers often print the reset time on its own line ("Limit resets at 09:58 (in 1h 14m).").
    if (kind === "usage_limit" && !RESET_HINT.test(summary)) {
      const reset = lines.find((line, i) => i !== index && RESET_HINT.test(line));
      if (reset) summary = `${summary.replace(/[.\s]+$/u, "")}. ${tidy(reset)}`;
    }
    return { kind, summary: truncateAtWord(summary) };
  }
  const errorLine = [...lines].reverse().find((line) => ERRORISH.test(line)) ?? lines[lines.length - 1]!;
  return { kind: "error", summary: truncateAtWord(tidy(errorLine)) };
}

export const TEST_FAILURE_LABELS: Readonly<Record<TestFailureKind, string>> = {
  usage_limit: "usage limit",
  auth: "sign-in needed",
  ineligible: "account not eligible",
  timeout: "timed out",
  cancelled: "cancelled",
  no_reply: "no reply",
  error: "error"
};
