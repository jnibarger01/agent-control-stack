# Factory verification strategy and production gates

**Truth source:** executed commands, immutable Git and CI refs, live canonical audit records and independent observations. Test plans are not proof that tests ran.

## Test pyramid

| Layer | Early slice | Mandatory proof |
|---|---|---|
| Pure parsing/canonical planning | F0 | exact schema, negative fields, deterministic hash, budget/path limits |
| Admission and store concurrency | F2 | transaction + uniqueness, permissions, crash and race tests |
| DAG/budget unit tests | F3 | cycles, dependencies, oversubscription, unknown spend |
| Protocol cross-repo | F4 | fixtures mirrored and signed/expiry/wrong principal negative tests |
| Real host containment | F5 | bwrap/systemd/cgroup/egress/credential/pid escape tests |
| Multi-lane integration | F6 | footprint conflicts, stale epoch, exact worktree and concurrency |
| Independent verification | F7 | forged PASS/exit 0, wrong tree and stale evidence cannot pass |
| GitHub side-effect integration | F8 | duplicate PR, remote drift, bad credentials, unauthorized publish |
| Recovery process tests | F9 | kill-point matrix and repair of uncertain results |
| Operator/UI and observability | F10 | source-backed display, permissions, redaction, accessibility |
| End-to-end real workload | F11 | actual scoped code change to draft PR plus negative workload |
| Release certification | F12 | full gates from clean pinned builds, restore and rollback drill |

## Current F0 commands

```sh
npm ci
npx vitest run packages/ai-factory/src/plan.test.ts
npm run typecheck
npm run lint
npm run check
```

Do not mark a command PASS without its exit code and commit SHA. Workstation unavailability is an unverified gate, not a pass. CI checks can support independent proof but do not substitute for real host sandbox evaluation.

## Fixed acceptance cases

- **A01:** Valid input -> stable proposal hash; repeated parse and planner runs do not alter input.
- **A02:** Unknown authority-looking field, duplicate paths, weird separator, `..`, `.git` -> rejection.
- **A03:** Every missing required field and unknown schema version -> rejection.
- **A04:** Negative, fractional, infinite, NaN or too-large budget -> rejection.
- **A05:** Conflicting idempotency replay -> one admission at most, conflict on changed request.
- **A06:** Cyclic work graph / exhausted budget -> no claim.
- **A07:** Invalid HMAC / stale lease epoch / swapped workspace -> no dispatch.
- **A08:** Swarm operator endpoints / push / promotion not reachable in ACS mode.
- **A09:** Out-of-scope worker diff / symlink escape -> quarantine, even with PASS report.
- **A10:** Fake tests/exit 0/wrong tree -> rejected evidence.
- **A11:** Verifier disagrees or unavailable -> no verified success.
- **A12:** Publication timeout after real side effect -> one draft PR after reconciliation.
- **A13:** Process death and restart -> no double attempt or residual access.
- **A14:** Audit chain modified -> block and incident.
- **A15:** Scoped grant expires/revoked mid-run -> worker cannot commit or report accepted.
- **A16:** Repo auto-merge workflow evaluated -> draft cannot silently merge.
- **A17:** Spend report absent with a capped spend metric -> unaccounted and blocked.

## Mutation and chaos fixtures

Use deterministic injected failures after write-before-ack, after lease issue, before/after child starts, before/after validation, before/after PR creation, and during shutdown. Separate **attempt interrupted** from **effect unknown**. Re-run tests across a process restart, not just a mocked service state.

## CI / release gates

1. Clean base and no unrelated diff; exact commit/branch recorded.
2. Typecheck, lint, focused suite and full `npm run check` exit 0.
3. Secret scan, dependency review and security-boundary tests pass.
4. Codex Swarm separately builds/tests at an exact pinned SHA.
5. Contract fixture parity cross-repo, OS containment and live two-process tests.
6. Policy, audit, lease, cancellation, restore and publication replay gates.
7. Operator approval for release candidate and rollout flag; rollback rehearsed.

**Pending or skipped tests must be named and risk-dispositioned.** Absence of data is not a pass.

## Evidence manifest shape (F11 proposal)

```json
{
  "acsSha": "<40-hex>",
  "swarmSha": "<40-hex>",
  "schemaVersions": ["acs.ai-factory.intent.v1", "acs.codex-swarm-envelope.v1"],
  "environment": "<redacted host/image versions>",
  "commands": [{ "argv": ["npm", "run", "check"], "exitCode": 0, "logSha256": "<64-hex>" }],
  "securityNegativeCases": ["A07", "A08", "A09"],
  "auditIntegrity": "verified",
  "recoveryDrill": "<evidence-ref>",
  "approvalRef": "<acs-auth-record>",
  "rollbackEvidence": "<evidence-ref>"
}
```

The manifest is a required future release artifact, **not created by F0**.

