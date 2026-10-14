# Delegated authority graph

`MissionAuthorityLedger.authorityGraph(missionId)` returns a read-only projection of who may do what in a mission:
the human-issued grant at the root, every work unit beneath it, how each unit's authority was narrowed from its
parent, whether that authority could be exercised right now, and the delegation history.

## It is a view, not a control

Authority is enforced at the execution boundary, not here:

- `requestChildWork` derives a child as the intersection of its parent, mission policy and the request. A request for
  anything the parent lacks is denied with reasons and nothing is created.
- `verifyDispatch` re-reads durable state on every dispatch and refuses on revocation, expiry, a changed subject,
  supersession, a wrong actor, an exhausted attempt budget, a lane the authority does not cover, or any integrity doubt.
- Records are append-only and hash-bound. Every unit traces to the mission's one grant, so revoking that grant stops
  the whole tree at its next dispatch or delegation without walking it.

The graph computes each node's `effective.state` with the same checks in the same order as `verifyDispatch`
(superseded, revoked, subject changed, expired). A test runs both across revocation, expiry, subject change and
supersession and asserts the graph never shows `active` for a unit that dispatch refuses.

## Shape

`schemaVersion: "acs.authority-graph.v1"`.

- `root`: grant id and hash, approver, reason, executing actor, expiry, mission policy, `state`, and `revocation`
  (who and why) when the grant was revoked. `no_authority` or `integrity_failed` when the mission has no verified grant.
- `nodes[]`: one per work unit. `authoritySource` is `mission` (root unit), `derived` (child work) or `none`.
  `narrowing.notInherited` lists the scope entries, tool classes and privileges the parent held that this unit does not;
  `limits` and `expiresAt` show parent and own values side by side.
- `effective.state`: `active`, `revoked`, `expired`, `superseded`, `subject_changed`, `integrity_failed`, `no_authority`.
- `edges[]`: `mission` to root units, parent to child.
- `history`: `authority.*` and `child.*` events in order (granted, requested, admitted, denied, reduced), capped at 500
  with `truncated`. Denied escalation attempts appear here. Bodies were redacted when written.
- `integrity`: `failed` when any record failed its integrity check. The call itself never throws on a corrupted record;
  that node, and everything derived from it, is `integrity_failed`.

## Cycles

Unit authority is derived through `parent_unit_id`. A stored loop (or a unit naming itself as parent) used to recurse
until the stack overflowed, which surfaced from `verifyDispatch` as a crash instead of a refusal. It is now an
`authority_integrity` failure: dispatch refuses with `authority_integrity_failure` and the graph marks the nodes
`integrity_failed`. Creating a cycle through the API is not possible because a child is always a new unit under a
live parent; the guard covers corrupted storage.

## Not in this slice

- No HTTP endpoint yet. The ledger is not wired into the gateway on `main`; the governed composition root (#332) does
  that wiring, and a route belongs with it.
- No operator revocation of an individual delegation. Revocation is of the mission's grant, which is the only
  revocable authority object today; a per-delegation revoke would need a new append-only table and migration.
- No Mission Control graph view (Feature 10).
