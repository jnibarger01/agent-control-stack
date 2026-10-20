/**
 * ACS-owned advisory dispatch planner. No provider calls, lifecycle mutations, or
 * authority decisions occur here. The caller must obtain ACS authorization.
 *
 * An exact cached PASS is a scheduling optimization, never evidence of approval:
 * ACS must independently validate the evidence manifest before accepting work.
 */
export type VerificationJob = Readonly<{
  id: string;
  kind: "deterministic" | "semantic";
  artifactHash: string;
  policyHash: string;
  toolchainHash: string;
}>;

export type CachedVerification = Readonly<{
  id: string;
  artifactHash: string;
  policyHash: string;
  toolchainHash: string;
  verdict: "PASS" | "FAIL" | "UNKNOWN";
}>;

export function planVerificationDispatch(
  pending: readonly VerificationJob[],
  cache: readonly CachedVerification[],
  availableSlots: number
): VerificationJob[] {
  if (!Number.isSafeInteger(availableSlots) || availableSlots < 0) {
    throw new RangeError("availableSlots must be a nonnegative safe integer");
  }
  const seen = new Set<string>();
  for (const job of pending) {
    if (!job.id || !job.artifactHash || !job.policyHash || !job.toolchainHash) {
      throw new Error("verification jobs require an id and complete cache identity");
    }
    if (seen.has(job.id)) throw new Error(`duplicate verification job: ${job.id}`);
    seen.add(job.id);
  }
  const eligible = pending.filter((job) => !cache.some((entry) =>
    entry.verdict === "PASS" &&
    entry.id === job.id &&
    entry.artifactHash === job.artifactHash &&
    entry.policyHash === job.policyHash &&
    entry.toolchainHash === job.toolchainHash
  ));
  return [
    ...eligible.filter((job) => job.kind === "deterministic"),
    ...eligible.filter((job) => job.kind === "semantic")
  ].slice(0, availableSlots);
}
