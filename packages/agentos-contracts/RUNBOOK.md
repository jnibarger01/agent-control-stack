# Operator Runbook — Gated Coding Loop

## Submit a task
1. Build an envelope (see `examples/sample-envelope.json` or `makeEnvelope()`).
2. Feed it to mission-router intake. Router validates -> classifies -> routes.
3. Rejection returns `{ ok:false, failure_code, reasons[] }`. Fix the envelope; nothing ran.

## Inspect a trace
- Traces are hash-chained JSONL per run_id.
- `verifyChain(events)` -> `{ ok, index, reason }`. Any `ok:false` = tampering or corruption
  at `index`; treat the run as untrusted from that point.
- `task_received` payload holds the full envelope; `approval_decision` holds who/when/channel.

## Approve / reject
- Anything with effective risk >= write sits in the approval queue. Nothing dispatches first.
- Approve: record `approval_decision {decision:"approved", by, channel}` in the trace,
  then dispatch. Reject: record `{decision:"rejected"}` and close with
  `run_failed {failure_code:"approval_required"}`.
- No approval event in trace = promotion gate fails `approval_recorded` later. Two lines of defense.

## Rerun / replay
1. Record `run_replay_started` referencing the original run_id.
2. Re-execute with the original envelope under a new run_id.
3. `detectReplayDivergence(original, replay)` -> first divergent index by
   type+payload digest (timestamps/hashes excluded).
4. Divergence -> record `replay_divergence_detected`, classify `replay_diverged`, investigate
   nondeterminism (network, clock, uncontrolled state) before trusting either run.

## Promote
1. Verifier produces raw evidence: exit codes, `git status --porcelain`, secret scan output,
   and the tested `head_sha_expected`.
2. Promoter re-resolves branch -> `head_sha_actual` at merge time.
3. `evaluateGate(evidence)`; merge only on `promoted:true`; record `promotion_completed {head_sha}`.
4. Any failure: record `promotion_blocked {failure_code, failures[]}` and return the
   remediation list. Do not retry the merge without new evidence.

## Rollback
- Destructive/write-risk runs must record `rollback_checkpoint_created {repo, head_sha}`
  before mutation.
- Rollback = reset to checkpoint SHA (`git reset --hard <sha>` / restore snapshot), record
  the rollback as its own destructive-risk task with its own approval. Rollbacks are traced too.

## Debug a failure
1. Pull `run_failed` / `promotion_blocked` -> `failure_code` (canonical taxonomy).
2. Walk events backward from the failure: last `tool_call_finished`,
   `verification_finished` payloads carry exit codes and summaries.
3. `verifyChain()` first. A broken chain means the record itself is suspect —
   stop debugging the code and start debugging the recorder.
4. `gate_missing_evidence` means a role handed the Promoter vibes instead of output.
   Rebuild evidence from actual commands.
