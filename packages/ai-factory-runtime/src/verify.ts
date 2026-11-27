import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createFactoryProposal } from "@agent-control-stack/ai-factory";
import type { CodingMissionStore } from "@agent-control-stack/coding-mission";
import type { ExecutionEnvelope, SwarmExecutionEvidence } from "@agent-control-stack/engine-adapter";
import { outOfScope } from "./scope.js";

/**
 * F7: result validation and an independent verifier.
 *
 * Swarm evidence is untrusted input. ACS re-derives everything that matters from the repository
 * itself: the integrated commit and tree, its ancestry from the admitted base, the exact changed-file
 * list, and the diff bytes (whose hash must match the evidence bundle). ACS re-runs the acceptance
 * commands itself (production: through its sandboxed command broker), refuses a run with no tests,
 * and requires a verdict from a verifier that is not Codex Swarm. Only then is the unit completed.
 * Swarm's own PASS never satisfies a criterion.
 */
export type FactoryVerifyStore = Pick<CodingMissionStore, "workUnitClaim" | "completeOperation" | "failUnit" | "verificationRequirement">;

/** Read-only repository view. Every method must be side-effect free. */
export interface FactoryGitReader {
  /** Resolve a ref or commit to a full commit SHA, or undefined. */
  commit(ref: string): Promise<string | undefined>;
  tree(commit: string): Promise<string | undefined>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  changedFiles(base: string, head: string): Promise<string[]>;
  diff(base: string, head: string): Promise<Buffer>;
}

export interface FactoryCommandRunner {
  run(argv: readonly string[]): Promise<{ exitCode: number | null; output: string }>;
}

export interface FactoryIndependentVerifier {
  /** Stable identity of the verifier. Must not be Codex Swarm or derived from it. */
  readonly id: string;
  verify(input: {
    criteria: readonly { id: string; description: string; expected: string }[];
    files: readonly string[];
    diff: string;
    acceptance: readonly { command: string; exitCode: number | null }[];
  }): Promise<{ verdict: "PASS" | "FAIL" | "INCONCLUSIVE"; summary: string }>;
}

export type FactoryVerifyResult =
  | { status: "verified"; resultHash: string; files: string[]; verifierId: string }
  | { status: "rejected"; reason: string }
  /** Nothing was changed: the claim moved on, or the workspace moved under us. */
  | { status: "stale"; reason: string };

export async function verifyFactoryResult(
  deps: {
    store: FactoryVerifyStore;
    git: FactoryGitReader;
    runner: FactoryCommandRunner;
    verifier: FactoryIndependentVerifier;
    now?: () => Date;
  },
  input: {
    missionId: string;
    unitId: string;
    claimToken: string;
    intent: unknown;
    unitPaths: readonly string[];
    acceptanceCommands: readonly (readonly string[])[];
    envelope: ExecutionEnvelope;
    evidence: SwarmExecutionEvidence;
  }
): Promise<FactoryVerifyResult> {
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  const claimCurrent = () => {
    const claim = deps.store.workUnitClaim(input.missionId, input.unitId);
    return claim?.claimToken === input.claimToken && claim.status === "running";
  };
  if (!claimCurrent()) return { status: "stale", reason: "claim_not_current" };
  const reject = (reason: string): FactoryVerifyResult => {
    if (claimCurrent()) {
      deps.store.failUnit(input.missionId, input.unitId, input.claimToken, {
        category: "verification_failure",
        retryable: false,
        now: now()
      });
    }
    return { status: "rejected", reason };
  };

  let forbidden: readonly string[];
  try {
    forbidden = createFactoryProposal(input.intent).intent.forbiddenPaths;
  } catch {
    return reject("intent_invalid");
  }
  const requirement = deps.store.verificationRequirement(input.missionId, input.unitId);
  if (!requirement) return reject("verification_requirement_missing");

  // Exact echo, again: verification is bound to the envelope ACS issued for this claim.
  const { evidence, envelope } = input;
  if (
    evidence.acsAttemptId !== envelope.acsAttemptId ||
    evidence.envelopeHash !== envelope.envelopeHash ||
    evidence.leaseId !== envelope.leaseId ||
    evidence.fencingEpoch !== envelope.fencingEpoch
  ) {
    return reject("evidence_echo_mismatch");
  }
  if (!evidence.integration) return reject("no_integration");
  const base = envelope.workspace.expectedBaseSha;
  const head = evidence.integration.integratedHeadSha;

  // Re-derive the source tree from git, never from the report.
  const resolvedHead = await deps.git.commit(head + "^{commit}");
  if (!resolvedHead || resolvedHead !== head) return reject("integrated_commit_missing");
  const tree = await deps.git.tree(head);
  if (!tree || tree !== evidence.integration.integratedTreeSha) return reject("tree_mismatch");
  if (!(await deps.git.isAncestor(base, head))) return reject("base_not_ancestor");
  // The snapshot under verification must still be the workspace head.
  if ((await deps.git.commit("HEAD")) !== head) return { status: "stale", reason: "snapshot_stale" };

  const files = [...new Set(await deps.git.changedFiles(base, head))].sort();
  const reported = [...new Set(evidence.laneResults.flatMap((lane) => lane.filesChanged))].sort();
  if (JSON.stringify(files) !== JSON.stringify(reported)) return reject("reported_files_mismatch");
  if (outOfScope(files, input.unitPaths, forbidden).length > 0) return reject("out_of_scope_files");
  const diff = await deps.git.diff(base, head);
  if (createHash("sha256").update(diff).digest("hex") !== evidence.evidenceBundle.diffHash) return reject("diff_hash_mismatch");

  // ACS re-runs acceptance itself. No commands means nothing was tested: blocked, not passed.
  if (input.acceptanceCommands.length === 0) return reject("zero_test_result");
  const acceptance: { command: string; exitCode: number | null }[] = [];
  for (const argv of input.acceptanceCommands) {
    const result = await deps.runner.run(argv);
    acceptance.push({ command: argv.join(" "), exitCode: result.exitCode });
    if (result.exitCode !== 0) return reject("acceptance_failed");
  }

  if (/swarm/iu.test(deps.verifier.id)) return reject("verifier_not_independent");
  const verdict = await deps.verifier.verify({
    criteria: requirement.criteria,
    files,
    diff: diff.toString("utf8").slice(0, 2_000_000),
    acceptance
  });
  if (verdict.verdict !== "PASS") {
    return reject(evidence.aggregateVerdict === "PASS" ? "verifier_divergent" : "verifier_rejected");
  }
  // Last fence and snapshot check before the only accepting write.
  if (!claimCurrent()) return { status: "stale", reason: "claim_not_current" };
  if ((await deps.git.commit("HEAD")) !== head) return { status: "stale", reason: "snapshot_stale" };
  const resultHash = createHash("sha256")
    .update(
      JSON.stringify({
        domain: "acs:ai-factory-verified-result:v1",
        envelopeHash: envelope.envelopeHash,
        head,
        tree,
        diffHash: evidence.evidenceBundle.diffHash,
        criteriaHash: requirement.criteriaHash,
        verifierId: deps.verifier.id
      })
    )
    .digest("hex");
  deps.store.completeOperation(input.missionId, input.unitId, input.claimToken, { resultHash, files }, now());
  return { status: "verified", resultHash, files, verifierId: deps.verifier.id };
}

/** Read-only git access with a cleared environment and a bounded runtime. */
export function createFactoryGitReader(repositoryPath: string, gitPath = "/usr/bin/git"): FactoryGitReader {
  const git = (args: string[], encoding: "utf8" | "buffer" = "utf8") =>
    new Promise<{ code: number; stdout: string | Buffer }>((resolve) => {
      execFile(
        gitPath,
        ["-C", repositoryPath, "-c", "core.quotepath=false", "--no-pager", ...args],
        { encoding: encoding === "buffer" ? "buffer" : "utf8", env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", HOME: "/nonexistent" }, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout) => {
          const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
          resolve({ code, stdout });
        }
      );
    });
  const sha = /^[a-f0-9]{40}$/u;
  return {
    async commit(ref) {
      if (!/^[A-Za-z0-9^{}._/-]{1,200}$/u.test(ref) || ref.startsWith("-")) return undefined;
      const result = await git(["rev-parse", "--verify", "--quiet", ref]);
      const value = String(result.stdout).trim();
      return result.code === 0 && sha.test(value) ? value : undefined;
    },
    async tree(commit) {
      if (!sha.test(commit)) return undefined;
      const result = await git(["rev-parse", "--verify", "--quiet", commit + "^{tree}"]);
      const value = String(result.stdout).trim();
      return result.code === 0 && sha.test(value) ? value : undefined;
    },
    async isAncestor(ancestor, descendant) {
      if (!sha.test(ancestor) || !sha.test(descendant)) return false;
      return (await git(["merge-base", "--is-ancestor", ancestor, descendant])).code === 0;
    },
    async changedFiles(base, head) {
      if (!sha.test(base) || !sha.test(head)) throw new Error("changedFiles requires full SHAs");
      const result = await git(["diff", "--no-renames", "--name-only", "-z", base, head]);
      if (result.code !== 0) throw new Error("git diff failed");
      return String(result.stdout).split("\0").filter((name) => name.length > 0);
    },
    async diff(base, head) {
      if (!sha.test(base) || !sha.test(head)) throw new Error("diff requires full SHAs");
      const result = await git(["diff", "--no-renames", "--binary", "--no-color", base, head], "buffer");
      if (result.code !== 0) throw new Error("git diff failed");
      return result.stdout as Buffer;
    }
  };
}
