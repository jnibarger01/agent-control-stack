# agentos-contracts v0.1.0

Legacy compatibility contracts for the Mission Router, LoopTrace, and gated coding loop. Zero dependencies; Node >=18.17; pure functions only.

## Current authority warning

This package still exports `applyRiskPolicy()` and `route()`. Agent Control Stack currently invokes them as a hard compatibility admission veto in `packages/policy-gate/src/contracts.ts` before ACS policy evaluation.

That is an acknowledged migration gap, not the target architecture. Do not add new policy, approval, lifecycle, dispatch, or execution authority here.

The versioned ACS mission-intake, classifier-evidence, action-manifest, approval-binding, idempotency, trace-correlation, and legacy-provenance contracts live in `@agent-control-stack/work-items`. Mission-classifier evidence generation lives in `@agent-control-stack/policy-gate`. ACS work-item policy, approval consumption, worker claims/leases, results, and audit remain authoritative under [ADR 0008](../../docs/adr/0008-mission-intake-authority-boundary.md).

## Modules

| Module | Current role |
|---|---|
| `src/envelope.js` | Legacy strict task-envelope compatibility validation |
| `src/risk-policy.js` | Legacy hard-veto risk compatibility; scheduled for de-authorization |
| `src/router.js` | Legacy hard-veto routing compatibility; never machine dispatch authority |
| `src/trace-events.js` | Compatibility trace/replay/redaction helpers; ACS audit remains canonical |
| `src/promotion-gate.js` | Maker/verifier/reviewer/promoter evidence gate |
| `src/failure-taxonomy.js` | Shared legacy failure vocabulary |
| `schemas/*.json` | Legacy language-neutral schemas |

## Migration rule

- Do not treat a legacy route, risk decision, task-envelope hash, or trace as ACS approval.
- Do not persist new canonical ACS contracts in this package.
- Remove the `policy-gate/src/contracts.ts` hard-veto dependency only in a separately reviewed runtime migration.
- LoopTrace remains a projection/read-compatibility surface, not lifecycle or approval truth.

## Verify

```bash
npm test --workspace agentos-contracts
node packages/agentos-contracts/examples/smoke.mjs
```

## Existing compatibility invariants

- No trace, no legacy write.
- Legacy write risk forces legacy approval and destructive risk forces rollback.
- Unknown legacy tasks route to human triage.
- Unknown tools are treated as write.
- Undeclared network tools are blocked.
- Promotion evidence is fail-closed; raw exit codes and SHAs override claimed booleans.
- Compatibility trace helpers redact recognized secret categories and detect chain/replay divergence.
