# JC independent local execution — opt-in rollout

Status: **DRAFT / DISABLED ON LIVE HOST**. This document covers the proposed
implementation in PRs #324, #325 and #326. No merge, deployment, privilege
installation or credential enrollment is implied.

## Invariant

**ACS may govern JC when selected, but must not become an implicit prerequisite
for JC local execution.** The existing managed preset remains the default.
Explicit `admin-delegated` selections are not accepted until a separately
verified ACS administrative capability is implemented. A persistent ACS admin
toggle must be authenticated, audited and manually reversible immediately;
its lifetime cannot act as authorization on its own.

## Trust boundaries

1. The OAuth edge authenticates MCP clients with the JC audience. In
   `JC_AUTHORITY=local` it does not call ACS for issuance. Its upstream must
   advertise `variant: jc` and `childMode: local`. Any mismatch fails closed.
2. The bridge runs the JC server as `serve --local`, never `--standalone`.
   The JC OS account must be distinct from the operator login and `jc-approverd`.
3. JC reads `/etc/jace-commander/local-policy.json` and
   `/etc/jace-commander/approverd-public.pem`. Every path component and both
   files must be root-owned, non-symlink and not group/world writable.
   There is no permissive fallback. Local privileged execution is forbidden
   until the root helper independently validates `jc.local.v1` (slice 5).
4. `jc-approverd` owns its own Ed25519 private key and append-only audit
   under `/var/lib/jc-approverd`. It accepts requests on
   `/run/jace-commander/approverd.sock`, but only issues a local token after
   verifying a challenge-bound, independently signed operator assertion.
   It must NEVER trust a TTY, caller UID or an agent-authored confirmation
   as proof of human approval.
5. The operator assertion private key must be inaccessible to JC, agents,
   the gateway, and approverd. It is not enrolled or provisioned by this PR.
   Prefer an independently operated user-presence-protected signing device.
   **Raw Ed25519 signature verification alone does not attest a biometric,
   a physical touch, or FIDO/WebAuthn user verification.** A production
   requirement for those assurances needs a WebAuthn/FIDO verification flow.
6. JC verifies exact tool name, normalized arguments, runtime identity,
   issuer signature, expiry (maximum 30 s) and persistent single-use nonce
   before each approval-gated action. Local policy scopes filesystem roots;
   existing process/git constraints continue to apply. A durable local audit
   `tool_call_started` record is required before dispatch. An unavailable
   audit path rejects the call.

## Files and identities

- Local policy: `/etc/jace-commander/local-policy.json`, root-owned 0644 or stricter
- JC verifier key: `/etc/jace-commander/approverd-public.pem`, root-owned 0644 or stricter
- Operator verifier key: `/etc/jace-commander/operator-public.pem`, root-owned 0644 or stricter
- Signer private key: `/var/lib/jc-approverd/signing-private.pem`, owner `jc-approverd`, mode 0600
- Local signer service: `vendor/desktop-commander/deploy/jc-approverd.service`
- JC service user: `jc`; signer service user: `jc-approverd`.
  The JC user must be authorized to connect to the approverd group-owned
  socket, but that access never substitutes for the operator signature.
- Do not store operator private credentials anywhere on the JC host.

Sample explicit policy (all roots must exist; revise for actual host):

```json
{
  "version": "jc.policy.v1",
  "classes": {
    "read": "allow",
    "mutate": "approve",
    "exec": "approve",
    "network": "approve",
    "privileged": "approve"
  },
  "roots": ["/home/jacen/projects"],
  "deniedRoots": ["/home/jacen/.ssh"],
  "authorizers": {
    "defaultAuthorizer": "local",
    "perProvider": { "acs": "acs-capability" }
  }
}
```

In the current local-mode runtime an `acs-capability`-selected tool is
**unavailable**, rather than silently escalating or reaching ACS. Providers
can be divided between separately deployed local and managed JC lanes after
explicit operator configuration.

## Required integration before production enablement

- Dedicated OS users, secure socket directory, service identities, file
  ownership and immutable release entrypoints verified on target host.
- Operator key enrolled through an authenticated, non-agent-controlled process.
  Exact action details must be displayed on the human approval surface.
  The JSONL daemon RPC accepts one `request` or `approve` per connection.
  `request` returns an id, nonce challenge and invocation hash; `approve`
  requires the signed full assertion and returns `jc.local.v1`. Do not
  expose the socket publicly.
- ACS-down acceptance: local read/write with valid approvals works with ACS
  unavailable; ACS-selected calls fail closed; local approval still needs
  operator authentication; OAuth audience and bridge mode mismatch block.
- Token forgery, replay across restarts, wrong runtime/tool/arguments,
  expired grants, tampered local policy, missing trace, wrong signing key,
  signer downtime, and root-helper denial must all be tested.
- Verify controlled manual off-switch for the independent local lane, plus
  explicit ACS admin toggle behavior, without automatic TTL.

## Verification commands (isolated test environment)

```sh
cd vendor/desktop-commander
npm run build
node test/test-jace-commander-local-policy.js
node test/test-jace-commander-local-capability.js
node test/test-jace-commander-approverd-service.js
node test/test-jace-commander-local-execution.js
node test/test-jace-commander-standalone.js
node test/test-jace-commander-server.js

cd ../../apps/dc-mcp-gateway
node --test test/jc-route.test.mjs
node --test test/client-attribution.test.mjs
```

The signing daemon and JC-local gateway must not be deployed until CI,
a privilege and policy integrity review, and on-host E2E all pass. Never
roll out to the existing managed listener as a silent fallback.
