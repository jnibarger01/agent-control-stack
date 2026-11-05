# Security review: refresh-token handling and reauthentication reporting

Scope: `apps/dc-mcp-gateway/server.js` refresh/authorize/token paths, `auth-health.js`, `POST /mcp-clients/auth-event`, the Vercel ingress
classification, the JC CLI token code. Date 2026-10-17. Reviewer: the implementing agent (self-review; an independent review is still advisable
before activation). Evidence is the named test, run against the real edge process, not a reading of the code alone.

Verdict: **no weakening of authentication found after the fixes below. The idempotent retry was REMOVED (2026-10-18).**

## Requested checks

| Check                                   | Result                                                                                                                                                                                                                                                                                                                  | Evidence                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Client-secret binding                   | **Pass.** A confidential client must present its own secret to refresh; compared with `timingSafeEqual` over SHA-256 digests. Another client's secret does not help.                                                                                                                                                    | `security: holding another client's secret…`, `a confidential client must authenticate to refresh` |
| Token bound to its client               | **Was a gap, fixed.** The old and first-draft code redeemed a refresh token for whatever `client_id` was presented. A mismatched `client_id` is now refused, unattributed, and does not consume the token (so it cannot be used to flag or lock out the real client).                                                   | `security: a refresh token is bound to the client it was issued to`                                |
| Replay protection                       | **Pass, strict rotation unchanged by default.** A used token is refused; the successor stays valid.                                                                                                                                                                                                                     | `strict rotation by default…`, `…does not revoke the successor on reuse`                           |
| Atomic rotation                         | **Pass in-process.** There is no `await` between the validity check and `active=false`; 12 parallel redemptions of one token yield exactly one success and one live successor. **Limit:** this holds for one edge process. Two instances sharing one `tokens.json` could race. The deployment runs a single instance.   | `rotation is atomic…`                                                                              |
| File permissions / durability           | **Was a gap, fixed.** `writeFileSync(..., {mode:0o600})` only applies when the file is created and a crash mid-write truncates `tokens.json`, which silently forgets every refresh token (all clients forced to reconnect). Writes are now temp file (0600) + fsync + rename. A save tightens a pre-existing 0644 file. | `tokens.json is private (0600), replaced atomically…`                                              |
| Do cached responses expose credentials? | **Yes, so the feature was deleted.** It stored a live access JWT and successor refresh token in `tokens.json`. No response is persisted any more.                                                                                                                                                                       | `the removed retry flag is inert…`                                                                 |
| Credential leakage in logs and reports  | **Pass.** Neither the edge logs nor the reports to ACS contain access tokens, refresh tokens, client secrets or bearer values, on success or failure.                                                                                                                                                                   | `no token or secret ever reaches the logs…`                                                        |
| Prototype keys                          | **Fixed.** `__proto__`, `constructor` etc. no longer resolve as refresh records (own-property lookup). Previously harmless, now explicit.                                                                                                                                                                               | `prototype keys are not refresh tokens`                                                            |

## Other findings fixed during review

- Reports of `wrong_audience` / `wrong_issuer` rejections were sent to ACS and rejected by its schema (log noise). Only `expired` is reported now.
- A **stale duplicate refresh** (an app that double-submits, while it already uses the successor) would have flagged a working client.
  The edge now classifies it `refresh_superseded` (refused, not reported) when the successor has itself been used.
- The first draft's blanket grace window was removed (decision of 2026-10-17); see ADR 0027.
- Test-only TTL overrides exist only for the lab and require `EDGE_TEST_MODE=1`; the edge warns loudly on startup when set.

## Residual risks (not fixed here)

1. **Reuse ambiguity.** If the successor is still unused, a reused token could be a duplicate request, a client that lost the response, or a replay
   by a thief. All three show "Reauthentication required". The first is a possible false alert; whether ChatGPT/Claude double-submit refreshes is
   exactly what the live check must record.
2. A thief who holds a used refresh token can make Mission Control show a reauthentication warning for the victim (cosmetic; equals detection by design).
3. No refresh-token **family revocation** on reuse (RFC 9700 allows it). Not added: it would turn a replay by anyone into a forced outage for the real client.
4. Refresh tokens are plaintext at rest; `loadJson` resets to `{}` if `tokens.json` is corrupt (mass reauthentication). Pre-existing.
5. No operator revoke endpoint; `revoked` is only reported if a record is marked revoked by other means.
6. Access tokens are HS256 with one symmetric key; `sub` is the constant `jacen`. Pre-existing single-owner design.
7. A client that registered as confidential but never sends its secret on refresh already fails at the code exchange (the same check exists there), so
   enforcing it on refresh adds no new failure for working clients. A client that sends the secret at exchange but omits it on refresh (an RFC violation) would break.

## What the reporting path can and cannot do

`POST /mcp-clients/auth-event` needs the lane's bridge credential, rejects the other lane, uses a strict closed-vocabulary schema, is rate limited, and
is attribution-only: it cannot label, approve, issue, or lift `require_label`. A forged or unauthenticated caller cannot create an event. A failed or slow
report from the edge is dropped and never changes an authentication decision.
