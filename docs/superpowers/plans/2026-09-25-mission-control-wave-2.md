# Mission Control improvements — wave 2 (20 items)

Status: plan (nothing here is implemented yet)
Date: 2026-09-25
Scope: `apps/control-ui`, the dashboard routes in `apps/gateway`, and read-model helpers in `packages/work-items`

## Baseline

Wave 1 (#165, #166, #167, #175) shipped: live in-place fragment refresh over SSE,
display redaction, cancel/retry/clone controls, bounded queue windowing, audit
history paging and pause, periodic `/readyz` probes, keyboard shortcuts,
approval triage by risk and wait (30 min SLA), `?item=` deep links, tab-title
count plus opt-in notifications, composer policy preview, policy decision
summary, live metrics polling, light/dark theme, and readable audit rows.
The strict/admin execution-mode header and `POST /execution-mode` came in
separately (`aa8a54c`).

This wave works through the gaps between that UI and
`docs/acs-dashboard-spec.md`, and pays down the structural debt wave 1 left
behind.

What is still missing, checked against the code:

- `apps/control-ui/src/index.ts` is 2,383 lines. Server render, CSS, and the
  whole inline client script live in template strings, so the client code gets
  no type checking and no lint.
- The "execution" view reuses the queue panel. The spec's **Attempts & leases**
  view does not exist.
- There is no "lease expiring soon" warning. The spec calls for one, and the
  lease expiry data is already on the page.
- `/health` computes audit-chain integrity (`store.verifyAuditChain`), but the
  UI never shows it.
- The audit timeline has no filters. The spec requires filters by work item,
  attempt, lease, actor, approval, event name, and time range.
- Workspace allocation, approval grant lifecycle (valid, consumed, expired),
  and full retry lineage are not shown in work-item detail.
- Dry-run is not labeled per attempt or result. Spec principle 6 says it must
  be unmistakable.
- The disconnect gate misses the composer and the execution-mode toggle.

## Guardrails (apply to every item)

1. The server is still the only renderer of authority. The client never decides
   that something is allowed.
2. New read routes are `requireRead`, rate limited, bounded, redacted, and
   covered by the dashboard-session expiry test in `server.test.ts`.
3. New mutations go through the same routes and authority checks non-UI
   callers use. There is **no bulk approve**. The spec forbids it.
4. Derived projections are labeled as derived. Missing evidence renders as
   `unknown`, never as green.
5. Never render raw lease tokens, token hashes, host workspace paths, or
   unredacted env data.

---

## Tier A: foundation (do first, unblocks the rest)

### 1. Split `index.ts` and type-check the client script

- **Problem:** The inline client script is untyped and unlinted. Every wave-1
  feature added to it, and regressions only show up in JSDOM tests.
- **Change:** Move the client into `src/client/*.ts` and bundle it at build
  time with esbuild (already transitively available; if not, add it as a
  devDependency) into one IIFE string that the server inlines. Move CSS into
  `src/styles.css`, read once at startup. Split server render by panel
  (`render/queue.ts`, `render/approvals.ts`, …).
- **Acceptance:** `index.ts` is under 400 lines. The client passes `tsc
--noEmit` and eslint. Rendered HTML is byte-identical before and after, using
  a snapshot test captured before the move. CSP behavior is unchanged.
  Mission Control currently sends no `Content-Security-Policy` header and uses
  no nonces or hashes, so the bundle stays an inline script and no build-time
  hash is added in this refactor.
- **Follow-up (separate security PR, not part of #1):** For CSP hardening, serve
  the bundle as a same-origin external script and set `script-src 'self'`.
  Don't add more inline-script hash or nonce machinery.
- **Risk:** This is a large mechanical diff. Land it alone, with no behavior
  changes mixed in.

### 2. Typed dashboard read-model contract

- **Problem:** The fragment, event, and metrics payloads are ad hoc shapes
  shared by convention between the gateway and the client.
- **Change:** Add Zod schemas in `apps/control-ui/src/contracts.ts` for
  `/dashboard/fragments`, `/dashboard/events`, and `/dashboard/metrics`. The
  gateway validates on the way out in tests, and the client parses on the way
  in. A parse failure renders the section as `unavailable`, not blank.
- **Acceptance:** A schema drift test fails when the gateway changes a field
  without updating the contract.

### 3. Playwright smoke suite against a real gateway

- **Problem:** Every client test uses JSDOM. Layout, focus, SSE reconnect, and
  theme bugs, like the wave-1 card-grid collapse, get past it.
- **Change:** Add `evals/` or `apps/control-ui/e2e/`. It boots the gateway on a
  temp SQLite DB, seeds work items and approvals, and drives Chromium. The
  sandbox already provides it at `/opt/pw-browsers`. Cover login, approve with
  confirm, SSE drop and reconnect, deep link, and keyboard `?` help.
- **Acceptance:** Runs in CI under 90 s, plus an axe-core pass on every view.

---

## Tier B: spec gaps (authority visibility)

### 4. Dedicated Attempts & Leases view

- **Change:** Turn `execution` into a real panel with a table of active and
  recent attempts: attempt number, status, owner worker, fencing epoch, lease
  status, time to expiry, and admission/approval binding. When a newer epoch is
  authoritative, older-epoch owners are shown struck through as "superseded".
  The spec requires that a stale worker never appears as the current owner.
- **Data:** Reuse the batched attempt and lease reads from wave-1 #11. No new
  store queries beyond an `ORDER BY updated_at LIMIT`.
- **Acceptance:** A test covers two leases on one attempt with different epochs
  and checks that only the higher one is labeled owner.

### 5. Lease "expiring soon" warnings

- **Change:** A presentation-only badge appears when `expiresAt - now` is under
  max(60 s, 20% of the lease TTL). It shows on queue rows, in the Attempts view,
  and as an overview card ("Leases expiring"). The countdown ticks on the
  client from server-provided timestamps, with server clock skew corrected
  using the fragment response `Date` header.
- **Acceptance:** The label reads "warning only". A test checks that it changes
  no state.

### 6. Audit-chain integrity indicator

- **Change:** Add `auditChain` (ok, last verified sequence, checked-at) to the
  system fragment and the header, from the existing `store.verifyAuditChain`
  health check. A failure turns the header red, announces through aria-live,
  and disables approval buttons client-side. The server already fails closed,
  so this only avoids dead clicks. Link to `docs/runbooks/audit-chain-export.md`.
- **Performance:** Verification is O(n). Use the cached `auditChainValid` flag
  the store already maintains, and do not re-verify per request.

### 7. Approval grant lifecycle in detail

- **Change:** Work-item detail lists each approval binding with its state:
  required → requested → granted (valid until T) → consumed, expired, or
  rejected. Show approver and requester subjects, the policy-decision
  fingerprint (abbreviated, click to show the full value), and the action hash
  it binds.
- **Acceptance:** A granted-but-expired approval never renders as valid. A test
  uses a frozen clock.

### 8. Plan and admission panel

- **Change:** Detail shows the current plan: objective, ordered steps,
  constraints, and network, push, and deploy flags. It also shows admission:
  policy version, decision hash, whether approval was required, the admitting
  actor, and a bold "not admitted" state when no admission record exists. Add
  an overview card, "Plans awaiting admission".
- **Acceptance:** Admission is never inferred from work-item status alone. A
  test covers a plan with no admission row.

### 9. Workspace allocation summary

- **Change:** Detail shows allocation ID, branch and base ref, status, and
  created and teardown times, using a safe label. The host path is **not**
  rendered.
- **Acceptance:** A redaction test checks that no absolute path leaves the
  server in any fragment.

### 10. Unmistakable dry-run labeling

- **Change:** Add a persistent `DRY RUN` banner in the header while the
  worker's recorded `execution_mode` is `dry_run`. Add a per-attempt and
  per-result chip taken from the persisted result metadata, not from config.
  The chip shows `unknown` when the metadata is absent.
- **Acceptance:** No UI path shows an execution result without a mode chip.

### 11. Retry and clone lineage graph

- **Change:** Detail renders the chain root → … → this item → descendants from
  `sourceWorkItemId` and `lineageType`, with retry sequence, reason, and
  status. Each node is a deep link.
- **Data:** Add a bounded recursive CTE in the store with depth ≤ 25, returning
  an error marker past the limit instead of looping.

---

## Tier C: operator workflow

### 12. Audit filters and search

- **Change:** Add a filter bar for event name/category, work item, attempt,
  lease, actor, approval, and time range. `GET /dashboard/events` gains those
  query params backed by indexed columns. Add indexes only where `EXPLAIN QUERY
PLAN` shows a scan. Filters live in the URL so they can be shared.
- **Acceptance:** Live SSE events that do not match the active filter are
  counted ("12 new, hidden by filter") and not dropped silently.

### 13. Correlated per-item timeline

- **Change:** Work-item detail embeds the audit events for that item and its
  attempts and leases in one ordered stream. Reuse #12's filter query with
  `workItemId`.
- **Acceptance:** Page size is capped, with "load older" for more.

### 14. Bounded audit export from the UI

- **Change:** Add a "Download filtered events (NDJSON)" option that applies the
  current #12 filter, is hard-capped at 10k rows, is redacted server-side, and
  includes the chain range (first and last sequence plus hashes) so the export
  can be checked against `audit-chain-export`.
- **Acceptance:** The export action itself appends an `audit.exported` event.

### 15. Approval digest and SLA escalation in the UI

- **Change:** Surface the existing pending-approval digest
  (`packages/policy-gate` pending-approval-digest) as an Approvals header
  strip: count over SLA, oldest wait, and a breakdown by risk. Allow the
  per-deployment SLA to override the hard-coded 30 min through the
  `approvalSlaMs` view-model field, which already exists and just needs a
  config source.
- **Acceptance:** One SLA source, shared by the digest job and the UI.

### 16. Saved queue views

- **Change:** Add named filter presets ("My attention", "High risk waiting",
  "Quarantined", "Failed last 24h") and custom saves in `localStorage`, wrapped
  in try/catch because this is a per-viewer convenience only. Presets are
  shipped from the server, so they stay canonical.

### 17. Quarantine triage panel

- **Change:** Add a dedicated list of quarantined items and attempts showing
  the reason, the evidence event, and the time in quarantine, plus a link to
  the runbook.
- **Operator action: "Retry through policy".** There is no canonical release
  mutation. The internal `quarantined → pending_policy` transition in
  `state-machine.ts` is not an operator route. The supported path is
  `POST /work-items/:id/retry`, which creates a **new** linked work item in
  `pending_policy` and leaves the quarantined item unchanged as history. Reuse
  the wave-1 retry control, including its required reason and confirmation. Do
  not label it "Release", and do not add a release route.
- **Acceptance:** After a retry, the quarantined item still shows as
  `quarantined`, and the new item appears in its lineage (#11).

---

## Tier D: resilience and reach

### 18. Stale and offline mode

- **Change:** `applySseConnectionState` already shows a stale banner and
  disables approve, reject, unblock, and work-item controls. It does **not**
  cover the task composer submit or the strict/admin execution-mode toggle, and
  it ignores repeated fragment-fetch failures while SSE is still up. Widen it
  into one `setMutationsEnabled()` path that covers every mutating control.
  Trigger it on SSE disconnect _or_ fragment staleness past a threshold. Dim
  stale panels and show "Data as of HH:MM:SS (stale)".
- **Acceptance:** A test lists every mutating control in the rendered page and
  checks that all of them are disabled when the stream is stale, so a new
  button can't skip the gate.

### 19. Mobile and narrow layout pass

- **Change:** Build an approvals-first layout under 720 px: stack panels, give
  approve and reject buttons ≥ 44 px targets, turn the detail drawer into a
  full-screen sheet, and prevent horizontal scroll. The main use case is
  approving from a phone after an out-of-band notification.
- **Acceptance:** Playwright (#3) runs at a 390×844 viewport, and the axe pass
  is clean.

### 20. Web Push for approval requests (opt-in)

- **Problem:** Wave-1 notifications only fire while a tab is open.
- **Change:** Add a service worker and VAPID Web Push for
  `work_item.needs_approval`. The payload is **only** "N approvals waiting" plus
  a deep link, with no titles, intents, or hashes, because push goes through
  third-party relays.
- **Subscription lifecycle:** Dashboard sessions are stateless HMAC-signed
  cookies, and there is no `/session/logout` route, so subscriptions can't be
  tied to a session. Instead:
  - Store each subscription against the authenticated principal or credential,
    with its own `expires_at`.
  - Provide an explicit unsubscribe/delete route, read-guarded and audited.
  - Garbage-collect expired subscriptions.
  - Revoking the principal or credential deletes its subscriptions.
- **Boundary (ADR 0001):** Web Push is allowed as an optional outbound
  integration, like the pending-approval digest webhook. It stays default-off,
  carries only non-sensitive metadata, and grants **zero** approval or
  execution authority. The deep link still requires a normal dashboard login.
- **Risk:** This is the only item that adds an outbound network dependency.
  Keep it behind the default-off config flag and add it to the threat model in
  the same PR.

---

## Sequencing

| PR  | Items           | Why together                                                |
| --- | --------------- | ----------------------------------------------------------- |
| 1   | #1              | Mechanical refactor, isolated, snapshot-guarded             |
| 2   | #2, #3          | Test infrastructure before new surface area                 |
| 3   | #4, #5, #10     | Execution-safety view; shares attempt and lease data        |
| 4   | #6, #18         | Fail-closed UI states                                       |
| 5   | #7, #8, #9, #11 | Work-item detail read model; one gateway composition change |
| 6   | #12, #13, #14   | Audit query surface; shares the filter backend              |
| 7   | #15, #16, #17   | Operator workflow                                           |
| 8   | #19             | Layout pass once panels are final                           |
| 9   | #20             | Adds subscription state and a threat-model entry            |

PRs 3 through 7 can run in parallel once PR 2 lands.

## Explicitly out of scope

- Bulk approve or bulk cancel (spec forbids it).
- CPU, memory, cost, or throughput cards (ACS does not persist trustworthy
  measurements; see the spec's Overview section).
- A framework migration (React etc.). #1 gets the maintainability win without
  a second app.
- Any UI for real execution before `docs/releases/sandbox-real-execution-gate.md`
  passes.

## Resolved decisions

1. **Quarantine release:** There is no canonical release route. #17 uses
   "Retry through policy" (`POST /work-items/:id/retry`), which creates a new
   linked item and leaves the quarantined one unchanged. Sources:
   `packages/work-items/src/state-machine.ts`, the store's retry and
   `createLinkedWorkItem`, and the retry route in `apps/gateway/src/server.ts`.
2. **CSP:** Mission Control sends no CSP header and uses no nonces or hashes.
   #1 preserves that. CSP hardening is a separate PR using an external
   same-origin script and `script-src 'self'`.
3. **Web Push:** It is compatible with ADR 0001 when it is default-off, sends
   no sensitive data, and grants no authority. Subscriptions are scoped to the
   principal or credential with their own expiry, explicit unsubscribe, and
   garbage collection, because sessions are stateless and there is no logout
   route.
