# Jace Commander service isolation, public edge, and ACS authority audit

Status: **prepared and verified offline. Not deployed.** Live identities, live services, and public exposure each need
explicit approval (see "Approvals required"). Units live in `apps/dc-mcp-gateway/deploy/systemd/hardened/`.

## 1. ACS authority audit (remote path, gateway -> bridge -> executor)

| Layer | Enforces | Evidence (test) |
|---|---|---|
| Gateway `/jc/mcp` | OAuth bearer, then per-call ACS issuance for ACS-routed tools. Client `_meta.capability` and `acs*` keys stripped before issuance. Batches with `tools/call` refused (503). | `jc-route.test.mjs`, `managed.test.mjs` |
| Gateway `JC_PRESET=local` | Local tools skip issuance only when the policy says `local`. Missing explicit policy, or unusable policy, routes to ACS. | `jc-local-routing.test.mjs`, `jc-route.test.mjs` |
| Bridge (managed JC) | **New:** a `tools/call` without an `_meta.acsCapability` object is refused with 403 before session creation or forwarding. Batches are refused whole. | `jc-managed-attestation.test.mjs` (updated) |
| Bridge attestation | Gateway attestation required on every request (managed and local). Forged, expired, mismatched, or malformed attestation is 401 before any session. | `jc-managed-attestation.test.mjs`, `jc-local-bridge-attestation.test.mjs` |
| Executor (managed) | Verifies the capability signature, audience, runtime, tool, arguments, nonce (single use), and time. Missing or forged envelopes fail with `JC_CAPABILITY_*`. | `jc-managed-attestation.test.mjs` (real child, forged envelope); vendored `test-acs-capability.js` (`testNonceReplayProtection`), `test-jace-commander-server.js` (granted path, 15 passed) |
| Executor (local) | Decides from class policy (`allow` / `approve` / `deny`). `privileged` defaults to `approve`. Policy is root-owned, immutable to the JC uid, and a configured-but-invalid policy denies everything except `jc.meta`. | `vendor/.../test-jace-commander-privileged.js` (17 passed), `test-jace-commander-policy.js` |

**Outage:** ACS unreachable fails closed on the JC lane (`jc-route.test.mjs`: "ACS unreachable fails closed"). With the local
preset, a local tool still runs and an ACS-routed tool returns `ACS_UNAVAILABLE` without any upstream request
(`jc-local-routing.test.mjs`).

**Findings and decisions**

- *Confirmed defense-in-depth gap, fixed:* in managed JC mode the bridge forwarded capability-less `tools/call` to the
  executor and relied on the executor alone. The bridge now refuses them itself.
- *Design choice, kept and documented:* `JC_PRESET=local` with **no** policy file at the default path means uniform
  local, on both the gateway and the executor. This matches the executor's documented rule (defaults apply only when no
  policy was ever configured). An explicitly named `JC_POLICY_PATH` that is missing or invalid fails toward ACS on the
  gateway and denies everything on the executor. The preflight requires a policy file to exist, so the hardened units
  cannot start in the default-local state by accident.
- *Gateway and executor can disagree only in the safe direction:* the gateway reads one policy file, while the executor
  also reads a user layer that may only tighten. A gateway "local" with an executor "acs" yields a denial, never an escalation.
- *Bridge holds one ACS credential:* `ACS_WORKER_TOKEN` (result reporting). It is kept out of the gateway's env file and
  is required to differ from the gateway's `ACS_JC_GATEWAY_TOKEN` (preflight check).
- *Shared attestation secret:* `GATEWAY_EXECUTION_TOKEN` (gateway) and `DC_GATEWAY_EXECUTION_TOKEN` (bridge) are one HMAC
  key. A compromised bridge can therefore mint gateway attestations toward itself, but it cannot mint ACS capabilities,
  which the executor verifies against the ACS public key.

## 2. Process isolation (prepared, not applied)

| Identity | Process | Holds | Does not hold |
|---|---|---|---|
| `jc-edge` | public edge (`edge/ingress.js`) | nothing secret | any token or key |
| `jc-gateway` | OAuth gateway (`server.js`) | `SIGNING_KEY`, `CONSENT_PASSPHRASE`, `GATEWAY_EXECUTION_TOKEN`, `ACS_JC_GATEWAY_TOKEN` | `ACS_WORKER_TOKEN` |
| `jc-bridge` | MCP bridge (`bridge.js`) | `DC_GATEWAY_EXECUTION_TOKEN`, `ACS_WORKER_TOKEN`, ACS **public** key | gateway ACS JC token, signing key |
| `jc-exec` | executor, started by the bridge via `setpriv` | no ACS or gateway tokens, no supplementary groups, all capabilities dropped | **`DC_GATEWAY_ATTESTATION_KEY`** (see residual risk below) |

The executor's environment is an explicit allowlist built by the bridge (`CHILD_ENV` in `bridge.js`): `PATH`, `HOME`,
`LANG`, `TMPDIR`, `NODE_ENV`, the attestation key, and the ACS **public** key. The bridge's own credentials are not passed.

**Residual risk (not fixed here):** the executor runs model-driven commands as `jc-exec`, and those commands can read the
executor's environment through `/proc/self/environ`. So they can read `DC_GATEWAY_ATTESTATION_KEY`. That lets them forge
gateway attestation toward the bridge, which is on the same host. It does **not** let them mint ACS capabilities, because
the executor verifies those against the ACS public key. The fix is to stop passing the attestation key to the executor at
all, which needs a check that the executor does not use it. This is a follow-up before any public cutover.

Each credential file is `root:<service-group>` mode `0640`, and the preflight checks mode, ownership, and the
absence of cross-service keys. Each service's `StateDirectory` is `0700` and owned by that service.

Sandbox (per unit): `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `PrivateDevices`,
`ProtectProc=invisible`, `SystemCallFilter=@system-service` (minus privileged and resource calls), `RestrictNamespaces`,
`CapabilityBoundingSet` empty for gateway and edge, `CAP_SETUID`/`CAP_SETGID` only for the bridge (to drop the executor),
and `IPAddressDeny=any` with `IPAddressAllow=localhost`. Offline `systemd-analyze security` exposure scores: edge 1.4,
gateway 1.4, bridge 3.5 (scores are offline estimates, not a runtime proof).

Not set, by design: `MemoryDenyWriteExecute` (V8 needs writable+executable pages for JIT).

**Parity costs of the hardened units (must be decided before cutover)**

1. `git_fetch` and `git_push` need remote network, which `IPAddressDeny=any` blocks. Allowing specific git hosts is a host decision.
2. `privileged_exec` uses `sudo -n` (setuid). `NoNewPrivileges=true` blocks it, so the hardened bridge has **no privileged
   path**. The privileged helper needs its own unit with an approved exception. Until then, `privileged_exec` is unavailable.
3. The executor under the hardened bridge runs as `jc-exec`, not as a desktop user. Desktop-user execution is a host decision
   (it grants the desktop account's full authority) and is not a default.

**Validation performed here (unprivileged, no live changes)**

- `systemd-analyze verify` passes for all three units.
- `systemd-sysusers` (dry root) creates the four identities as declared.
- `systemd-tmpfiles` applies the state directories when run as root. As uid 1000 it fails `fchownat` as expected, which
  shows the migration must run as root.
- `preflight.sh` fixture tests (10): correct fixture passes everything except the host-only identity and ownership checks,
  and each deliberate mistake fails with a specific message. The preflight never prints a secret.

**Not validated here:** creating the real users, running the services under the sandbox, process-restart behavior, and
whether `SystemCallFilter` and `PrivateUsers` interact with Node 26 at runtime. Those need an isolated VM or container
with root.

## 3. Public HTTPS edge (default-deny)

Ingress: `edge/ingress.js` (loopback only), with route policy in `edge/policy.js`. It reviews and supersedes the
untracked `public-edge-*.js` drafts, which are left untouched.

| Method | Path | Condition | Target |
|---|---|---|---|
| GET | `/.well-known/oauth-protected-resource/jc/mcp` | no query | gateway |
| GET | `/.well-known/oauth-authorization-server/jc` | no query | gateway |
| GET | `/jc/.well-known/oauth-authorization-server` | no query | gateway |
| GET | `/jc/.well-known/openid-configuration` | no query | gateway |
| GET | `/authorize` | `oauth_lane=jc` and `resource=https://<host>/jc/mcp`, each exactly once | gateway |
| POST | `/authorize/consent` | no query; body names the JC resource exactly once | gateway |
| POST | `/token` | `oauth_lane=jc` and matching `resource` | gateway |
| POST | `/register` | `oauth_lane=jc` and matching `resource` | gateway |
| GET, POST, DELETE | `/jc/mcp` | no query | gateway |

Everything else is denied. Known paths with the wrong method get 405 with `Allow`. Unknown paths get 404. Denied requests
never open an upstream socket. Also enforced: exact `Host` match, ASCII raw paths only (no encoding, dot segments,
`//`, or backslashes), body caps per route (413), client identity headers stripped (`x-dc-*`, `x-acs-*`, `x-forwarded-*`,
`forwarded`, `x-real-ip`), and header, request, and upstream timeouts.

Never routed publicly: `/ready`, `/authority`, `/jc/ready`, `/health`, `/healthz`, `/mcp` (DC), ACS internal APIs,
bridge and executor endpoints, and any path not listed above.

Tests: `test/edge-ingress.test.mjs` (14): policy table, path tricks, Host, method denial, 413, zero upstream hits on
every denial, identity-header stripping, consent resource enforcement, and 502 when the gateway is down.

**Tailscale:** no Serve or Funnel config was changed. Funnel stays off. The TLS terminator, when approved, must forward
only to `127.0.0.1:8011`.

## 4. Verification summary (this branch)

- Gateway suite (worktree): **225 / 225** pass.
- New or changed tests: `cimd-guard` (26), `oauth-boundary` (11), `cimd-proxy-transport` (3), `edge-ingress` (14),
  `jc-preflight` (10), `jc-managed-attestation` (17, updated and extended).
- Executor, vendored (run directly, `HOME` isolated, prebuilt output): `test-acs-capability.js` passes (includes nonce replay);
  `test-jace-commander-privileged.js` 17 passed; `test-jace-commander-server.js` 15 passed (includes the granted-capability path).
- Proxy setting check: with `HTTPS_PROXY` pointing at a closed port and `NODE_USE_ENV_PROXY=1`, the metadata fetch connects
  direct (`cimd-proxy-transport.test.mjs`). The same setting makes the default agent hit the proxy (`ECONNREFUSED`), so the
  test is discriminating.

**Not verified (blockers):** live ChatGPT OAuth, real DNS rebinding against a real resolver, service restart and recovery
under systemd, ACS-live outage on a running host, and the privileged helper under the hardened units.

## 5. Proposed host change (requires approval; not applied)

1. Create identities and state directories: `sudo migrate-jc-identities.sh --apply` (dry-run first without `--apply`).
2. Fill the placeholder env files as root: `gateway.env`, `bridge.env`, `edge.env`. Generate every secret with a CSPRNG.
   Do not reuse `ACS_GATEWAY_TOKEN` as `ACS_JC_GATEWAY_TOKEN`.
3. Place the root-owned policy at `/etc/jace-commander/policy.json` (mode 0644, root-owned, directory chain root-owned).
4. Run `preflight.sh` until it reports PASS on the host. Do not start any service while it reports FAIL.
5. Start in a staging environment first. Exercise the public-route allowlist and the denial tests with TLS locally.
6. Cutover, only after approval: stop the legacy `jace-commander-mcp.service` and `desktop-commander-auth-proxy`, enable the
   hardened units, verify `/jc/ready` locally, and keep Funnel off.

## 6. Rollback

1. `systemctl disable --now jace-commander-edge jace-commander-gateway jace-commander-bridge`
2. `sudo migrate-jc-identities.sh --rollback /var/backups/jace-commander/<stamp>`: restores replaced units and removes
   added units, using the manifest. It does **not** delete identities, state directories, or existing env files.
3. Re-enable the legacy units from the backup. Confirm Funnel is off (`tailscale funnel status`).

## Approvals required (not granted)

- Creating system identities, changing live permissions, and installing units on the host.
- Starting or restarting any service, and replacing the running executor.
- Activating Tailscale Funnel or any public HTTPS route.
- Choosing the executor identity (`jc-exec` versus a desktop user).
- Narrowing or granting network access for git tools, and adding a privileged-helper unit exception.
- Merging the pull request.
