# ADR 0027: Automatic OAuth reauthentication detection on the Commander edge lanes

## Status

Accepted for isolated implementation. **Not enabled in production.** Activation needs the gates in the runbook and an explicit operator approval.

## Context

ChatGPT, Claude and other MCP clients reach ACS through the edge (`apps/dc-mcp-gateway`), which is both the OAuth
authorization server and the token verifier for `/jc/mcp` and `/mcp`. When a client's authorization expired or was revoked
the operator had no signal and had to disconnect and reconnect by hand. The edge also collapsed every failure into one
`invalid_grant` and an `error`-less 401, and the Vercel ingress turned verifier outages into 401s.

## Decision

1. **The edge decides, ACS records, Mission Control shows.** The edge classifies why a credential was refused and reports
   outcomes to `POST /mcp-clients/auth-event` (bridge identity, lane-scoped, strict schema, rate limited). `McpClientService`
   keeps a per-client `auth` state rebuilt from the audit log. No new service or table.
2. **"Reauthentication required" means authorization is gone.** It is set by a permanent refresh failure
   (`refresh_rejected`, `refresh_expired`, `refresh_reused`, `revoked`, `invalid_client`) or by a refresh token that has
   expired with no renewal. It is never set by inactivity, edge or ACS downtime, a dropped connection, an expired but
   refreshable access token, `insufficient_scope`, or a token that cannot be attributed (bad signature, malformed).
   A later `granted`/`refreshed` event clears it.
3. **Standards-compliant challenges are always on** (not behind a flag): no credential gets a bare `Bearer resource_metadata=…`
   challenge; a presented-but-unusable token gets `error="invalid_token"` (RFC 6750 section 3.1) with fixed description text.
   `insufficient_scope` stays a 403. The Vercel ingress returns 401 `invalid_token` only when the verifier reached a verdict;
   key-fetch timeouts, network errors and unexpected errors are 503 + `Retry-After` with no challenge.
4. **Strict refresh-token rotation is unchanged by default.** A client holding a refresh token cannot be refreshed by
   ACS; ChatGPT/Claude refresh themselves. The edge now authenticates confidential clients on refresh (RFC 6749 section 6).
5. **Rotation stays strict; the cached-response retry was removed.** A blanket grace window that accepts a used refresh token was rejected: it
   weakens replay detection (RFC 9700). An opt-in idempotent retry that re-served the original response to confidential clients was built, and then
   deleted on review because it persisted a live access JWT and successor refresh token in `tokens.json`. A used refresh token is never accepted again, and
   no token response is ever stored. A client that loses a refresh response must reconnect; that is the accepted cost of strict rotation.
6. **Reporting is gated, correctness is not.** Only the edge's reports to ACS are behind `ACS_MCP_AUTH_EVENTS` (default
   off). A failed or slow report drops the event and never changes a response, so it can under-report but never invent a warning.
7. **Reconnect is guidance.** OAuth must be completed by the client (its redirect URI and PKCE verifier), so Mission Control
   shows per-client steps and sends nothing. The row clears itself when the client signs in.
8. **JC CLI** distinguishes `reauth_required` (permanent `invalid_grant`/`invalid_client`, remembered, dead refresh token
   dropped) from `unavailable` (network, timeout, 5xx), which keeps the credential.

9. **Hardening found in review** (always on): a refresh token is bound to its `client_id`, `tokens.json` is written atomically with mode 0600,
   prototype keys are not tokens, and a refresh of a token whose successor is already in use is refused as `refresh_superseded` and not reported.
   Test-only token lifetimes need `EDGE_TEST_MODE=1`.

## Consequences

- Operators see which client needs to reconnect, why, and when it last authenticated, without disconnecting anything first.
- The Vercel ingress is stateless and reports nothing; it only classifies correctly. Health for that path is not tracked.
- There is no operator-facing revoke endpoint yet; `revoked` is reported if a token record is marked revoked.
- Events are windowed like other activity events at startup (20 pages x 1000); refresh-expiry state needs the last
  `granted`/`refreshed` event to still be in the retained log.
- Whether ChatGPT and Claude retry refresh or restart authorization on `invalid_token` is client behaviour and must be
  verified live (runbook), not assumed.
