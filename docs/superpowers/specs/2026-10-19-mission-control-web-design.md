# Mission Control Web: React architecture and migration plan

Status: **proposed, awaiting approval. No production code is written under this spec.**
Branch: `claude/acs-frontend-revamp-47b1d2` · Date: 2026-10-19
Governing documents: `docs/acs-dashboard-spec.md` (domain model, fail-closed rules), `docs/mission-control-redesign.md` (current console).

## 1. Intent

Replace the string-templated operator console with a React + Vite + Tailwind application that feels like a premium command center: a live agent network, work-item pipelines, execution traces, approvals and observability. Migration is incremental (strangler), not a rewrite. Backend authority, fail-closed behaviour, SSE contracts, security controls and rollback are preserved.

Mockup direction: 01 (premium dark), 04 (operational task management), 05 (data-driven observability), plus the AetherOps reference for the routing/topology treatment. Light theme is supported.

**First PR:** React architecture, shared design system, application shell, and a read-only **Command** overview on real backend data. No mutations. No simulated data.

### Hard rules (carried over, non-negotiable)

1. **No simulated operational data.** Mockup figures (spend, "98.6% health", approval rate, cost pulse) have no ACS source and are **not built**. Anything ACS does not persist renders `unavailable`, never a plausible number.
2. **Fail closed.** Missing, corrupt or schema-invalid data renders `unknown` / `unavailable`. Never green by default.
3. **The browser grants no authority.** Server-side policy and approval checks remain the only authority. First PR has zero mutating calls.
4. **Dry-run is always visible** (execution-mode badge in the shell).
5. **Nothing sensitive reaches the client:** no lease tokens or token hashes, credentials, host paths (`target.cwd`), unrestricted env or unbounded prompt/stdout.
6. **Rollback is one switch and never requires a redeploy of the backend** (see 6.3).

## 2. Baseline (captured 2026-10-19, before any change)

Environment: this worktree, `npm install` (see 2.3), `tsc -b` clean, real gateway with temp SQLite, registered agents/connectors and the actual dry-run worker.

### 2.1 What exists

| Aspect | Measured / observed |
|---|---|
| Rendering | Server-side HTML strings (`apps/control-ui/src/render/*`), ~13.7k lines incl. tests, golden-file tests |
| Overview payload | **529 KB** HTML, **196 KB** inline script, **57 KB** inline CSS; live in 46 ms locally |
| Pages | 11 hash-routed pages, all backed by real stores |
| Live updates | One `EventSource('/events')`; `GET /dashboard/fragments` returns server-rendered HTML fragments; client-side scheduler coalesces refreshes |
| Auth | `requireRead` preHandler; HTML `/` returns a login page on 401; same-origin EventSource |
| Accessibility | axe WCAG A/AA: **0 violations on all 11 pages** (`accessibility-verification.json`). This is a floor the new app must match. |
| Visual | See `assets/2026-10-19-baseline/desktop-overview.png` and `mobile-overview.png`: raw `wrk_<uuid>` identifiers as the primary label, text-block "Operator insights", a create-task form inline on the overview, uniform KPI cards, no topology or flow visualisation. |

### 2.2 Existing e2e coverage

`scripts/verify-mission-control.mjs` passed **22 checks** (all 11 direct-URL routes, real detail retrieval, approve/reject/retry flows, audit inspection, readiness) and then **failed on "execution-mode admin"** (`#execution-mode-result` never shows `mode admin`). That is a pre-existing failure, consistent with `docs/superpowers/plans/2026-10-02-retire-global-admin-mode.md`. The verifier is stale there; it is unrelated to this work and must be reported separately, not hidden.

### 2.3 Repository findings that affect planning

- **`package-lock.json` is out of sync on this branch:** `npm ci` fails ("Missing: @agent-control-stack/local-advisor-mcp from lock file"). `npm install` adds the 4-line workspace entry. I reverted that edit, so the tree is clean. PR 1 will need the lock fixed in a **separate, first commit**.
- **There is no JSON read model for the dashboard.** The gateway builds a typed `MissionControlViewModel` (`dashboard-routes.ts` `missionControlViewModel(request)`) but only emits it as HTML (`/`) or HTML fragments (`/dashboard/fragments`). Existing JSON routes cover agents, executors, connectors, events and work-item detail, but not the composed overview. **This is the single backend addition the migration requires.**
- The verifier needs Playwright; it is not a repo dependency. It was run via the main checkout's `playwright-core` plus the cached Chromium (`ACS_PLAYWRIGHT_MODULE`, `ACS_BROWSER_EXECUTABLE`).

Reproduce the baseline:

```bash
npm install --no-audit --no-fund && git checkout package-lock.json && npx tsc -b
ACS_PLAYWRIGHT_MODULE=<playwright-core>/index.mjs ACS_BROWSER_EXECUTABLE=<chrome> \
  ACS_UI_EVIDENCE_DIR=<out> node scripts/verify-mission-control.mjs
```

PR 1 will add a committed `scripts/capture-mission-control-baseline.mjs` (all pages × desktop/mobile × light/dark) so before/after comparisons are repeatable.

## 3. Architecture

### 3.1 Units and boundaries

```
packages/mission-control-contract   zod schemas + types for the read model (no Node/DOM deps)
apps/control-ui/src/read-model/     server: MissionControlViewModel -> OverviewReadModel (pure, tested)
apps/gateway  (dashboard-routes)    GET /api/mission-control/overview  (auth: requireRead, no-store)
                                    static hosting for the SPA under /next/ (flag-gated)
apps/mission-control-web            Vite + React + Tailwind SPA (new workspace)
  src/design/                       tokens, theme, primitives
  src/shell/                        app shell, nav, status bar, command palette
  src/data/                         api client, schema validation, SSE hook, query cache
  src/features/command/             Command overview (PR 1)
  src/features/<page>/              later PRs, one per legacy page
apps/control-ui (legacy)            unchanged, remains the default at /
```

Each unit has one purpose and a narrow interface:

- **Contract package**: the only thing the server mapper and the client share. The client **validates every response against the schema**; a failed parse yields the `unavailable` state, never a partial render.
- **Mapper** (`toOverviewReadModel(model)`): pure function over the *same* `MissionControlViewModel` the legacy page renders from. No second domain model, no new store queries beyond what the legacy page already performs. It whitelists fields: lease projections use `toMissionControlAttemptLease` (already strips `tokenHash`); `target.cwd` and any host path is excluded; text fields pass through the existing redaction/bounding helpers (`redaction.ts`).
- **SPA** talks to the gateway only through `src/data/`, so views never touch `fetch`/`EventSource` directly (matches the `acs-dashboard-spec` "replaceable API client boundary").

### 3.2 Stack

React 19 and Vite 6 are already in the repo (`apps/public-site`, locked at 19.3.0 / ^6.4.4). New dependencies requiring your approval:

| Dependency | Why | Notes |
|---|---|---|
| `tailwindcss` (+ Vite plugin) | utility styling over CSS-variable tokens | tokens remain plain CSS variables so themes are not Tailwind-coupled |
| `@tanstack/react-query` | cache, staleness, refetch-on-event | small; alternative is a hand-rolled store, which I recommend against |
| `react-router` | hash routes mirroring legacy `/#queue` URLs | keeps deep links identical during migration |
| `@testing-library/react` + `jsdom` | component tests under existing vitest | dev only |
| `d3-force` *(optional, decide in PR 2)* | agent network layout | PR 1 ships a deterministic layout with no dependency; see 4.2 |

Charts are hand-written SVG (hourly telemetry is 24 points). No chart library. No UI-kit dependency; primitives are ours.

### 3.3 Design system (PR 1)

- **Tokens**: CSS variables for colour, type scale, spacing, radii, elevation, motion; dark default, light via `[data-theme]` honouring `prefers-color-scheme` and persisted choice (guarded storage access). Status colours always paired with text/icon, never colour alone.
- **Primitives**: `Card`, `Stat`, `StatusPill`, `DataTable`, `Drawer`, `Timeline`, `Sparkline`, `EmptyState`, `Skeleton`, `StaleBanner`, `Kbd`, `IdChip` (abbreviates `wrk_…` hashes/IDs, copyable, full value on hover/focus).
- **States are first-class**: loading skeleton, empty, `stale` (SSE lost), `unavailable`, `error`, `unknown`. Every primitive that shows data accepts them.
- **Motion**: transitions on live updates; everything respects `prefers-reduced-motion`.
- **Accessibility floor**: WCAG 2.2 AA including contrast in both themes; keyboard-complete; skip links retained.

### 3.4 Shell (PR 1)

Left nav with all 11 destinations. Migrated pages route in-app; **unmigrated pages are real links to the legacy console** (`/#queue` etc.), so nothing disappears during migration. Top bar: global search placeholder scoped to loaded data (labelled as such, as in legacy), theme toggle, **execution-mode badge** (`strict` / `admin` / `unknown`, dry-run label from `executionBackend`), live/stale indicator. Command palette (Ctrl+K) navigates pages only in PR 1.

## 4. Command overview (PR 1, read-only)

Everything below is derived from existing view-model fields. A panel with no backing data says so.

### 4.1 Layout

1. **Needs you** strip: counts and first items for `needs_approval`, `blocked`, `quarantined`, and active leases near expiry (computed from `AttemptLease.expiresAt`, labelled "warning only"). Each links to the legacy Approvals/Queue page for action in PR 1.
2. **Agent network** (4.2), the signature element.
3. **Work pipeline** (mockup 04): columns from the existing `executionStage` mapping (`draft→Pending`, `pending_policy→Policy Check`, `needs_approval→Waiting Approval`, `approved`, `running`, `succeeded→Completed`, `failed`; blocked/cancelled/rejected/quarantined remain distinct). Cards show title and intent first; the ID is a secondary `IdChip`. Read-only.
4. **Observability** (mockup 05): 24-hour attempt throughput (succeeded/failed) from `executionTelemetry`, admission utilisation (labelled as global execution-slot usage), approval-grant latency where the telemetry provides it. No cost/CPU/memory tiles.
5. **Live activity**: audit events from the existing stream, bounded and redacted.
6. **System readiness**: from `readiness.checks`, unhealthy stays visible.

### 4.2 Interactive agent network

A graph of what ACS can prove, and only that.

- **Nodes**: registry agents (with heartbeat-derived liveness: online / stale / offline / observed), executors, connectors, and active work items.
- **Edges** exist only where a canonical binding exists: agent → work item via `currentWorkItemId` / assignment; work item → attempt → lease worker (`lease.workerId`, `fencingEpoch`); connector → active tunnel session. **No inferred or decorative edges.** A stale worker is never drawn as current owner after a newer fencing epoch (per `acs-dashboard-spec`).
- **Interaction**: hover/focus highlights a node's real neighbours; selection opens a drawer with the safe agent/work/lease summary; filter by liveness; pan/zoom. Live updates animate only state changes (liveness colour/pulse, new/removed edges).
- **Layout**: deterministic grouped layout in PR 1 (agents ring, executors/connectors lanes, work items by pipeline stage), no physics dependency, stable between refreshes so the view doesn't jump. A force layout is a PR 2 decision.
- **Accessibility**: the SVG is `aria-hidden` decoration over a **parallel, keyboard-navigable table/list** of the same nodes and edges. Reduced motion disables pulses.
- **Empty and unknown**: no agents → empty state; agents without heartbeat evidence render `unknown`, never `online`.

## 5. Data and transport contract

### 5.1 New endpoint

`GET /api/mission-control/overview` → `OverviewReadModel` (JSON), `requireRead`, `cache-control: no-store`.

- Built from `missionControlViewModel(request)`; no new store reads.
- Every response includes `generatedAt`, `eventSequence` (highest audit sequence included), `executionMode` (+ problem), `executionBackend`, and per-section `status: ok | unavailable` with a reason code, so partial backend problems are visible rather than silently empty.
- Additive only; schema is versioned (`schemaVersion: 1`).
- Unauthenticated → `401` JSON (the SPA shows its sign-in state; it never handles credentials itself, the existing login flow does).

### 5.2 Live updates (existing SSE contract unchanged)

The SPA opens the existing `GET /events` stream (same-origin, same auth, respects the per-principal connection cap). On any relevant event it invalidates the overview query; refetches are **coalesced** (same intent as the legacy scheduler). Connection loss → `stale` banner, last data retained but marked stale; reconnect uses the same exponential backoff (1,2,4,8,16,30 s) and refetches. No new polling loops. If the stream is at capacity (`503 sse_capacity_reached`) the SPA shows `stale`, not a spinner.

## 6. Migration plan (strangler)

### 6.1 Serving

The gateway serves the built SPA at **`/next/`** when `ACS_MC_WEB=1`, from the built `apps/mission-control-web/dist`. `/` is untouched and remains the legacy console. SPA responses carry a strict CSP (`default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'`), which the legacy inline-script page cannot adopt. That is itself a security gain.

### 6.2 Phasing

| PR | Scope |
|---|---|
| **0** | Fix `package-lock.json` (separate commit); add committed baseline-capture script; record the stale-verifier finding. |
| **1** | Contract package, mapper + endpoint, SPA scaffold, design system, shell, Command overview (4.1/4.2), flag-gated `/next/`. Read-only. |
| 2 | Work queue + work-item **execution trace** (request → plan → admission → approval → attempt → lease/fencing → workspace → result/audit). Read-only. |
| 3 | Approvals and Execution, including **mutations** through the existing authenticated routes with the existing confirmations. This is the first PR that touches authority-adjacent UI and gets a dedicated security review. |
| 4 | Agents, Executors, Connectors, plus force layout if warranted. |
| 5 | Metrics, Audit, Policy, System. |
| 6 | Make `/next/` the default for `/`; keep legacy at `/legacy/`. |
| 7 | Remove legacy only after one full release cycle with no rollback use. |

Each PR is independently shippable and independently revertible.

### 6.3 Rollback

- **Runtime:** unset `ACS_MC_WEB` (or, after PR 6, set a legacy-default flag). Legacy `/` never stopped working, so rollback is a config change plus restart, no code revert.
- **Code:** each PR is additive to the gateway (one route, one static mount), so `git revert` of a PR cannot affect legacy rendering.
- Legacy goldens, tests and the verifier stay green throughout; they are removed only in PR 7.

## 7. Security

- Mapper output is a **whitelist**, enforced by a test that fails if any field named `token*`, `secret*`, `password*`, `cwd`, `path` (outside an explicit safe-label allowlist) or a raw env map appears anywhere in a serialised read model built from a maximal fixture.
- Client schema validation rejects unexpected shapes; rendering uses React escaping only (no `dangerouslySetInnerHTML`; ESLint rule enforced).
- No credentials, tokens or tunnel material in client storage; storage use limited to theme choice, guarded with try/catch.
- Endpoint is read-only, authenticated, rate-limited like sibling reads; SSE cap behaviour unchanged.
- PR 3 (mutations) requires: confirmation flows equal to legacy, fencing/idempotency handled server-side as today, audit event per action, and review by `acs:acs-review` plus `security-auditor`.

## 8. Verification (every PR)

1. `npx tsc -b` and `vitest run` (including mapper whitelist, schema round-trip, fail-closed rendering, component tests).
2. Playwright e2e on the real ephemeral gateway with the real dry-run worker (same fixture as `verify-mission-control.mjs`): Command renders from real data; stream loss flips to `stale`; unauthenticated is rejected; legacy `/` still passes its 22 checks.
3. axe WCAG A/AA in **both themes** at four widths: zero violations (matches baseline).
4. Screenshots before/after at desktop/mobile × dark/light, committed as evidence.
5. Budgets: SPA JS ≤ 250 KB gzip initial; overview first meaningful render under the baseline's 46 ms live time plus network; no layout shift on live updates.
6. **Reproduce CI conditions:** run git-dependent tests with an empty `HOME`, and do a full `tsc -b` in a fresh worktree (known local-env masking).
7. Honest absence: a test per panel proving it renders `unavailable` when its section is `unavailable`, and that no number appears without a source field.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Two UIs diverge during migration | Both render from one `MissionControlViewModel`; mapper is pure and golden-tested against it |
| Visual ambition invents data | Section 1 rule 1 plus panel-level source mapping table in each PR description |
| Agent network misleads | Edges only from canonical bindings; parallel accessible table; unknown renders unknown |
| Dependency growth | Approval list in 3.2; charts and primitives hand-written |
| Concurrent sessions push to shared branches (see memory notes) | Fetch + ancestry check before pushing; never force |
| CodeQL/merge gate failing repo-wide | Report separately; do not mask |
| Lock file already inconsistent | PR 0 fixes it in isolation |

## 10. Decisions needed from you

1. **Approve** this architecture and the PR sequence (or amend it).
2. **Approve the new dependencies** in 3.2 (Tailwind, TanStack Query, React Router, Testing Library/jsdom).
3. **Serve path:** `/next/` behind `ACS_MC_WEB=1` (recommended), or another path or port.
4. **PR 0 lock fix:** OK to include `package-lock.json` as the first commit of this branch?

On approval the next step is a written implementation plan for PR 0 and PR 1.
