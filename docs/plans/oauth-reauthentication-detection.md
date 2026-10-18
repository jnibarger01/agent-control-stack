# Plan: automatic OAuth reauthentication detection for Jace Commander

Status: **implemented in isolation on this branch; not deployed, not enabled; merge, deployment and flags NOT approved.** See the [readiness report](oauth-reauthentication-detection-readiness.md) and [security review](oauth-reauthentication-security-review.md). Date: 2026-10-17.
Design record: [ADR 0027](../adr/0027-oauth-reauthentication-detection.md). Baseline failures: [baseline](oauth-reauthentication-detection-baseline.md).

## Decisions (operator, 2026-10-17)

1. Implement around existing baseline failures; document each with its exit code; fix a baseline blocker only if it blocks verification (none did).
2. **Rotation stays strict.** No blanket grace window (RFC 9700). The interim opt-in cached-response retry was removed on 2026-10-18 because it stored live tokens at rest.
3. `ACS_MCP_AUTH_EVENTS` is default off and gates only the edge's reports to ACS. OAuth correctness (challenges, classification, 503 for outages) is not behind it.
4. Acceptance: a real expired or revoked connection must show a reauthentication requirement without the user disconnecting first; outages, idle sessions and
   expired-but-refreshable access tokens must never warn.
5. No production deployment, token-policy relaxation or live credential change until the security tests pass and the operator approves activation.

## What is verified, and what is not

Verified by automated tests (all green except the 9 pre-existing baseline cases):
a protocol-faithful stand-in client against the real edge process and real ACS gateway (`apps/gateway/src/mcp-auth-e2e.test.ts`): revoked/expired and reused
refresh tokens surface as "Reauthentication required" with no manual disconnect; expired-but-refreshable access tokens, idle clients, an ACS outage and
the flag-off default produce no warning; a real expiry becomes visible on its own.

**Not verified:** behaviour of the real ChatGPT and Claude apps. The tests encode the documented OAuth client behaviour (refresh on `401 invalid_token`,
reauthorize when refresh fails); whether each app actually does so, and how its UI reacts, needs the isolated live check in the runbook
(`docs/runbooks/mcp-client-visibility.md`, "Activation gates"). That is a required gate, and it is not done.

## 1. What the code does today

The authorization server and the resource server for the Commander lanes are the **same process**: the edge,
`apps/dc-mcp-gateway/server.js`. It is not Supabase and not the Vercel ingress for these lanes.

| Piece                          | Where                                                     | Today                                                                                                                                                                       |
| ------------------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token issue / refresh          | `server.js` `issueTokens`, `handleToken`                  | HS256 access token (1 h), rotated refresh token (30 d) in `tokens.json`. A used refresh token is flipped `active:false`. Every refresh failure is the same `invalid_grant`. |
| Bearer check                   | `server.js` `checkAuth` / `verifyJwt`                     | Returns `null` for missing, malformed, forged, **expired**, wrong issuer and wrong audience alike.                                                                          |
| 401 challenge                  | `server.js` `CHALLENGE()` / `JC_CHALLENGE()`              | `Bearer resource_metadata=…, scope="mcp"` with **no `error`**, always.                                                                                                      |
| Client tracking                | `apps/gateway/src/mcp-clients.ts` `McpClientService`      | Audit-log-backed index keyed by verified `client_id`. Tracks seen/labelled/issued/denied. **No auth health.**                                                               |
| Edge → ACS reporting           | `client-attribution.js`, `POST /mcp-clients/observe`      | Fire-and-forget, bridge-credential, lane-scoped. Only `initialize` / `tools/list`.                                                                                          |
| Mission Control                | `apps/control-ui/src/mcp-clients.ts`                      | Connectors-page table + global alert. Fed by `GET /api/mcp-clients` and SSE `mcp_client.*` events.                                                                          |
| Vercel ingress (DC `/api/mcp`) | `apps/vercel-mcp-ingress/src/oauth.ts`, `handler.ts`      | **Every** verifier error, including a JWKS fetch timeout, becomes `401 invalid_token`.                                                                                      |
| JC CLI                         | `vendor/desktop-commander/src/jace-commander/mcp-auth.ts` | `mcpAccessToken` refreshes, but any failure (network or `invalid_grant`) returns `undefined`; the CLI says "run connect again".                                             |

### Gaps against the requirements

1. No per-client auth state at all.
2. Refresh works for the CLI and the edge issues rotated refresh tokens, but **ChatGPT/Claude hold their own
   refresh tokens**. ACS can never refresh on their behalf. What ACS can do is (a) make refresh succeed whenever it
   legitimately can and (b) tell the client, with a correct 401, that it should refresh or reconnect.
3. All edge failures collapse into one `invalid_grant` / one challenge; nothing records _why_.
4. The challenge lacks `error="invalid_token"` for presented-but-unusable tokens (RFC 6750 §3.1), so compliant
   clients that key off it may not refresh/re-authorize. The ingress also turns outages into 401s, which would make
   a healthy client reauthenticate for no reason.
5. Nothing in Mission Control.
6. Refresh-token rotation is strict: if the response to a refresh is lost (dropped connection), the retry hits an
   inactive token and the client is permanently locked out. That is the exact "network drop looks like expired auth"
   failure the requirements warn about.

## 2. Design (reuse, no new connection manager)

One new signal path, riding the existing one: **edge → `POST /mcp-clients/auth-event` → `McpClientService` →
audit log → `/api/mcp-clients` → Mission Control.** `McpClientService` gains an `auth` facet per client; no new
service, store, or table (state is rebuilt from the audit log at startup, like labels).

### 2.1 Edge (`apps/dc-mcp-gateway`)

New `auth-health.js` (pure, unit-testable; `server.js` has import-time side effects):

- `classifyBearer(header, {signingKey, issuer, resource, nowSec})` →
  `ok | missing | malformed | bad_signature | expired | wrong_issuer | wrong_audience`.
  `clientId`/`subject` are returned **only when the signature verified**; a forged token is never attributed.
- `bearerChallenge(base, reason)`: `missing` → unchanged (no `error`, so clients start a fresh sign-in); every other
  reason → `…, error="invalid_token", error_description="…"`. Never echoes token material.
- `resolveRefresh(records, token, nowSec, {clientSecret, presentedSecret, presentedClientId})` → `ok{record}` or
  `refresh_unknown | refresh_expired | revoked | invalid_client | client_mismatch | refresh_superseded | refresh_reused`. Confidential clients must authenticate on
  refresh (RFC 6749 §6) and a token is bound to its client. **Rotation is strict; there is no retry or cache.** A lost refresh response means reconnecting.
- `server.js` changes: use these in `checkAuth`/`handleToken`; set the richer challenge; emit auth events.

Auth-event reporter: a sibling of `createClientObserver` (same injected `post`, 1.5 s timeout, bounded, never throws,
never delays or fails a request). If ACS is unreachable the event is dropped, which can only _under_-report. It can
never create a false "reauth required".

Events (`kind`): `granted` (code exchange; carries `refreshExpiresAt`), `refreshed`, `refresh_failed{reason}`,
`token_rejected{reason}`, `revoked`.

### 2.2 ACS gateway (`apps/gateway`)

- `POST /mcp-clients/auth-event`: same guards as `/mcp-clients/observe` (bridge identity, lane match, rate limit,
  strict zod schema, added to `public-contracts.ts` + regenerated baseline). Attribution only: it never labels,
  approves, or lifts `require_label`.
- `McpClientService.recordAuthEvent()` writes one audit event `mcp_client.auth_event`; `ingestEvent`/`hydrate`
  fold it into `ClientState.auth`. Add the name to `MCP_CLIENT_EVENT_NAMES` in the UI so SSE refreshes the panel.
- `McpClientView.auth = {state: "ok"|"reauth_required", lastSuccessAt?, lastFailureAt?, failureReason?}`;
  `summary().reauthRequired`.

State rules (this is requirement 6, and it is tested):

| Signal                                                                                                           | Effect on `auth.state`                     |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `granted` / `refreshed`                                                                                          | → `ok`, set `lastSuccessAt`, clear failure |
| `refresh_failed` permanent: `refresh_rejected`, `refresh_expired`, `refresh_reused`, `revoked`, `invalid_client` | → `reauth_required`                        |
| `refresh_failed` transient: `temporarily_unavailable`                                                            | no change                                  |
| `token_rejected: access_token_expired`                                                                           | no change (renewable)                      |
| Refresh token passed `refreshExpiresAt` with no later success (derived at read time)                             | → `reauth_required` / `refresh_expired`    |
| `insufficient_scope`, `mcp_client_unlabelled` (403)                                                              | no change, not an auth failure             |
| `bad_signature` / `malformed`                                                                                    | not recorded (cannot be attributed)        |
| Inactivity, edge or ACS downtime, dropped connection                                                             | no event, so no change                     |

Inactivity is deliberately _not_ an input: a client idle for 20 days with a valid refresh token stays `ok`.

### 2.3 Vercel ingress (`apps/vercel-mcp-ingress`)

`createOauthBearerAuthorizer` classifies verifier errors: `JWTExpired` → 401 with
`error="invalid_token", error_description="…expired"`; signature/claim/format errors → 401 `invalid_token`;
`JWKSTimeout`, network and unknown errors → **503 + `Retry-After`, no `WWW-Authenticate`**. `IngressAuthResult`
gains `status?: 401 | 503` and `retryAfterSeconds?`. Missing credential stays a bare discovery challenge.

### 2.4 Mission Control (`apps/control-ui`)

- Row: `Reauthentication required` pill, client label/kind, _last successful authentication_, plain-language reason
  (`refresh_reused` → "refresh token was already used"), **Reconnect** button (`data-mcp-reconnect`).
- Global alert (`#mcp-client-alert`) also fires for reauth-required clients **regardless of liveness** (an expired
  client is by definition not live).
- **Reconnect is guidance, not magic.** OAuth must be completed by the client (its redirect URI and PKCE verifier are
  its own), so ACS cannot start it for ChatGPT/Claude. The dialog gives per-kind steps and the MCP URL
  (ChatGPT: Settings → Connectors → reconnect; Claude: Settings → Connectors → reconnect; JC CLI:
  `jace-commander connect`). It makes no POST. When the client completes the flow a `granted` event arrives and the
  row clears itself.

### 2.5 JC CLI (`vendor/desktop-commander/.../mcp-auth.ts`) — second slice

`mcpAccessToken` returns a typed outcome: `token | reauth_required{reason} | unavailable`. HTTP 400/401 with
`invalid_grant`/`invalid_client` is permanent: drop the dead refresh token and persist `reauthRequired` so
`mcp-http-client.ts` can say "run `jace-commander connect`" instead of retrying. Network error / timeout / 5xx
keeps the token and reports `unavailable`. The existing single-flight refresh is kept. Vendor code, so kept as a
separate, reviewable commit.

## 3. Tests (written first; currently red)

| File                                                                        | Covers requirement                                                                                    |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `apps/dc-mcp-gateway/test/auth-health.test.mjs` (`node --test`)             | 3, 4, 6: classification, challenges, no attribution of forged tokens, refresh reasons, rotation grace |
| `apps/gateway/src/mcp-client-auth-health.test.ts`                           | 1, 2, 3, 6: per-client state machine, recovery, inactivity, restart rebuild, no token material        |
| `apps/gateway/src/mcp-clients.test.ts` (new describe)                       | 1, 5, 6: route auth, lane mismatch, strict schema, no label/gate side effects                         |
| `apps/vercel-mcp-ingress/src/oauth-failures.test.ts`                        | 4, 6: expired → 401 invalid_token; JWKS/network → 503 not 401; bridge down → 502                      |
| `apps/control-ui/src/mcp-clients.test.ts` (new describe)                    | 5: pill, last auth, reason, Reconnect, alert, escaping, no POST                                       |
| _(slice 2)_ `vendor/desktop-commander/test/test-jace-commander-mcp-auth.js` | 2, 3, 6: permanent vs transient refresh outcome. Spec above; written with the slice.                  |

All tests are now green (see "What is verified"). Added since the first draft: `apps/dc-mcp-gateway/test/auth-health-edge.test.mjs` (real edge process),
`apps/gateway/src/mcp-auth-e2e.test.ts` (edge + ACS + Mission Control feed), `vendor/desktop-commander/test/test-jace-commander-mcp-auth.js`.

**Pre-existing, unrelated:** 9 of 23 tests in the unmodified `apps/gateway/src/mcp-clients.test.ts` already fail on
this worktree (capability issue returns 500), and `tsc -b` reports unrelated `actor-router` errors
(`RouteEnrichment` etc. missing from `work-items`). The route tests in the new describe that depend on that harness
may inherit it; I have not investigated further. Needs a decision before implementation (see §5).

## 4. Order and safety

1. `auth-health.js` + edge wiring (flagged `ACS_MCP_AUTH_EVENTS=1`, default off) — greens edge tests.
2. Gateway service + route + contract baseline — greens gateway tests.
3. Ingress classification — greens ingress tests.
4. Mission Control — greens UI tests.
5. JC CLI slice.
6. `docs/oauth-authentication.md`, ADR 0027, runbook note in `docs/runbooks/mcp-client-visibility.md`.

Safety: all development in this worktree against test doubles; nothing touches the live edge, `tokens.json`,
or any deployed service. The only behavior change visible to clients on rollout is the `error="invalid_token"`
parameter, the 503 for verifier outages, and the rotation grace. Each is independently revertible. Rotation grace is
a small security relaxation (a stolen-and-replayed token works for 30 s); the mitigation is that it only re-issues to
the same `client_id`, and reuse after the window is reported as `refresh_reused`.

## 5. Remaining before activation

1. Isolated live check with ChatGPT and Claude (runbook, "Activation gates").
2. Independent security review (see the review doc).
3. Operator approval to set `ACS_MCP_AUTH_EVENTS=1` on the production edge. Deploying the edge also ships the always-on changes
   (`error="invalid_token"`, refresh client authentication); a confidential client that does not send its secret on refresh will start getting `invalid_client`.
4. Out of scope, noted: the Vercel ingress is stateless and reports no health; there is no operator revoke endpoint; the baseline failures.
