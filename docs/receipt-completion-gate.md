# Authoritative Change Set completion receipts

The **only** accepted terminal transition for a Change Set aggregate remains
`SqliteWorkItemStore.completeChangeSetMission`. The receipt gate runs **inside
the same SQLite IMMEDIATE transaction** as the terminal status update and
`change_set.completed` audit record.

## Evidence custody

1. `getChangeSetProgress` revalidates the approved Change Set revision, the
   execution work-item binding, the selected attempt's accepted result and
   identical stored projections, consumed lease, fencing epoch, tool invocation
   fingerprint and result-acceptance audit.
2. For each operation whose policy requires verification (including writes),
   ACS verifies the stored evidence manifest, the accepted verification
   decision, and the required independent review findings.
3. `buildAuthoritativeCompletionReceipts` verifies the **entire canonical
   audit hash chain**, re-reads the persisted permit/attempt/work-item/result,
   links the permit and result events by their canonical event hashes, and
   links the accepted verification decision for required reviews. It rejects
   absent or mismatched fields; caller-provided receipt bodies are never used.
4. Each operation receipt is hashed with a separate domain. The ordered
   receipt bundle is added to the content-addressed completion record and its
   hash is written to the `change_set.completed` audit event atomically.
   A later read of a receipt-bearing completion recomputes the same evidence
   from the persisted authority state and refuses mismatches.

The `acceptedResultReadbackHash` commits to the **durably accepted ACS
work-item/result projection**. It is **not a fresh filesystem or production
readback** and must never be presented as one. Independent observation of
external side effects remains governed by the existing verification
requirements; a model's self-assertion cannot satisfy those requirements.

## Compatibility and limits

- Legacy v1 completion records without `operationReceipts` remain readable.
  **Every new Change Set completion through the store method emits receipts.**
- A receipt is not an authorization, execution capability, or proof of
  correct real-world side effects. Its audit hashes are tamper-evident against
  unauthorized modifications that are not accompanied by rewriting the entire
  audit chain. An external signed checkpoint would be required to detect
  wholesale replacement of the database and its hashes.
- No new public API, privilege bypass, admin-mode change, or database migration
  is required for the completion gate. The separate experimental
  `@agent-control-stack/evidence` execution-receipt schema (PR #306) covers a
  different attempt evidence shape; this gate does not fabricate that schema's
  fields from Change Set evidence.
- Any future Mission Control UI must consume the **read-only validated
  completion projection**, not independently infer success from model output
  or unverified receipt JSON.
