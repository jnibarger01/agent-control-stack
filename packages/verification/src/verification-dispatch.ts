/**
 * ACS-owned advisory dispatch planner. No provider calls, lifecycle mutations, or
 * authority decisions occur here. The caller must obtain ACS authorization.
 *
 * An exact cached PASS is a scheduling optimization, never evidence of approval:
 * ACS must independently validate the evidence manifest before accepting work.
 */

/**
 * One scheduled run of a check against an artifact.
 *
 * `jobId` identifies this run in the queue and must be unique per plan call.
 * `checkId` identifies the stable check definition (e.g. "typecheck:verification")
 * and is what cached results are matched on. They are separate so the same check
 * can run against several artifacts in one batch.
 */
export type VerificationJob = Readonly<{
  jobId: string;
  checkId: string;
  kind: "deterministic" | "semantic";
  artifactHash: string;
  policyHash: string;
  toolchainHash: string;
}>;

export type CachedVerification = Readonly<{
  checkId: string;
  artifactHash: string;
  policyHash: string;
  toolchainHash: string;
  verdict: "PASS" | "FAIL" | "UNKNOWN";
}>;

export type CacheSatisfiedJob = Readonly<{
  job: VerificationJob;
  /** The entry that matched. ACS must reconfirm it before counting it as coverage. */
  cacheEntry: CachedVerification;
}>;

/**
 * Every pending job lands in exactly one bucket, so a caller can always tell
 * "covered by prior evidence" from "not run yet". Dropping a job silently would
 * make missing coverage look like success.
 */
export type VerificationDispatchPlan = Readonly<{
  /** Jobs to start now, deterministic first, capped at the available slots. */
  dispatch: readonly VerificationJob[];
  /** Deterministic jobs skipped because an exact cached PASS exists. Semantic jobs never land here. */
  satisfiedByCache: readonly CacheSatisfiedJob[];
  /** Jobs that still need to run but did not fit in the available slots, in priority order. */
  deferred: readonly VerificationJob[];
}>;

function findExactPass(job: VerificationJob, cache: readonly CachedVerification[]): CachedVerification | undefined {
  return cache.find(
    (entry) =>
      entry.verdict === "PASS" &&
      entry.checkId === job.checkId &&
      entry.artifactHash === job.artifactHash &&
      entry.policyHash === job.policyHash &&
      entry.toolchainHash === job.toolchainHash
  );
}

export function planVerificationDispatch(
  pending: readonly VerificationJob[],
  cache: readonly CachedVerification[],
  availableSlots: number
): VerificationDispatchPlan {
  if (!Number.isSafeInteger(availableSlots) || availableSlots < 0) {
    throw new RangeError("availableSlots must be a nonnegative safe integer");
  }
  const seen = new Set<string>();
  for (const job of pending) {
    if (!job.jobId || !job.checkId || !job.artifactHash || !job.policyHash || !job.toolchainHash) {
      throw new Error("verification jobs require a jobId, checkId, and complete cache identity");
    }
    if (seen.has(job.jobId)) throw new Error(`duplicate verification job: ${job.jobId}`);
    seen.add(job.jobId);
  }

  const satisfiedByCache: CacheSatisfiedJob[] = [];
  const toRun: VerificationJob[] = [];
  for (const job of pending) {
    // Semantic (model) review is nondeterministic and advisory (ADR 0015), so a
    // cached semantic PASS never stands in for running the review again.
    const cacheEntry = job.kind === "deterministic" ? findExactPass(job, cache) : undefined;
    if (cacheEntry) satisfiedByCache.push({ job, cacheEntry });
    else toRun.push(job);
  }

  const prioritized = [
    ...toRun.filter((job) => job.kind === "deterministic"),
    ...toRun.filter((job) => job.kind === "semantic")
  ];
  return {
    dispatch: prioritized.slice(0, availableSlots),
    satisfiedByCache,
    deferred: prioritized.slice(availableSlots)
  };
}
