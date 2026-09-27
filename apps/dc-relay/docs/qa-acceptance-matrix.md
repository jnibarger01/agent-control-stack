> Historical record written while this code lived in the Desktop Commander
> fork (`src/control-plane`). Source paths were updated to `apps/dc-relay/src`;
> repository-level commands and line references describe that repository.

# Control-plane QA acceptance matrix

Verdict: PARTIAL — local vertical-slice tests and the repository unit suite pass, but release acceptance is blocked by an unconfigured device flow, no non-production Supabase environment for RLS/Realtime verification, and two inherited integration failures caused by missing managed runtime identity.

| Requirement | Evidence | Status |
|---|---|---|
| Ownership isolation | `test/test-control-plane.js` exercises a cross-user `getDevice` and expects `not_found`; scoped SQL selects and state-transition predicates bind rows to `auth.uid()` in `supabase/migrations/20260924204925_control_plane_v1.sql:39-40,46-47,55-56,64-69,76-79,87-89`. | PASS locally; hosted RLS unverified. |
| Presence beats stale metadata | Broadcast-capable devices use `PresenceReader` in `src/service.ts:61-69`; focused test changes Presence from true to false and observes online then offline. | PASS locally. |
| Absent Presence blocks dispatch | Shared `getDevice` / effective-state check precedes dispatch at `src/service.ts:104-110`; focused test expects `device_unavailable` when Presence is absent. | PASS locally. |
| Revocation | Resolver returns `revoked` before Presence and dispatch rejects non-online devices (`service.ts:61-69,104-110`); focused test verifies a fresh idempotency key cannot dispatch after revoke. | PASS locally. |
| Duplicate dispatch and claim exclusion | SQL unique constraint and conditional claim update are in migration lines 31 and 73-80; focused parallel dispatch/claim test receives one durable call and exactly one successful claim. | PASS locally. |
| List/get/dispatch state consistency | `resolveEffectiveDeviceState` is the only resolver used by `listDevices`, `getDevice`, and `dispatch` (`service.ts:61-69,81,86-90,104-110`). No distinct `ping` route exists in this slice; Presence is the liveness source. | PASS for local list/get/dispatch; ping API N/A. |
| Bounded dispatch timeout | Default is 30,000 ms (`service.ts:7,75-78`); deadline is stored at creation and expired reads return `timed_out` (`service.ts:110-111,130-132`); SQL claim fencing requires future deadline (`migration:76-79`). | PASS locally. |
| Secret isolation | Server accepts only URL, publishable key, and server-only Presence authority credential (`server.ts:15-21`); store has no service-role path (`supabase-store.ts:6-14`); public bootstrap returns only URL and publishable key (`server.ts:28`). | PASS by source inspection; deployment configuration unverified. |
| RLS enforcement | RLS is enabled with authenticated owner-select policies and RPC grants (`migration:35-40,92-93`). | UNVERIFIED: no disposable Supabase project or authenticated two-user session was available; migration was not applied. |
| Presence-bound create RPC | The legacy `public.create_mcp_remote_call` grant is revoked from `authenticated`, `anon`, and `service_role`; the replacement private-PostgREST RPC is granted only to `control_plane_dispatcher`, validates signed claim/request hash/replay state, and the HTTP store rechecks Presence before issuing its 30-second ES256 dispatcher token. The focused regression verifies those grants and token request binding. | PASS by local source/credential regression; live ACL/JWKS/PostgREST evidence remains required. |
| Device authorization | Strict PKCE-shaped start/poll requests return 503 pending approved IdP integration (`server.ts:29-32`). | BLOCK for live device onboarding. |
| Repository integration suite | `npm run test:integration` ran three pre-existing suites: one passed and two failed before control-plane use because managed authorization reported `ACS_RUNTIME_IDENTITY_MISSING`. | FAIL (environment prerequisite). |

## Commands and observed results

```text
npm run control-plane:test
exit 0
PASS ownership is enforced and Presence overrides stale online metadata
PASS revocation blocks list dispatch and duplicate idempotency has one call
PASS absent Presence and timeout produce consistent unavailable and timed-out states
PASS connector bootstrap and PKCE endpoint shapes are available without auth

npm run test
exit 0
Overall Results: Total tests 62; Passed 62; Failed 0

npm run build
exit 0
TypeScript emitted 697 files; total build time observed: 1.77s

npm run test:integration
exit 1
PASS ./terminal-output-buffer-leak.js
FAIL ./edit-block-performance.js: managed authorization rejected (ACS_RUNTIME_IDENTITY_MISSING)
FAIL ./read-file-unknown-params.js: managed authorization rejected (ACS_RUNTIME_IDENTITY_MISSING)
```

## Required follow-up evidence

1. Apply the migration only to an approved non-production Supabase project and run two authenticated users through table/RPC denial and ownership tests, including private Realtime authorization.
2. Supply an approved device-flow identity-provider implementation; then test PKCE verifier, expiry, one-time approval, revocation, and token rotation.
3. Restore the managed runtime identity fixture/configuration required by the two failing general integration tests, then rerun `npm run test:integration`.
4. Apply the private dispatcher migration only after privileged role bootstrap to an approved non-production database, then capture the contract's ACL/RLS/JWKS/PostgREST negative evidence. Local testing proves the source boundary but cannot prove effective hosted configuration.
