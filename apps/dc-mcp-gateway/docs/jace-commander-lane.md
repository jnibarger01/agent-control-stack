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
  * The consent page names the requested resource and warns that it
    includes root commands.
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
    `JC_ACS_PUBLIC_KEY`, `JC_ACS_KEY_ID`, `JC_RUNTIME_ID`.
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
