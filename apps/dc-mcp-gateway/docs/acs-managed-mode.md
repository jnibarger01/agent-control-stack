# ACS managed mode for desktop-commander-mcp-gateway

Status: implemented on the gateway side against the contract in
`agent-control-stack/docs/protocol/acs-dc-v1-capability-contract.md` (`acs.dc.v1`).

## Authority model (normative)

1. **ACS is the sole capability issuer.** The gateway never mints, derives,
   widens, refreshes, or independently authorizes an `acs.dc.v1` capability.
   It requests an already-authorized capability from ACS per `tools/call` and
   transports it into `params._meta.acsCapability`. The ACS private signing
   key never reaches the gateway, bridge, Desktop Commander, Mission Router,
   or Codex Swarm processes.
2. **Forwarded identity is attribution, not authority.** The verified OAuth
   `sub`/`client_id` are forwarded to ACS as attribution metadata. They grant
   nothing by themselves; a spoofed or missing identity can never substitute
   for a valid capability, approval, lease, fencing epoch, or scope.
3. **Managed mode fails closed.** `ACS_MANAGED_MODE=1` requires a fully
   configured ACS integration or the process refuses to start. If ACS is
   unreachable, rejects, or returns a malformed envelope, the `tools/call` is
   not forwarded to Desktop Commander (HTTP 503 with the ACS failure code).
   There is no `--standalone` fallback on the managed path: in managed mode
   `bridge.js` strips `--standalone` from the Desktop Commander command line,
   so DC itself rejects ungoverned tool calls. The standalone bridge remains
   available only by running `bridge.js` without `ACS_MANAGED_MODE` (legacy
   deployment, not the managed gateway path).
4. **ACS approval is canonical.** Any `approvalId` inside a capability payload
   originates from ACS state; ACS consumes approvals transactionally at
   issuance. The gateway's OAuth consent passphrase remains pure UX for
   client registration and creates no second approval authority.
5. **Lease-safe lifecycle.** The multi-session bridge never recycles the
   canonical executor for normal downstream session creation. It invalidates
   sessions and replaces the upstream transport only after an actual upstream
   exit; `recycle-policy.js` remains a pure, tested policy helper for any
   future governed recovery path and never authorizes a mid-attempt kill.

## Required ACS endpoints (issuer side; contract)

The gateway is transport-only and depends on these ACS gateway endpoints
(NOT yet implemented — tracked as the remaining blocker):

- `POST /desktop-commander/capability/issue` — body
  `{toolName, arguments, identity:{subject, clientId}, requestId, strippedMetaKeys}`.
  ACS re-checks policy, normalized invocation, attempt/lease/fencing, runtime
  identity, scopes, and approval binding (exactly as
  `MachineDesktopCommanderExecutor.issueCapability` does today), persists the
  issuance, audits it, and returns `{ok:true, capability:{payload, signature, keyId}}`
  or `{ok:false, code}`. Capability lifetime must not exceed 30 seconds.
- `POST /desktop-commander/runtime/bootstrap` — issues the §7 bootstrap
  challenge for the managed runtime identity handshake.
- `POST /desktop-commander/runtime/attest` — registers the DC
  `acsRuntimeIdentity` echo (runtime registration/attestation).

The ACS signing path MUST reuse the existing in-repo implementation
(`prepareDesktopCommanderCapability` / `signPreparedDesktopCommanderCapability`
+ `SqliteDesktopCommanderRuntimeRegistry`); the ACS private key stays inside
the ACS process boundary.

## Gateway behavior (implemented)

- `managed.js`: config guard, ACS transport client, identity attribution,
  per-call capability transport. Client-supplied `_meta.acs*` metadata is
  always stripped before the ACS round-trip (anti-spoof) and the forwarded
  request carries only the ACS-issued envelope.
- `server.js` `ACS_MANAGED_MODE=1`: on each `tools/call`, request capability
  from ACS → inject → forward; any failure → 503 `{error:
  managed_authorization_unavailable, code}`, nothing reaches DC.
- `bridge.js` `ACS_MANAGED_MODE=1`: spawns DC without `--standalone` while
  preserving the multi-session router; `/healthz` remains the stable `ok`
  response for existing MCP health checks.

## Test evidence

`node --test test/managed.test.mjs` — 12/12 pass: spoofed `_meta` stripped and
replaced by the ACS envelope; fail-closed on ACS deny codes covering missing/
forged/expired capability, wrong scope, approval mismatch, attempt/lease/
fencing mismatch, stale/competing lease, nonce replay; fail-closed when ACS is
unreachable; managed mode refuses unconfigured startup; fresh capability per
call (no gateway replay/cache path); lease-safe recycle decisions.
