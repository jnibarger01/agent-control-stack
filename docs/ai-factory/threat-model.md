# AI Factory threat model

**Assumptions:** external planners, tickets, model output, GitHub content, worker evidence and local persisted data are untrusted. The ACS operator identity and action-bound authority are checked at each mutating boundary. Codex Swarm standalone privileges are not implicitly carried into ACS mode.

## Assets

ACS credentials, operator identity, scoped mission grant, audit integrity, allocated worktree and code IP, GitHub organization permissions, model spend budget, host file system and network, and accepted PR lineage.

## Trust boundaries

1. **Untrusted demand -> ACS authenticated intake.** Bind caller independently; validate strict schema. No body-supplied authority.
2. **Proposal -> ACS admission.** Proposal hash is not a signature; policy, scope, dedupe and budget require the canonical store.
3. **Admitted unit -> engine.** Require current lease/epoch, worktree allocation, signed attempt envelope, sandbox and narrow credentials.
4. **Engine evidence -> ACS outcome.** Verify echo, tree, path, tests, integrity, snapshot freshness; independent verifier.
5. **Accepted candidate -> GitHub.** Reauthorize external publication and recheck remote state; draft only.
6. **Audit/projection -> UI.** Redact, authenticate and distinguish telemetry from authoritative state.

## Threat and control matrix

| Threat | Severity | Control | Required adversarial proof |
|---|---|---|---|
| Ticket asks to ignore rules or reveal keys | Critical | Treat text as data, parser never interprets instructions as authority | Prompt injection never changes actor, privileges or policy |
| Spoofed principal or approval in JSON | Critical | Closed schema, ACS-injected identity and policy gate | forged `actor`/`approved` rejected |
| Digest replay with different request | High | Transactional (`principal`, orderId, hash) binding | concurrent altered payload yields conflict |
| Stale lease / double submit | Critical | Epoch and claim token fence inside transaction | old worker cannot append or publish |
| Subordinate Swarm invokes its operator API | Critical | ACS mode hard fork; authenticated UDS only | API/promotion routes absent in ACS mode |
| Worktree/symlink/`.git` escape | Critical | Host sandbox mount, canonical realpath and diff scope | executable escape attacks fail |
| HMAC or envelope tampering | Critical | Per-attempt HMAC, exact SHA/binding/expiry | wrong MAC/epoch/hash/attempt refused |
| Leakage through env, logs or artifacts | High | Single worker credential; scoped egress; redaction | injected canary never exported |
| False PASS from worker/verifier | High | Independent verification and source-bound receipts | fabricated exit 0 / wrong commit blocks |
| Unbounded model loop / spend | High | ACS budget, reservation + accounting, kill/revoke | budget exceed stops new tasks; unknown not zero |
| Auto-merge workflow bypasses Outcome Engine | High | Draft-only PR + review repository workflows and branch policy | e2e draft remains unmerged, policy drift alarms |
| Remote PR created then timeout | High | Idempotency + reconciliation by immutable marker | retry does not duplicate PR |
| Host reboot / child orphan | High | pid/start proof and fenced restart reconciliation | no orphan remains authorized |
| Poisoned analytics / stale metrics | Medium | Project from ACS audit, show source/time/provenance | telemetry cannot change lifecycle |

## Security invariants (non-negotiable)

- No new factory identity, lease store, "admin mode", approval table, policy bypass, promotion guard or canonical audit log.
- No direct process spawning by F0 planning code; no routing, network, database or host mutations.
- No raw secrets or tokens in factory intent, proposal hash, GitHub PR body or model-visible prompt.
- Denial takes priority over throughput; fallback must **reduce** scope, never widen.
- Unknown external effect is `unknown`, never retryable success, until independently reconciled.
- Unverified evidence cannot become an accepted outcome. Advisor verdicts do not issue capabilities.
- Critical changes require authenticated out-of-band authorization under ACS, regardless of agent confidence.

## Mandatory security review at F4 and F11

At F4, review ACS-controlled Swarm path in both repositories and ensure no operator API fallback. At F11, run an independent review of real sandbox/network/credential isolation, GitHub permissions, cancellation and audit replay. Keep a signed evidence manifest tied to exact commits, tool versions and environment.

