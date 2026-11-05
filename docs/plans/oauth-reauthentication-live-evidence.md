# Live client evidence and independent review results

Date 2026-10-18. Disposable lab only (`scripts/oauth-compat-lab.mjs`, loopback, generated secrets, short token lifetimes, `ACS_MCP_AUTH_EVENTS=1`). No production service, token or
personal account connector was touched. Clients used their own isolated config directories.

## Real clients tested

| Client                                                        | How                                    | Result                                                                                                                                                                                           |
| ------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Claude Code 2.1.302** (Anthropic's real MCP OAuth client)   | `claude mcp login` / `claude mcp list` | Full coverage below                                                                                                                                                                              |
| **OpenAI Codex CLI 0.163.0** (OpenAI's real MCP OAuth client) | `codex mcp login`                      | Login, consent, PKCE and reconnect only. `codex mcp list` does not contact the server and a runtime refresh needs a model session, which was not available.                                      |
| **ChatGPT web app, claude.ai connectors**                     | not run                                | **Blocker.** Adding a connector changes a personal account, which this mission excludes without separate authorization, and ChatGPT needs a public tunnel. Not substituted by the results above. |

Both real clients identify themselves with a fixed CIMD `client_id` (`https://claude.ai/oauth/claude-code-client-metadata`, `https://chatgpt.com/oauth/codex/client.json`), not a fresh dynamic registration.

## Scenarios, Claude Code (fixed build)

| Scenario                               | Observed                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Silent renewal                         | With a 120 s access lifetime, 4 `claude mcp list` processes run in parallel after expiry all refreshed (sequential `POST /token` 200s), reached `Connected`, and **no** refresh reuse or warning occurred. Claude Code refreshes proactively, so the "expired access token presented" path was not exercised by it (covered by tests). |
| Genuine refresh expiry, no user action | Idle client flagged **Reauthentication required / refresh_expired** by itself at the moment its refresh token expired. Claude Code then reports "Needs authentication".                                                                                                                                                                |
| Revocation                             | Marking the refresh record revoked: edge logged `refresh refused reason=revoked`, Mission Control flagged `revoked`, Claude Code reported "Needs authentication", with no manual disconnect.                                                                                                                                           |
| Outage                                 | Edge stopped: Claude Code reported `Failed to connect, ECONNREFUSED` (not "Needs authentication"); after restart `Connected`. Mission Control never flagged.                                                                                                                                                                           |
| Reconnect                              | `claude mcp login` again with the **same** `client_id`: flag cleared by itself.                                                                                                                                                                                                                                                        |
| Idle within lifetime                   | Never flagged.                                                                                                                                                                                                                                                                                                                         |

Codex: same expiry and reconnect behaviour for an idle client (flagged exactly at refresh expiry, cleared on `codex mcp login`, same `client_id`).

## Dismiss action (conditional requirement)

Condition: "compatibility testing confirms that reconnecting creates a new client identity and leaves stale alerts". **Not confirmed**: both real clients reconnect with the same `client_id` and the alert clears. The dismiss mechanism was therefore **not implemented**. The ChatGPT web app and claude.ai could still behave differently; that remains unverified.

## Independent security review (round 1, separate agent, adversarial, with PoCs)

No CRITICAL, no HIGH. All MEDIUM/LOW findings resolved in `3b4fee08` and `116528e2` with regression tests:

| ID   | Sev  | Finding                                                                                                       | Resolution                                                                                                                                                             |
| ---- | ---- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-1  | MED  | Double-submitted refresh false-flagged a working client                                                       | Refresh within 10 s of rotation is refused as `refresh_superseded`, not reported; ACS orders events by edge-observed time (a late failure cannot undo a newer success) |
| F-2  | MED  | CLI wrote a stale "reauth required" over another process's fresh credential                                   | Compare-and-swap before persisting a verdict                                                                                                                           |
| F-3  | MED  | Ingress mapped JWKS 5xx / HTML to 401 `invalid_token`                                                         | Only token-judgement jose errors are 401; everything else is 503                                                                                                       |
| F-4  | LOW  | Replay of an old token left no trace                                                                          | Every refresh refusal is logged (reason, lane, client; never a token) regardless of the flag                                                                           |
| F-5  | LOW  | Refresh skipped client authentication when the local client record was gone                                   | Refused (CIMD https ids excepted: they carry no secret)                                                                                                                |
| F-6  | LOW  | A stranger with a leaked token could flag the real client via `invalid_client`                                | `invalid_client`, `client_mismatch`, `refresh_superseded` are never reported                                                                                           |
| F-7  | LOW  | `saveJson` tmp handling (symlink, leftovers, no dir fsync)                                                    | stale tmp removed, `wx` open, `fchmod`, cleanup on error, directory fsync                                                                                              |
| F-8  | LOW  | Unauthenticated `/register` flood amplified by fsync                                                          | 60 registrations/min cap, 429                                                                                                                                          |
| F-9  | LOW  | An auth event can make an unseen client `live`                                                                | Accepted: cosmetic, bridge-credential only                                                                                                                             |
| F-10 | INFO | Failure ordering                                                                                              | Fixed with F-1                                                                                                                                                         |
| F-11 | INFO | Plaintext refresh-token keys, no pruning, non-constant-time secret compare on code exchange, uncapped lab TTL | Constant-time compare and TTL cap fixed; hashing/pruning are credential-storage migrations and are **not** done (out of scope)                                         |

A second review round was not run because round 1 produced no critical or high findings; the fixes are covered by tests, including mutation-checked regression tests.
