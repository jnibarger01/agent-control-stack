# Mission Control operational redesign

Mission Control keeps the existing server-rendered TypeScript application, authenticated gateway, SQLite authority stores, and browser event stream. The eleven canonical URLs are `/#overview`, `/#queue`, `/#execution`, `/#approvals`, `/#agents`, `/#executors`, `/#connectors`, `/#metrics`, `/#audit`, `/#policy`, and `/#system`. Loading or refreshing a URL selects the same page; work-item inspection retains the page and uses the existing selected-item query parameter.

## Authority and transport

The gateway builds one typed `MissionControlViewModel` from its existing stores. `GET /` renders it initially; authenticated `GET /dashboard/fragments` uses the same renderers for subsequent updates. The browser does not maintain parallel domain records. Local search/filter state selects already retrieved records; global search explicitly describes its loaded-data scope.

| Page       | Authority / transport                                                                                                | Rendering and interaction                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Overview   | Dashboard work-item window and exact status totals, registry/heartbeats, readiness, audit events, admission snapshot | Command KPIs, real work-item board, health/alerts/approval rails, activity; work cards open authenticated detail        |
| Work Queue | Existing status/risk/agent/ID filters, current plan and admission, attempts and safe lease projections               | Human-readable rows; `GET /work-items/:id` opens structured detail, policy/attempt/action history and advanced payloads |
| Execution  | Work-item states, persisted attempts, admission queue/capacity, audit execution events                               | Explicit pipeline mapping, searchable run table, elapsed/queue time, failures, real retry flow, 24-hour throughput      |
| Approvals  | Canonical work items, policy action fingerprints, requirement/grant audit events, execution-mode setting             | Existing confirmation and privileged `POST /work-items/:id/approve` and `/reject`; detail drawer and resulting refresh  |
| Agents     | Registered agents and observed service projections, heartbeat/event context; `/api/agents/:id` and `/agents/:id`     | Roster, capabilities, assignments and real API-backed detail                                                            |
| Executors  | Existing configured executors and attested runtime summaries; `/api/executors` and `/api/executors/:id`              | Registry/runtime detail, configuration versus attestation distinguished                                                 |
| Connectors | Existing connector registry and tunnel/session projections; `/api/connectors` and scoped detail                      | Existing capability, authentication metadata and dependent-session detail; no credentials displayed                     |
| Metrics    | Read-only persisted attempt telemetry, admission capacity, existing policy metrics                                   | Real hourly series, accessible numeric table, attempt success/latency and approval-grant latency                        |
| Audit      | Existing immutable retained audit events                                                                             | Search/filter table and modal structured metadata; redacted advanced payload, no mutation                               |
| Policy     | Existing policy rules, recent `policy.decided` events, `/policy/explain`                                             | Existing read-only visibility and explanation; no new policy editing endpoint                                           |
| System     | Store/audit readiness and sandbox readiness used by `/readyz`, existing `/healthz` and `/readyz` probes              | Explicit readiness components, real probe results and existing system panels                                            |

Creation still uses the existing composer and `POST /work-items`. Retry still uses `POST /work-items/:id/retry`, producing new authoritative lineage; unblock and cancellation retain their existing endpoints and confirmations. Execution mode uses the existing server setting and mutation API. Mode errors restore the last confirmed value. The browser never grants authority.

## Minimal backend additions

No HTTP routes, schema migrations, dependencies or authority-changing operations were added. The authenticated dashboard projection now includes:

- Current execution plans through the existing integrity-checking store method.
- Batched current-plan admissions, parsed with the shared admission schema.
- `ExecutionTelemetry` from read-only SQLite queries over the entire persisted attempt store, independently of the bounded finished-item window.
- The same store/sandbox readiness checks used by the readiness endpoint.

Telemetry has a rolling 24-hour window, 24 hourly buckets, succeeded/failed attempt counts, terminal attempt duration, queue duration for started attempts updated in the window, approval-grant count, and average latency from the latest matching prior approval requirement to each grant. High-risk creation directly into `needs_approval` also constitutes a requirement. Unmatched grants count but do not invent latency. Cancelled/interrupted/unknown attempts are excluded from the succeeded-versus-failed success denominator. Dry-run attempts remain visibly labelled as simulated execution.

## Canonical state and honest absence

The pipeline explicitly maps `draft` → Pending, `pending_policy` → Policy Check, `needs_approval` → Waiting Approval, `approved` → Approved, `running` → Running, `succeeded` → Completed, and `failed` → Failed. Blocked, cancelled, rejected, cancelling, unknown and quarantined states remain distinct. Exceptional attempt state is also shown. The canonical shared work-item enum supplies browser filters.

ACS does not persist a separate Waiting on Tool stage; the UI says so. It does not invent task completion percentages, ETAs, historical percentage changes, per-executor capacity, connector sync latency, uptime or numeric health percentages. Admission utilization is explicitly global execution-slot usage. Configured infrastructure is not described as healthy solely because it is configured. Missing telemetry is unavailable, an empty persisted window has an empty state, and unhealthy readiness stays visible. Agent identity comes from actual registration/assignment or known service identifiers, never a working directory.

## Shared presentation and live behavior

`premium-styles.ts` defines navy tokens and responsive shell/table/board/drawer patterns. `icons.ts` supplies local SVG icons. `render/operations.ts` provides shared metric/section cards, stage mapping, tables, pipeline, chart, activity, audit and readiness rendering. Existing domain panels and formatting remain available. `operations-client.ts` supplies navigation metadata, loaded-data command search, retained filters, keyboard-safe work/audit drawers and existing-action integration.

The existing single authenticated SSE connection drives the centralized, coalesced fragment refresh scheduler. Approval, policy and execution-mode events now also refresh the relevant canonical state. Search and filters survive fragment replacement. Manual refresh uses the same scheduler. The connection closes on page exit. Connection loss exposes a stale warning and disables existing approval/rejection/unblock mutations; reconnect refreshes through the existing scheduler. No new per-component polling loop was added.

Audit detail is escaped/redacted at rendering boundaries; lease token hashes remain excluded from dashboard-safe projections. All privileged mutations still run through existing authentication, policy, admission, capability, audit and lease/fencing checks.

Current execution plans are read in batches of at most 500 distinct work-item IDs, retaining canonical head/hash matching and recomputing every plan definition hash. Active queues are unbounded; refresh database query count therefore scales by batches rather than by individual work items. Rendering and returned payload size still scale with the displayed queue.

## Repeatable verification

Run the normal repository build first. The standalone verification script uses an ephemeral authenticated gateway, temporary SQLite database, genuine policy evaluations, registered entities, and the actual dry-run worker. Fixtures occur only in the test script; production rendering contains no seeded/mock records.

```bash
npm run build
ACS_UI_EVIDENCE_DIR=/absolute/output/directory node scripts/verify-mission-control.mjs
```

The script expects Playwright and its Chromium browser. In an environment with an externally supplied Playwright runtime, set `ACS_PLAYWRIGHT_MODULE` to its module path and optionally `ACS_BROWSER_EXECUTABLE` to an existing browser executable. This avoids adding a production dependency. It checks all eleven routes and refreshes, all pages at four widths, WCAG A/AA rules including contrast, real detail retrieval, approve/reject/retry/mode mutation and refresh, authentication rejection, and actual stream loss/stale behavior. It writes screenshots and JSON evidence.

Relevant unit/integration suites cover initial/fragment rendering, authoritative data mappings, empty/error/loading/live state, filters, drawers, approvals/retry/mode actions, redaction, exact telemetry cohorts and boundary cases. Golden files are generated by the existing renderer test, not hand-authored.

Known repository-wide gate failures must be reported separately from these scoped checks. A production build or a dry-run worker does not prove deployed production execution. Production deployment is outside this change.
