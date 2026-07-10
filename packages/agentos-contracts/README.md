# agentos-contracts v0.1.0

Shared contract kernel for the **Mission Router + LoopTrace + codex-swarm gated coding loop**.
Zero dependencies. Node >= 18.17. Pure functions — no I/O, no network, no exec.
All persistence and dispatch is wired by the consuming repo via injected sinks/callbacks.

## Why a shared package

mission-router, LoopTrace, and codex-swarm each need the same four contracts:
task envelope, risk policy, trace event model, promotion gate. Three private copies
drift; one package makes contract changes explicit and testable in one place.

## Modules

| Module                  | Contract                                                | Consumed by            |
| ----------------------- | ------------------------------------------------------- | ---------------------- |
| `src/envelope.js`       | Task envelope validation (fail-closed, strict)           | mission-router (ingress) |
| `src/risk-policy.js`    | Tool/task risk derivation, never-downgrade escalation    | mission-router (classify) |
| `src/router.js`         | Routing table + approval queueing decision               | mission-router (dispatch) |
| `src/trace-events.js`   | Hash-chained events, tamper check, replay divergence, redaction | LoopTrace (capture/audit) |
| `src/promotion-gate.js` | Maker/Verifier/Reviewer/Promoter gate evaluator          | codex-swarm (promoter) |
| `src/failure-taxonomy.js` | Canonical failure codes                                | all three              |
| `schemas/*.json`        | Language-neutral JSON Schemas (CI validation via ajv)    | CI / external agents   |

## Integration points

1. **mission-router**: replace ad-hoc intake with `validateEnvelope()` -> `route()`.
   Record `task_received`, `task_validated`, `risk_classified`, `route_selected`
   through a LoopTrace-backed sink **before** dispatch. Rejections never dispatch.
2. **LoopTrace**: adopt the event model as the write-time schema. `createTrace(run_id, { sink })`
   with a JSONL/SQLite sink gives hash-chained records; `verifyChain()` is the audit;
   `detectReplayDivergence()` is the replay check. run_id + seq live inside the hash body,
   so events cannot be replayed across runs (closes the HMAC cross-path replay class).
3. **codex-swarm**: Promoter calls `evaluateGate(evidence)` and merges **only** on
   `promoted === true`. Evidence must carry `head_sha_expected` (SHA the Verifier tested)
   and `head_sha_actual` (branch re-resolved at merge time). Mismatch blocks regardless
   of any claimed boolean — this is the head_sha fix that unblocks mission-router
   from dry-run default.

## Verify

```bash
node --test        # 48 tests
node examples/smoke.mjs   # end-to-end gated loop, exit 0 on pass
```

## Invariants enforced

- No trace, no write: `trace_required` must be true for write/destructive at validation.
- Approval forced at effective risk >= write; rollback forced at destructive. Never downgraded.
- Unknown task_type -> human triage. Unknown tool -> treated as write.
- Network tools without declared network access -> `network_blocked`, rejected.
- Gate is fail-closed: missing/mistyped evidence blocks; raw evidence (exit codes, SHAs)
  overrides self-reported booleans. Maker optimism does not merge code.
- Secrets redacted by category at event-write time; values never persist in traces.
