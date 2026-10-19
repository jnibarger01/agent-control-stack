# Mission Control Web (React) runbook

The operator console is a React + Vite + Tailwind app (`apps/mission-control-web`) served by the gateway.
The classic server-rendered console is still shipped and is the rollback path.

## Flags

| Variable | Effect |
| --- | --- |
| `ACS_MC_WEB=1` | Serve the React app at `/next/`. Off by default. `/` is unchanged (classic console). |
| `ACS_MC_WEB_DEFAULT=1` | Also make the React app the default: an authenticated `GET /` redirects to `/next/`. Ignored unless `ACS_MC_WEB=1` **and** `apps/mission-control-web/dist/index.html` exists (fail-closed: a missing build keeps `/` on the classic console, never a 503 redirect). |

The classic console is always reachable at `/legacy`, whatever the flags say.

## Build

`npm run build` builds the app (`apps/mission-control-web/dist`) with the rest of the workspace. The gateway reads `dist` at request time, so a rebuild needs no restart.

## Roll out

1. Deploy with `ACS_MC_WEB=1`. Verify `/next/`.
2. Add `ACS_MC_WEB_DEFAULT=1`. `/` now opens the React app; `/legacy` is the classic console.

## Roll back

Unset `ACS_MC_WEB_DEFAULT` (and restart) to put the classic console back at `/`. Unset `ACS_MC_WEB` to turn the React app off entirely. No code revert and no backend change is involved: the React app only adds read routes under `/api/mission-control/*` and uses the existing authenticated mutation routes unchanged.

## What the app can and cannot do

- Read routes: `GET /api/mission-control/{overview,queue,approvals,execution,audit,work-items/:id/trace}` plus the existing `/api/agents|executors|connectors` routes. All require read access, are `no-store`, and are rate limited together with the other costly reads.
- Writes: approve, deny, unblock, cancel and retry call the existing routes (`/work-items/:id/approve|reject|unblock|cancel|retry`). The browser never grants authority. The gateway re-checks credential, role, scope, policy and state on every request. `viewer.canApprove` / `canWrite` only decide whether a control is offered.
- Cookie-authenticated writes from a browser that declares the request is not same-origin (`Sec-Fetch-Site` / `Origin`) are refused with `403 csrf_origin_mismatch`. Bearer-token clients are unaffected.
- The app is served with a strict CSP (`script-src 'self'`, no inline script) and never injects raw HTML.

## Verifying a deployment

```bash
npm run build
ACS_PLAYWRIGHT_MODULE=<path to playwright module> ACS_UI_EVIDENCE_DIR=/abs/out npm run test:mission-control-web-e2e
```

The harness starts an ephemeral gateway with a real dry-run worker and checks every page in both themes at four widths (axe WCAG 2.2 A/AA), live SSE refresh, real approve/deny, a read-only credential, cookie-only sessions, the login flow, fail-closed behaviour and stream loss.

## Retiring the classic console (not done yet)

The classic console is only removed after **one full release cycle with no rollback use**. Evidence:

- `acs_mc_legacy_console_requests_total{route="/legacy"}` (and `route="/"` while the classic console is the default) in `/metrics`. The release cycle must end with this counter flat, apart from deliberate comparison checks.
- `ACS_MC_WEB_DEFAULT=1` has been the production setting for the whole cycle.
- `npm run test:mission-control-web-e2e` passes on the release candidate.

Removal then consists of deleting the classic renderer and its client script from `apps/control-ui` (`render/`, `client-script.ts`, `styles.ts`, `premium-styles.ts` and the panel modules), the `/legacy` and `/dashboard/*` routes, the goldens and `scripts/verify-mission-control.mjs`, while keeping `apps/control-ui/src/read-model/*`, `redaction.ts` and the types the mappers use. Removing it also removes the rollback path, so make it a separate, explicitly approved change.
