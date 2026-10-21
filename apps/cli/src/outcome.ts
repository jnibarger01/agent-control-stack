import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { createGhPullRequestReader, createGhRunner } from "@agent-control-stack/integration-manager";
import {
  OutcomeEngine,
  createOutcomeStorePort,
  createReadOnlyGhRunner,
  type AcceptedRecord,
  type EvaluationView,
  type LoadedOutcome
} from "@agent-control-stack/outcome-engine";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import type { AcsCommand } from "./parse.js";

type OutcomeCommand = Extract<AcsCommand, { kind: `outcome-${string}` }>;

/** The CLI's whole view of the engine, so dispatch tests can inject a fake. */
export interface OutcomeCliPort {
  accept(command: Extract<AcsCommand, { kind: "outcome-accept" }>): { record: AcceptedRecord; created: boolean };
  evaluate(outcomeId: string): Promise<EvaluationView>;
  show(outcomeId: string): (LoadedOutcome & { latestStale: boolean }) | undefined;
  list(): ReturnType<OutcomeEngine["list"]>;
}

/**
 * Exit codes. A PASS is evidence about one head commit and must never read as plain success to a shell, because
 * `acs outcome evaluate ... && gh pr merge` would turn evidence into authority.
 */
export const OUTCOME_EXIT = { PASS: 10, PARTIAL: 11, BLOCK: 12, FAIL: 13, STALE: 14 } as const;

export function exitForVerdict(verdict: keyof typeof OUTCOME_EXIT): number {
  return OUTCOME_EXIT[verdict];
}

function openEngine(): { engine: OutcomeEngine; close: () => void } {
  const token = process.env.ACS_OUTCOME_GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "ACS_OUTCOME_GITHUB_TOKEN is required: a dedicated read-only GitHub token (ambient GH_TOKEN is never used)"
    );
  }
  if (token === process.env.GH_TOKEN || token === process.env.GITHUB_TOKEN) {
    throw new Error(
      "ACS_OUTCOME_GITHUB_TOKEN must not equal GH_TOKEN or GITHUB_TOKEN; use a dedicated read-only token"
    );
  }
  const acsRepository = process.env.ACS_OUTCOME_ACS_REPOSITORY ?? "jnibarger01/agent-control-stack";
  const store = new SqliteWorkItemStore(process.env.ACS_DB_PATH ?? "storage/local.db");
  const engine = new OutcomeEngine({
    store: createOutcomeStorePort(store),
    // The only place that asserts "live_github": this is the real gh reader behind the read-only argv guard.
    readerFor: (repository) => createGhPullRequestReader(repository, createReadOnlyGhRunner(createGhRunner({ token }))),
    provenance: "live_github",
    acsRepository
  });
  return { engine, close: () => store.close() };
}

export function createDefaultOutcomePort(): OutcomeCliPort {
  const using = <T>(run: (engine: OutcomeEngine) => T): T => {
    const { engine, close } = openEngine();
    try {
      return run(engine);
    } finally {
      close();
    }
  };
  return {
    accept: (command) =>
      using((engine) => {
        const criteria = command.criteriaFile
          ? (JSON.parse(readFileSync(command.criteriaFile, "utf8")) as unknown[])
          : undefined;
        return engine.accept(
          {
            goal: command.goal,
            repository: command.repository,
            pullRequest: command.pullRequest,
            ...(criteria ? { criteria } : {}),
            ...(command.expiresAt ? { expiresAt: command.expiresAt } : {}),
            ...(command.maxEvaluations !== undefined ? { maxEvaluations: command.maxEvaluations } : {})
          },
          { osUser: userInfo().username }
        );
      }),
    evaluate: async (outcomeId) => {
      const { engine, close } = openEngine();
      try {
        return await engine.evaluate(outcomeId);
      } finally {
        close();
      }
    },
    show: (outcomeId) => using((engine) => engine.show(outcomeId)),
    list: () => using((engine) => engine.list())
  };
}

function renderEvaluation(view: EvaluationView): string {
  const { record } = view;
  const lines = [
    `${record.verdict}${record.blockKind ? ` (${record.blockKind})` : ""}  outcome=${record.outcomeId}  evaluation=${record.evaluationId}${view.recorded ? "" : view.deduped ? "  (unchanged, not re-recorded)" : "  (not recorded)"}`,
    `head=${record.headSha ?? "unknown"} base=${record.baseRefOid ?? "unknown"} provenance=${record.readerProvenance}`,
    `criteria: ${record.criteriaSummary.requiredSatisfied} satisfied, ${record.criteriaSummary.requiredUnsatisfied} unsatisfied, ${record.criteriaSummary.requiredUndecided} undecided`
  ];
  if (record.reasonCodes.length > 0) lines.push(`reasons: ${record.reasonCodes.join(", ")}`);
  for (const finding of record.findings.slice(0, 20)) lines.push(`  - ${finding}`);
  lines.push(`merge exposure: ${record.humanControl.exposure} (${record.humanControl.note})`);
  for (const action of record.nextActions)
    lines.push(`next: ${action.action}${action.requiresHuman ? " [human]" : ""}: ${action.detail}`);
  if (record.verdict === "PASS") {
    lines.push("PASS is evidence about this head commit only. It is not merge approval and nothing has been merged.");
  }
  return `${lines.join("\n")}\n`;
}

export async function runOutcomeCommand(
  command: OutcomeCommand,
  io: { stdout: { write(chunk: string): void } },
  port: OutcomeCliPort
): Promise<number> {
  switch (command.kind) {
    case "outcome-accept": {
      const { record, created } = port.accept(command);
      io.stdout.write(
        command.json
          ? `${JSON.stringify({ outcomeId: record.outcomeId, created, authority: record.authority })}\n`
          : `${created ? "accepted" : "already accepted"} ${record.outcomeId} (${record.repository}#${record.pullRequest}); authority=${record.authority.kind} (local, unauthenticated)\n`
      );
      return 0;
    }
    case "outcome-evaluate": {
      const view = await port.evaluate(command.outcomeId);
      io.stdout.write(command.json ? `${JSON.stringify(view)}\n` : renderEvaluation(view));
      return exitForVerdict(view.record.verdict);
    }
    case "outcome-show": {
      const loaded = port.show(command.outcomeId);
      if (!loaded) {
        io.stdout.write(`no accepted outcome ${command.outcomeId}\n`);
        return 1;
      }
      const latest = loaded.evaluations[loaded.evaluations.length - 1];
      if (command.json) {
        io.stdout.write(`${JSON.stringify(loaded)}\n`);
      } else {
        io.stdout.write(
          `${loaded.accepted.outcomeId}  ${loaded.accepted.repository}#${loaded.accepted.pullRequest}  evaluations=${loaded.evaluations.length}  latest=${latest ? `${latest.verdict}${loaded.latestStale ? " (STALE: re-evaluate)" : ""}` : "none"}  problems=${loaded.problems.length}\n`
        );
        for (const problem of loaded.problems) io.stdout.write(`  integrity: ${problem}\n`);
      }
      if (loaded.problems.length > 0) return 1;
      if (!latest) return 0;
      return loaded.latestStale ? OUTCOME_EXIT.STALE : exitForVerdict(latest.verdict);
    }
    case "outcome-list": {
      const rows = port.list();
      io.stdout.write(
        command.json
          ? `${JSON.stringify(rows)}\n`
          : rows.length === 0
            ? "No outcomes.\n"
            : `${rows.map((row) => `${row.outcomeId}\t${row.repository}#${row.pullRequest}\tevaluations=${row.evaluations}\tlatest=${row.latestVerdict ?? "none"}\tproblems=${row.problems}`).join("\n")}\n`
      );
      return 0;
    }
  }
}
