# Mission Control

## Architecture and operation

Mission Control is the React + TypeScript SPA in `apps/control-ui/app`, built by
Vite through `npm run build:control-console`. `npm run build` includes it. The
gateway serves `apps/control-ui/dist/app` at `/console/*`, with hashed assets
at `/console/assets/*` and a no-store HTML fallback for deep links. The SSR
compatibility dashboard and its existing behavior at `/` are preserved.

The browser uses a typed same-origin fetch client, a bounded query cache with
request deduplication and cancellation, history routing, and lazy route chunks.
Domain authority stays in ACS packages. Browser calculations are presentation
projections, never authorization, admission, or lifecycle decisions.

Start the gateway using the existing [local development runbook](local-dev.md),
with configured gateway authentication, then open `/console/overview`. Sign in
with the existing operator credential. Credentials must not be put in URLs,
localStorage, sessionStorage, or checked-in files. Login reuses
`POST /session/login`; the gateway owns the HttpOnly, SameSite=Strict cookie
(and Secure flag in production). Console identity and data require `acs:read`.
The shell/assets contain no operator data and can be served before login.

CSP permits same-origin scripts, styles, fetches and event streams; inline
scripts, eval, third-party origins and framing are not enabled. React renders
untrusted data as text. The console never claims an environment is Production
or fabricates a region: it identifies the current gateway address. The
address dropdown explains that environment switching is unavailable.

## Routes and actual API dependencies

| Console route         | Data and behavior                                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/console/overview`   | Work-item, registry, execution, audit and health summaries; links to filtered work and details                                                        |
| `/console/work`       | `GET /work-items`, `GET /work-items/:id`; search, filters, pagination, lineage and detail actions                                                     |
| `/console/execution`  | Work-item attempts/leases plus `GET /work-items/:id/execution-plan`; plan, admission evidence, fenced lease, attempts and events                      |
| `/console/approvals`  | Work items and their policy/approval audit evidence; pending, blocked and historical inbox tabs                                                       |
| `/console/agents`     | `GET /api/agents`, `/api/agents/:id`, `/api/agents/:id/capabilities`, and audit-derived `GET /agents`; heartbeat/health/capabilities and current work |
| `/console/connectors` | `GET /connectors` plus bounded `/api/events` history; authoritative connector/session records, fingerprints, scopes and session history               |
| `/console/policy`     | Persisted policy events and the existing read-only `POST /policy/explain`; explanation never grants approval or dispatches work                       |
| `/console/audit`      | `GET /api/events` plus `/events` SSE; filters, client-side pause, sanitized detail and copy                                                           |
| `/console/metrics`    | Authenticated Prometheus text from `GET /metrics`; actual process counters and in-tab deltas                                                          |
| `/console/system`     | `/livez`, `/readyz`, `/health`, metrics and registry probes; actual SQLite/audit/liveness checks                                                      |

The shell reads `GET /session` for identity. Detail routes append the encoded
record ID to their route. Search is available with Ctrl/Command+K or `/`.
Unknown routes and records have explicit error states.

### New projection contracts

Three additive GET projections support this console. They are listed in the
public OpenAPI contract and reviewed compatibility baseline. Each requires
configured authentication even on development loopback, checks `acs:read`,
sends `Cache-Control: no-store`, and validates a strict Zod response schema.
Missing authentication returns 401; missing configuration returns 503.

- `/session`: credential-bound actor, nullable actor ID and roles only.
- `/connectors`: existing connector records and tunnel sessions, public-key
  fingerprints, and allowed scopes. No PEM or authentication credential.
- `/work-items/:id/execution-plan`: `{ plan: record | null }` from the current
  authoritative plan head; 404 for an absent work item. Uses the canonical
  execution-plan schema. Parameters and other free text pass shared redaction.

Plan hashes identify the original authoritative record; redacted presentation
JSON must not be treated as a replacement executable plan or rehashed to infer
authority. These GETs create no plans, attempts, leases, approvals or events.
The new routes do not change existing development SSR authentication behavior.

## Realtime and action safety

One same-origin fetch SSE channel serves the authenticated app, with bounded
backfill, reconnection/backoff, deduplication and query invalidation. It closes
on pagehide/unmount and reopens on history restoration. Authentication loss
clears the session view. Stale or disconnected streams show an explicit warning
and disable approval/rejection/unblock controls. Audit pause affects rendering
only. Query and event buffers are bounded; truncated history is identified.

Supported actions reuse existing gateway contracts: create work, exact-hash
approve with a required reason, reject, cancel, unblock, retry with a reason,
clone, register agent, rotate connector key, and revoke a particular tunnel session. Each implemented sensitive
action identifies its target and uses a confirmation form. A synchronous
in-flight guard prevents duplicate submissions; POSTs are not silently retried.
Views refetch authoritative state after success. Backend policy denials and
conflicts remain errors, never optimistic success. No new mutations were added.

## Deliberately unavailable capabilities

The console omits or explains unsupported controls: request changes; whole
connector revocation; opening a transport tunnel (session registration does
not open one); editing connector scopes; policy rule/version management and
simulation history; environment switching; version/build/region configuration;
percent execution progress; retained metrics history and period comparisons.

Metrics show empty/collecting states until real in-tab samples exist. Counts
are limited to their stated API/event windows; execution fan-out scans the
most recent eligible work items and displays truncation. There is no invented
Kubernetes, Kafka, S3, incident feed, percentage progress, or heartbeat. Agent
existence alone is not evidence that it is online.

## Validation and visual QA

```sh
npm run check
npm run test:console-e2e
```

The browser harness launches a disposable loopback gateway, temporary SQLite
store and isolated headless Chrome. Test data is confined to that database.
It seeds an execution through the actual policy/worker claim boundary without
running an engine, then tests login, real mutations, duplicate prevention,
stale hashes, policy refusal, SSE, navigation, details, responsive overflow,
WCAG automated checks, CSP, and browser console errors.

To retain screenshots outside the repository:

```sh
ACS_E2E_SHOTS=/tmp/acs-mission-control-qa npm run test:console-e2e
```

The harness captures all ten routes at 1280×800, 820×1100 and 390×844, and
populated detail panels at 1280×800. Visual comparison uses the ten operator
reference JPGs in `/tmp/acs-mission-control-visual-refs`. Neither those JPGs nor
QA images belong in Git. Empty/unavailable states intentionally replace
illustrative screenshot values and unsupported infrastructure. Automated
accessibility checks complement keyboard/focus tests; they do not certify
full WCAG conformance.

See [Mission Control verification](mission-control-verification.md) for the
current revision's observed results and remaining failures.
