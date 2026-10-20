# Outcome Engine (verified assessment)

`@agent-control-stack/outcome-engine` answers "is this pull request ready, and what is the evidence?" It reads, probes and records. It never merges, deploys, pushes, comments, labels or approves. See [ADR 0028](adr/0028-outcome-engine-verdict-records.md).

## Commands

```bash
export ACS_OUTCOME_GITHUB_TOKEN=...   # a dedicated read-only token; never GH_TOKEN or GITHUB_TOKEN
acs outcome accept --repo owner/name --pr 372 --goal "Get PR 372 production-ready" [--criteria-file criteria.json] [--expires-at <iso>] [--max-evaluations <n>]
acs outcome evaluate out_<24 hex> [--json]
acs outcome show out_<24 hex> [--json]
acs outcome list [--json]
```

`evaluate` exit codes: **10** PASS, **11** PARTIAL, **12** BLOCK, **13** FAIL. `show` also returns **14** for a PASS older than one hour (STALE). Nothing exits 0 on a verdict, on purpose: a PASS is evidence about one head commit, not merge approval.

## Criteria

If `--criteria-file` is omitted the default "production-ready" template is used. Every outcome must require `pr_open` and `merge_gate_eligible` (the readiness floor); unknown kinds, unknown fields, and any `verdict`, `status`, `grade`, `actor`, `approval` or `authority` field are rejected.

| Kind                             | Satisfied when                                                                                                                                                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pr_open`                        | The pull request is open.                                                                                                                                                                                                                                                                 |
| `merge_gate_eligible`            | The integration-manager gate passes and at least one check concluded SUCCESS. Policy `assessment` ignores only the draft and author blockers and says so.                                                                                                                                 |
| `required_checks_succeeded`      | Each pinned `{name, appSlug}` check run concluded SUCCESS on the head commit. A same-named check from another app or a commit status is ambiguous (a human).                                                                                                                              |
| `files_within_scope`             | Every changed file matches `allowGlobs` and none matches `forbidGlobs`.                                                                                                                                                                                                                   |
| `verification_surface_untouched` | No changed file is in `VERIFICATION_SURFACE_V1` (workflows, review instructions, CODEOWNERS, vitest/eslint config, `scripts/check-*.mjs`, `tsconfig.base.json`, and the verifier itself: `packages/outcome-engine/**`, `packages/integration-manager/src/**`, `apps/cli/src/outcome.ts`). |

`acs_work_item_real_success` is reserved and rejected: it needs a verified binding between a work item and the pull request.

## Verdicts

Gates fire first and always yield BLOCK: record integrity, expiry or evaluation bound, unreadable or truncated GitHub data, a pull request that moved between two reads, a rollup that is not bound to the head commit, or a pull request that is not open. Otherwise, over **required** criteria:

| Condition                        | Verdict                                          |
| -------------------------------- | ------------------------------------------------ |
| none unsatisfied, none undecided | PASS (only with every PASS precondition holding) |
| some unsatisfied, none satisfied | FAIL                                             |
| some unsatisfied, some satisfied | PARTIAL                                          |
| none unsatisfied, some undecided | BLOCK (kind: the most severe undecided reason)   |

Evidence from simulated, fixture or asserted sources can neither satisfy nor contradict a criterion. A missing or erroring probe is undecided.

## What is stored

Two audit event names, written only through a three-method port: `outcome.accepted` and `outcome.evaluation_recorded`. Each evaluation is hash-chained to the previous one; `show` recomputes every hash and re-runs the verdict from the stored inputs. Token-like strings from pull request data are stored as `[unrepresentable:<hash>]` so recomputation matches what the audit store keeps.

## Trust limits

- `outcome.*` records are tamper-evident only. Any writer to the database can forge them; `show` reports a mismatch but cannot prevent a forgery that is internally consistent.
- Acceptance is local and unauthenticated (`unauthenticated_local_operator`, OS user shown). It grants nothing.
- `humanControl.exposure` is never `none`. Branch protection and CODEOWNERS are not visible to the engine. `jnibarger01-pr-review-merge.yml` can merge any pull request via `workflow_dispatch`; marking a draft ready for review can trigger it.
- Audit writes replay the chain when another connection has committed since the last check (see `assertAuditIntegrityFreshForWrite`); this is a scale caveat for a busy shared database.

## Not in this milestone

Remediation planning, agent assignment, `POST /outcomes`, an MCP tool, the defining-metric command, and work-item binding. Each needs a real executor or human-approval design first.
