# Advisor consultation

Advisor consultation is mid-run evidence from a second model. It is specified by [ADR 0027](../adr/0027-advisor-consultation.md). The guidance is for the executor. It is not an approval, a route, a lease, or a completion verdict.

## Binding

An operator enables a binding on a work item or a mission unit through the work-item store. The executor cannot set the advisor model. The binding stores:

- the canonical executor model and advisor model
- the transport model id the model caller actually receives
- `requireBeforeCompletion`

A work-item binding may only name the work item itself or its lineage root as its mission, and a mission-unit binding's subject id must be derived from its mission id (`advisor_binding_mission_mismatch` otherwise). Every binding row carries an integrity hash over all of its fields, including `disabled_at`, and the hash is re-verified on every read. A row that does not verify (an out-of-band edit such as `require_before_completion = 0`, or a pre-074 row with no hash) fails closed with `advisor_binding_integrity_mismatch`: completion is blocked and child copies are refused. An explicit privileged enable is the repair path. Binding rows cannot be deleted.

No binding means no network call and no change to success. Disabling a binding leaves prior consultation rows in place and stops new calls. A disabled binding does not require a consultation.

Pairing is checked at enable time. The advisor model must be on the allowlist and in the accepted set for that executor. Haiku 4.5 can call an advisor and cannot be one. Unknown, excluded, and weaker advisors fail closed:

| Code                         | Meaning                                                                  |
| ---------------------------- | ------------------------------------------------------------------------ |
| `advisor_model_unrecognized` | The executor or advisor id is not a known model.                         |
| `advisor_model_excluded`     | The advisor is known and paired, and the operator allowlist excludes it. |
| `advisor_pairing_rejected`   | The advisor is weaker than the executor, or it cannot advise.            |

Aliases `fable`, `opus`, `sonnet`, and `haiku` resolve to the current family default (`claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`). A full id such as `claude-opus-4-7` is also accepted.

Child work may copy the parent binding. The child executor is paired again. If that pair is rejected, the child is created without an advisor. Every copy, attached or not, is audited with the actor and lease or claim provenance (`advisory.advisor_binding_copied` / `advisory.advisor_not_attached` for work items, `advisor.binding_copied` / `advisor.not_attached` mission events for mission units).

## Consult

`consult_advisor` is a gateway MCP tool. Scope: `acs:work:create`. The arguments are the checkpoint and the ownership proof. A transcript field or an advisor model field is rejected.

The tool is disabled in production unless the operator sets `ACS_ADVISOR_CONSULTATION_ENABLED=1`. ACS has no production path for creating bindings yet (only privileged in-process store calls), so the default is off. When it is off, the tool answers `advisor_not_configured` and never calls a model.

For a work item, the proof includes `leaseToken`, and the authenticated MCP actor must be the worker that holds the lease or claim (`advisor_actor_mismatch` otherwise).

Checkpoints: `before_approach`, `recurring_failure`, `before_completion`.

Ownership is checked in the same transaction as the insert:

- a work item requires the current lease: work item, lease, lease token (when supplied, and always supplied by the MCP path), worker, unexpired lease, and fencing epoch when an attempt lease exists. An unparseable expiry counts as expired.
- a mission unit requires the live claim token and worker on a running unit

The lease is checked again with a fresh clock after the advisor returns, so a lease that expired during the call cannot record evidence. Each consultation row records the attempt, lease, or claim-token hash it was fenced to.

The advisor sees a redacted, bounded projection of that mission's flight records. Command, environment, header, cookie and other credential-bearing fields (`command`, `cmd`, `argv`, `env`, `headers`, `authorization`, `token`, `password`, `secret`, and similar) are dropped before the call. It has no tools. Dispositions:

| Disposition   | Stored                         |
| ------------- | ------------------------------ |
| `reviewed`    | bounded guidance               |
| `declined`    | bounded reason                 |
| `unavailable` | stable error code, no guidance |

A transport failure or a response outside the schema is `unavailable`. The run continues unless completion requires a consultation.

## Completion

When `requireBeforeCompletion` is set, every terminal-success path requires a `before_completion` consultation that was `reviewed`. For work items, that means both result-submission paths, `transition(id, "succeeded")` and `completeChangeSetMission`, which all go through one gate. For mission units, it means `completeOperation`. `declined` and `unavailable` fail closed. The consultation must have been recorded under the subject's live attempt (attempt protocol), lease (legacy lease), or claim (mission unit). Evidence from an earlier attempt or claim, for example before `retryUnit`, does not count. With no live fence, no evidence counts. Every candidate row's `consultation_hash` is recomputed on read, and any mismatch blocks with `advisor_consultation_integrity_mismatch`. The check reads dispositions, fence columns and hash inputs only. It never reads guidance or decline text. Failure codes: `advisor_consultation_required`, `advisor_binding_ambiguous`, `advisor_binding_integrity_mismatch`, `advisor_consultation_integrity_mismatch`.

Consultations written under migration 073 have no fence columns, so they never satisfy the gate.

## Audit

`advisory.advisor_binding_enabled`, `advisory.advisor_binding_disabled`, `advisory.advisor_consultation_recorded`, and `advisory.advisor_not_attached` carry ids, model ids, the checkpoint or reason code, the disposition, and hashes. Enable and disable events carry the actor. Consultation events carry the lease id, attempt id, worker id, or claim-token hash. They do not carry the flight projection, the guidance, or the decline reason.
