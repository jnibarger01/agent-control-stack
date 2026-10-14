# Advisor consultation

Advisor consultation is mid-run evidence from a second model. It is specified by [ADR 0027](../adr/0027-advisor-consultation.md). The guidance is for the executor. It is not an approval, a route, a lease, or a completion verdict.

## Binding

An operator enables a binding on a work item or a mission unit through the work-item store. The executor cannot set the advisor model. The binding stores:

- the canonical executor model and advisor model
- the transport model id the model caller actually receives
- `requireBeforeCompletion`

No binding means no network call and no change to success. Disabling a binding leaves prior consultation rows in place and stops new calls. A disabled binding does not require a consultation.

Pairing is checked at enable time. The advisor model must be on the allowlist and in the accepted set for that executor. Haiku 4.5 can call an advisor and cannot be one. Unknown, excluded, and weaker advisors fail closed:

| Code                         | Meaning                                                                  |
| ---------------------------- | ------------------------------------------------------------------------ |
| `advisor_model_unrecognized` | The executor or advisor id is not a known model.                         |
| `advisor_model_excluded`     | The advisor is known and paired, and the operator allowlist excludes it. |
| `advisor_pairing_rejected`   | The advisor is weaker than the executor, or it cannot advise.            |

Aliases `fable`, `opus`, `sonnet`, and `haiku` resolve to the current family default (`claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`). A full id such as `claude-opus-4-7` is also accepted.

Child work may copy the parent binding. The child executor is paired again. If that pair is rejected, the child is created without an advisor.

## Consult

`consult_advisor` is a gateway MCP tool. Scope: `acs:work:create`. The arguments are the checkpoint and the ownership proof. A transcript field or an advisor model field is rejected.

Checkpoints: `before_approach`, `recurring_failure`, `before_completion`.

Ownership is checked in the same transaction as the insert:

- a work item requires the current lease: work item, lease, worker, unexpired lease, and fencing epoch when an attempt lease exists
- a mission unit requires the live claim token and worker on a running unit

The advisor sees a redacted, bounded projection of that mission's flight records. It has no tools. Dispositions:

| Disposition   | Stored                         |
| ------------- | ------------------------------ |
| `reviewed`    | bounded guidance               |
| `declined`    | bounded reason                 |
| `unavailable` | stable error code, no guidance |

A transport failure or a response outside the schema is `unavailable`. The run continues unless completion requires a consultation.

## Completion

When `requireBeforeCompletion` is set, the work-item success transition and mission-unit `completeOperation` require a `before_completion` consultation that was `reviewed` or `declined`. The check reads disposition only. `advisor_consultation_required` is the failure code.

## Audit

`advisory.advisor_binding_enabled`, `advisory.advisor_binding_disabled`, `advisory.advisor_consultation_recorded`, and `advisory.advisor_not_attached` carry ids, model ids, the checkpoint or reason code, the disposition, and hashes. They do not carry the flight projection, the guidance, or the decline reason.
