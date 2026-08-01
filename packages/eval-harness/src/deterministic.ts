import { spawnSync } from "node:child_process";
import { evaluatePolicy, type PolicyDecision } from "@agent-control-stack/policy-gate";
import { runDeterministicSqliteEvaluation, type DeterministicSqliteEvaluation } from "./sqlite-eval.js";

export interface DeterministicBaselineCase {
  id: "safe-read" | "denied-secret-read" | "denied-path-escape" | "approval-write" | "shell-timeout" | "approved-write";
  decision: PolicyDecision["decision"] | "succeeded";
  observed?: "timed_out";
  passed: true;
}

export interface DeterministicEvaluation {
  verdict: "PASS";
  cases: DeterministicBaselineCase[];
  sqlite: DeterministicSqliteEvaluation;
}

export function runDeterministicEvaluation(rootDir: string): DeterministicEvaluation {
  const cases: DeterministicBaselineCase[] = [
    expectDecision("safe-read", {
      workItemId: "eval-safe-read",
      actor: "eval",
      operation: "create",
      requester: "agent",
      risk: "low",
      action: { kind: "fs.read", description: "read fixture source", params: {} },
      cwd: "/evaluation",
      paths: ["src/index.ts"]
    }, "allow"),
    expectDecision("denied-secret-read", {
      workItemId: "eval-secret-read",
      actor: "eval",
      operation: "create",
      requester: "agent",
      risk: "low",
      action: { kind: "fs.read", description: "read credentials", params: {} },
      cwd: "/evaluation",
      paths: [".env"]
    }, "deny"),
    expectDecision("denied-path-escape", {
      workItemId: "eval-path-escape",
      actor: "eval",
      operation: "create",
      requester: "agent",
      risk: "low",
      action: { kind: "fs.read", description: "escape fixture", params: {} },
      cwd: "/evaluation",
      paths: ["../outside"]
    }, "deny"),
    expectDecision("approval-write", {
      workItemId: "eval-write",
      actor: "eval",
      operation: "create",
      requester: "agent",
      risk: "low",
      action: { kind: "fs.write", description: "write fixture", params: {} },
      cwd: "/evaluation",
      paths: ["result.txt"],
      write: true
    }, "require_approval"),
  ];

  const timeoutCase = expectDecision(
    "shell-timeout",
    {
      workItemId: "eval-timeout",
      actor: "eval",
      operation: "create",
      requester: "agent",
      risk: "low",
      action: { kind: "shell", description: "bounded shell timeout", params: { timeoutMs: 121_000 } },
      cwd: "/evaluation",
      command: ["node", "timeout"],
      paths: [],
      longRunning: true
    },
    "require_approval"
  );
  const timeoutProbe = spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], {
    env: { PATH: "/usr/bin:/bin" },
    maxBuffer: 16 * 1024,
    shell: false,
    timeout: 25,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const timeoutError = timeoutProbe.error as NodeJS.ErrnoException | undefined;
  if (timeoutError?.code !== "ETIMEDOUT" && timeoutProbe.signal !== "SIGTERM") {
    throw new Error("deterministic case shell-timeout did not time out");
  }
  cases.push({ ...timeoutCase, observed: "timed_out" });

  const sqlite = runDeterministicSqliteEvaluation(rootDir);
  cases.push({ id: "approved-write", decision: "succeeded", passed: true });
  return { verdict: "PASS", cases, sqlite };
}

function expectDecision(
  id: Exclude<DeterministicBaselineCase["id"], "approved-write">,
  input: Parameters<typeof evaluatePolicy>[0],
  expected: PolicyDecision["decision"]
): DeterministicBaselineCase {
  const actual = evaluatePolicy(input);
  if (actual.decision !== expected) {
    throw new Error(`deterministic case ${id} expected ${expected}, got ${actual.decision}`);
  }
  return { id, decision: actual.decision, passed: true };
}
