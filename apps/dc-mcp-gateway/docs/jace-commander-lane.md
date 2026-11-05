> Native runtime update: the current implementation and managed deployment are documented in apps/jace-commander/README.md. Legacy vendor paths and offline-only verification descriptions below are historical and superseded.

# Jace Commander lane (`/jc/mcp`)

A second, ACS-managed MCP lane on the same Tailscale Funnel host, carrying
the Jace Commander MCP server
(`jnibarger01/desktop-commander` `dist/jace-commander/cli.js`,
`docs/jace-commander.md`).

```
ChatGPT/Claude ─► https://jacen-ubuntu.tailaa6d41.ts.net/jc/mcp
                    │ server.js: OAuth (audience …/jc/mcp) + ACS POST /jc/capability/issue
                    ▼
               bridge.js  BRIDGE_PROFILE=jace-commander  127.0.0.1:8003
                    ▼ stdio
               jace-commander serve   (verifies acs.jc.v1; privileged_exec → sudo -n → root helper)
```

## Guarantees

* **Opt-in, managed only.** The lane exists only with `JC_ENABLED=1`, which
  requires `ACS_GATEWAY_URL` and a **separate** `ACS_JC_GATEWAY_TOKEN` (the
  `acs-jc-bridge` ACS worker credential). If that token is missing or equal
  to `ACS_GATEWAY_TOKEN`, the gateway refuses to start. There is no
  unmanaged mode.
* **Audience separation (RFC 8707).**
  * Tokens are minted for exactly one resource: `…/mcp` or `…/jc/mcp`. A
    client selects jc by sending `resource=…/jc/mcp`, which it discovers from
    `/.well-known/oauth-protected-resource/jc/mcp` and the
    `WWW-Authenticate` challenge on `/jc/mcp`.
  * A token for one lane gets 401 on the other.
  * The consent page names the client, the requested resource, and the exact
    redirect destination. Approval is bound to a server-side transaction;
    the code is minted from that transaction, not from substitutable form
    fields. The page warns that the lane includes root commands.
  * A Jace Commander access token's `sub` is `jc-client:` plus the SHA-256
    of the authenticated `client_id`. The exact `client_id` stays in the
    token and in the ACS issue body. Desktop Commander tokens keep the
    owner subject. ACS will not reuse a JC approval across OAuth clients,
    even when those clients present the same actor.
* **Consent attempts are bounded.** `CONSENT_PASSPHRASE` must be 16 to 256
  characters, mix at least two character classes, and contain no whitespace
  or control characters. The gateway refuses to start otherwise. A failed
  attempt counts against the TCP peer, the OAuth client on the live
  server-side transaction, and a process-wide ceiling: 5 failures for a
  peer, 5 for a client, or 20 overall, then that bucket locks for 15
  minutes. Further attempts do not extend the lock, and a correct
  passphrase does not clear it early. Unknown transactions count against
  the peer and the global ceiling only; a posted `client_id` cannot aim
  that count at another client. The external client is the socket the
  public ingress accepted. That process stamps `x-jc-ingress-client` and
  `x-jc-ingress-proof`, an HMAC-SHA256 over `jc-ingress-v1:` plus the
  normalized IP, keyed by `JC_INGRESS_IDENTITY_KEY`. The gateway accepts
  the pair only from a loopback peer. `X-Forwarded-For`, `Forwarded`,
  `X-Real-IP`, a stamp without a valid proof, and a proof from any other
  address are rejected and charged to the TCP peer, not to the claimed
  address. A missing or unreadable lockout file fails closed. Counters
  live in `DATA_DIR/consent-lockout.json` and are updated under an
  exclusive lock, so they survive a restart and are shared by every
  gateway process using that directory. The file holds at most 1024
  source keys and 1024 client keys. A further identity increments an
  overflow bucket instead of taking a new slot. `EDGE_TEST_MODE=1` may
  shorten the lock with `EDGE_TEST_CONSENT_LOCKOUT_MS` (values below
  50 ms are ignored and the production duration is kept) and announces
  it. Failures are logged with a reason, a truncated client id, and a
  hashed source. Passphrases, tokens, transaction ids, request bodies,
  and the ingress key are not logged.
* **Capability transport.**
  * Every `tools/call` is authorized by ACS `POST /jc/capability/issue`
    before it is forwarded.
  * Client-supplied `_meta.acs*` and `_meta.capability` are stripped.
  * A single `tools/call` ACS refusal returns HTTP 200 with a JSON-RPC
    authorization error and nothing is forwarded. Initialize failures and
    rejected batched tool calls remain HTTP 503.
  * The DC upstream never sees jc traffic.
* **Human approval surfaced, not bypassed.** For `privileged_exec`, ACS
  answers 409 `require_approval`. The gateway returns HTTP 200 with JSON-RPC
  error `-32002` (`managed_authorization_required`) and carries
  `workItemId`, `actionHash`, and `approvalInstructions` in `error.data`.
  A human approves in ACS, then the client retries the identical call.
* **Bridge profile.**
  * `BRIDGE_PROFILE=jace-commander` requires `ACS_MANAGED_MODE=1` and
    `JC_ACS_PUBLIC_KEY`, `JC_ACS_KEY_ID`, `JC_RUNTIME_ID`, and
    `DC_GATEWAY_EXECUTION_TOKEN` (matching the edge `GATEWAY_EXECUTION_TOKEN`).
  * Every managed bridge `/mcp` request requires a valid gateway attestation
    before session creation or forwarding, including discovery, initialize,
    notifications and session GET/DELETE. Attestation never replaces ACS
    capability verification for `tools/call`.
  * Managed JC refuses conflicting `JC_PRESET` or `--preset` child authorizers
    at startup; local and standalone presets cannot satisfy managed readiness.
  * The child gets an explicit `JC_*` env allowlist (public key and
    endpoints only).
  * It never posts DC-shaped ACS results.

## Configuration

Gateway (`server.js`), in addition to the existing env:

| Env | Default |
| --- | --- |
| `JC_ENABLED` | unset (lane off) |
| `JC_RESOURCE` | `${PUBLIC_ORIGIN}/jc/mcp` |
| `JC_UPSTREAM` | `http://127.0.0.1:8003` |
| `ACS_JC_GATEWAY_TOKEN` | required when enabled; must differ from `ACS_GATEWAY_TOKEN` |

Bridge (`bridge.js`, second instance): see
`deploy/jace-commander-bridge.service.example`. `JC_DC_DIR` now defaults to
the monorepo's own `vendor/desktop-commander`, resolved relative to
`bridge.js`, not a legacy checkout. `GET /authority` reports
`runtime: {dir, entrypoint, monorepoDefault}` so you can see which build is
running. `JC_FS_ROOTS` / `JC_FS_DENIED_ROOTS` are forwarded to the child.

ACS: set `ACS_JACE_COMMANDER_CAPABILITY_PRIVATE_KEY`, `…_KEY_ID`,
`ACS_JACE_COMMANDER_RUNTIME_ID`, `ACS_JACE_COMMANDER_ALLOWED_ROOTS` (the
filesystem tools answer 503 `jace_commander_containment_unconfigured` without
it; use the same or narrower roots than the bridge's `JC_FS_ROOTS`), and a
worker credential whose actor id is `acs-jc-bridge`.

## Tests

`node --test test/jc-route.test.mjs` covers:

* startup refusals
* the disabled lane returning 404
* cross-audience 401s in both directions
* a full OAuth flow minting a jc-audience token
* the jc issue route and credential
* spoofed-meta stripping
* forwarding to the jc upstream only
* the approval challenge failing closed
* ACS being unreachable

It has been verified live against the real ACS gateway, the real bridge and
real `jace-commander serve` (see desktop-commander `docs/jace-commander.md`).

## Readiness

`GET /jc/ready` on the edge independently checks the JC lane, without probing
`UPSTREAM` (the primary DC bridge, normally port 8002). It requires JC enabled,
ACS issuance credentials and gateway attestation configured, ACS `/readyz`
reachable with a successful status, and `JC_UPSTREAM` reporting an initialized,
started managed JC bridge with capability verification and an execution token
configured. Missing or malformed authority assertions fail closed. Local or
ACS-optional configurations do not satisfy this managed readiness probe.

The response is HTTP 200 or 503 with only `ready`, `configured`, `bridgeReady`,
and `issuanceReady` booleans. Keys, tokens and capabilities are never returned.
The primary DC `/ready` contract is unchanged.
