import { evaluateGate } from "./gate.js";
import { analyzeDependencies, findOverlaps } from "./graph.js";
import type { GitRunner } from "./git-simulator.js";
import { MergeSimulator } from "./git-simulator.js";
import {
  DEFAULT_GATE_POLICY,
  INTEGRATION_REPORT_SCHEMA_VERSION,
  type GatePolicy,
  type MergeMethod,
  type IntegrationReport,
  type MergeSimulation,
  type PullRequestAssessment,
  type PullRequestSource
} from "./types.js";

export interface ReconcileInput {
  /** owner/name, recorded in the report. */
  repository: string;
  /** The integration target, for example `main`. */
  baseRef: string;
  source: PullRequestSource;
  /** A runner inside a disposable clone that already contains the base and every pull request head. */
  git: GitRunner;
  /**
   * How the repository will land a pull request (see `selectMergeMethod`). Required: the simulated history differs per
   * method, and guessing would let a stacked change look clean when the real merge conflicts.
   */
  mergeMethod: MergeMethod;
  policy?: GatePolicy;
  now?: () => Date;
}

const NOT_EVALUATED: MergeSimulation = { evaluated: false, clean: false, conflicts: [], behindBy: 0 };

/**
 * Reconcile open pull requests against the integration target: gate verdicts, dependency order, standalone merge
 * simulation, and a queue simulation that revalidates each pull request after the ones ahead of it have merged.
 *
 * `merge` is simulated with a two-parent commit; `squash` with a single-parent commit, because a squash does not record the
 * pull request's history, so a stacked child still sees its parent's changes as its own. `rebase` replays each commit and
 * is not modeled: every otherwise-eligible pull request is reported not mergeable rather than guessed at.
 *
 * Invariants: `wouldMerge` is true only when the pull request's gate verdict is `eligible`, every pull request it depends
 * on is also queued, and its merge simulates cleanly after the queue ahead of it. Anything the engine could not evaluate
 * (a head missing from the clone, an unreadable base) is reported as not mergeable. Nothing is merged, pushed or
 * mutated outside the disposable clone's object database.
 */
export async function reconcile(input: ReconcileInput): Promise<IntegrationReport> {
  const policy = input.policy ?? DEFAULT_GATE_POLICY;
  const simulator = new MergeSimulator(input.git);
  const baseSha = await simulator.resolveCommit(`refs/heads/${input.baseRef}`);
  if (!baseSha) throw new Error(`integration target ${input.baseRef} is not present in the isolated clone`);

  const prs = (await input.source.listOpenPullRequests()).slice().sort((a, b) => a.number - b.number);
  const analysis = analyzeDependencies(prs, input.baseRef);
  const overlaps = findOverlaps(prs);
  const warnings: string[] = [];

  const gates = new Map(prs.map((pr) => [pr.number, evaluateGate(pr, policy)]));
  const standalone = new Map<number, MergeSimulation>();
  for (const pr of prs) {
    standalone.set(
      pr.number,
      analysis.detached.has(pr.number) || analysis.cyclic.has(pr.number)
        ? NOT_EVALUATED
        : await simulator.simulate(baseSha, pr.headSha)
    );
  }

  // Walk the dependency order, merging virtually. A pull request is queued only if everything it depends on was queued.
  const queued = new Set<number>();
  const afterUpstream = new Map<number, MergeSimulation>();
  const notQueuedBecause = new Map<number, string>();
  let tip = baseSha;
  for (const number of analysis.order) {
    const pr = prs.find((candidate) => candidate.number === number)!;
    const gate = gates.get(number)!;
    if (gate.status !== "eligible") {
      notQueuedBecause.set(number, `gate ${gate.status}`);
      continue;
    }
    if (input.mergeMethod === "rebase") {
      notQueuedBecause.set(number, "merge_method_not_modeled: the repository lands pull requests by rebase");
      continue;
    }
    const missing = (analysis.dependsOn.get(number) ?? []).filter((dependency) => !queued.has(dependency));
    if (missing.length > 0) {
      notQueuedBecause.set(number, `depends on ${missing.map((n) => `#${n}`).join(", ")}, which cannot merge first`);
      continue;
    }
    const simulation = await simulator.simulate(tip, pr.headSha);
    afterUpstream.set(number, simulation);
    if (!simulation.evaluated) {
      notQueuedBecause.set(number, `merge could not be evaluated${simulation.detail ? `: ${simulation.detail}` : ""}`);
      continue;
    }
    if (!simulation.clean) {
      const ahead = [...queued].map((n) => `#${n}`).join(", ");
      const alone = standalone.get(number)!;
      notQueuedBecause.set(
        number,
        alone.clean
          ? `conflicts once ${ahead || "the queue"} merge${queued.size === 1 ? "s" : ""}: ${simulation.conflicts.join(", ")}`
          : `conflicts with ${input.baseRef}: ${simulation.conflicts.join(", ")}`
      );
      continue;
    }
    // A merge commit records the pull request's history; a squash does not, and neither is true of the other.
    const merged = await simulator.syntheticMerge(
      simulation.tree!,
      input.mergeMethod === "merge" ? [tip, pr.headSha] : [tip]
    );
    if (!merged) {
      notQueuedBecause.set(number, "could not build the simulated merge");
      continue;
    }
    tip = merged;
    queued.add(number);
  }

  const queue = analysis.order.filter((number) => queued.has(number));
  const assessments: PullRequestAssessment[] = prs.map((pr) => {
    const gate = gates.get(pr.number)!;
    const alone = standalone.get(pr.number)!;
    const reasons: string[] = [];
    for (const blocker of gate.blockers) reasons.push(`${blocker.code}: ${blocker.detail}`);
    for (const waiting of gate.pending) reasons.push(`pending ${waiting.code}: ${waiting.detail}`);
    if (analysis.cyclic.has(pr.number)) reasons.push("dependency_cycle: stacked pull requests depend on each other");
    if (analysis.blockedByCycle.has(pr.number)) {
      const via = (analysis.dependsOn.get(pr.number) ?? []).map((n) => `#${n}`).join(", ");
      reasons.push(`blocked_by_cycle: depends on ${via}, which cannot merge until a dependency cycle is broken`);
    }
    if (analysis.detached.has(pr.number)) {
      reasons.push(`detached_base: base ${pr.baseRef} is neither ${input.baseRef} nor an open pull request's head`);
    }
    const why = notQueuedBecause.get(pr.number);
    if (why && gate.status === "eligible") reasons.push(why);
    if (!alone.evaluated && !analysis.detached.has(pr.number) && !analysis.cyclic.has(pr.number)) {
      reasons.push(`not evaluated: ${alone.detail ?? "unknown"}`);
    }
    if (alone.evaluated && alone.behindBy > 0)
      reasons.push(`stale_base: behind ${input.baseRef} by ${alone.behindBy} commit(s)`);
    const wouldMerge = queued.has(pr.number) && gate.status === "eligible";
    return {
      number: pr.number,
      title: pr.title,
      headSha: pr.headSha,
      baseRef: pr.baseRef,
      gate,
      dependsOn: analysis.dependsOn.get(pr.number) ?? [],
      standalone: alone,
      ...(afterUpstream.has(pr.number) ? { afterUpstream: afterUpstream.get(pr.number)! } : {}),
      overlaps: overlaps.get(pr.number) ?? [],
      ...(queued.has(pr.number) ? { queuePosition: queue.indexOf(pr.number) + 1 } : {}),
      wouldMerge,
      reasons
    };
  });

  return {
    schemaVersion: INTEGRATION_REPORT_SCHEMA_VERSION,
    repository: input.repository,
    baseRef: input.baseRef,
    baseSha,
    mergeMethod: input.mergeMethod,
    generatedAt: (input.now ?? (() => new Date()))().toISOString(),
    queue,
    pullRequests: assessments,
    warnings,
    merged: false
  };
}
