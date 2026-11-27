# AI Factory operator and incident runbook

## Current supported mode

**F0 only:** local library parsing and proposal generation; no dispatcher, workers, submission API, operator controls or production flag. The commands below marked *future* must not be presented as working CLI commands.

## Production prerequisites (F11/F12)

- Pinned ACS and Codex Swarm builds with evidence from `verification.md`.
- Accepted authority boundary, independent security review and no open P0.
- ACS gateway credential and role policy configured; operator access tested.
- ACS SQLite WAL backups, restore drill, canonical audit verification and retention plan.
- Bubblewrap/systemd/cgroup2 and egress enforcement proven on the actual deployment host.
- Exact GitHub repository allowlist, draft PR capability, external merge policy reviewed.
- One active per-attempt UDS and kill/reap ownership proof; Swarm operator API inaccessible.
- Cost limits, request rate limits, concurrency caps, SLO dashboard and alert delivery verified.
- Production configuration follows `docs/runbooks/production.md`; do not enable real execution merely by setting a factory flag.

## Normal operating sequence (future F10+)

1. Review pending order, repo/base SHA, paths, criteria, cost cap and expected output.
2. Admit under ACS policy; inspect mission ID and approved scope.
3. Inspect current attempt, lease epoch, worker allocation, lane count and budget receipts.
4. Review independent verifier and accepted Git tree before PR publication.
5. Confirm draft PR includes exact commit, successful checks, known risks and rollback.

## High-value alerts

| Symptom | Immediate operator action | Recovery criterion |
|---|---|---|
| Audit verification failure | Disable factory dispatch and publication | Root cause resolved, chain restore evidence preserved |
| Duplicate / ghost PR | Freeze publication | Reconcile GitHub by immutable marker; no extra mutations without operator review |
| Child persists after cancellation | Revoke capability, prove pid/start before termination | No authorized orphan; postmortem |
| Worker escapes scope | Disable backend, isolate host, revoke credential | Host evidence reviewed and fixed |
| Stale lease / conflicting receipt | Fence attempt, keep artifact | New lease cannot accept old output |
| Cost cap exceeded / unreported | Stop new dispatch, investigate billing records | Reconciled evidence + corrected budget policy |
| Unknown external side effect | Quarantine job, do not auto-retry | Independent observation proves actual effect or compensating step |
| Draft PR unexpectedly merged | Freeze publisher + inspect automation rules | Remote branch control restored |

## Future disable/rollback procedure

1. **Stop intake** and prevent new admissions (factory feature flag after it exists).
2. **Stop dispatch** and revoke factory-scoped capabilities through ACS; do not switch global mode for convenience.
3. **Fence in-flight attempts** and terminate only processes with verified owner/pid/start identity; mark external effects unknown when necessary.
4. **Preserve evidence:** archive audit head, involved mission IDs, attempts, verified commits/trees and receipts. Do not delete SQLite or rewrite the chain.
5. **Revert/pin** the code/image to last known good and verify readiness; inspect any created draft PRs manually.

## Recovery drills

- Restore backup into isolated target, verify audit chain and current lease state before bringing it online.
- Simulate network partition to GitHub mid-publication, reconcile before retrying.
- Simulate Swarm death mid-lane and host reboot before result submission.
- Simulate revoked grant, leaked canary, over-budget opaque provider and stale file snapshot.
- Keep drill logs with time, commit, environment, injected fault, observed behavior and rollback.

## Incident severity

**SEV1:** unauthorized host/remote mutation, secret exfil, audit authority corruption, duplicate real-world publication with damage. **SEV2:** work escape, uncertain side effect or broad dispatch outage. **SEV3:** noncritical stalled mission, metrics/UI degradation. SEV1/2 stop production dispatch before repairs.

## Operating guardrails

Never tell an on-call operator "rerun the failed job" if its external effect is unverified. Never use Codex Swarm standalone `approve`/`promote` for an ACS-owned attempt. Do not treat a model explanation or an Outcome Engine PASS as the authorization to publish.

