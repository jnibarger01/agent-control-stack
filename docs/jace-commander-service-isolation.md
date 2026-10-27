# Jace Commander service isolation, public edge, and ACS authority audit

Status: **prepared and verified offline in isolated build directories. Not deployed.** Live identities, live services, and
public exposure each need explicit approval (see "Approvals required"). The canonical unit set is in
`ops/jc-hardening/` (see its README). The earlier parallel `deploy/systemd/hardened/` set was removed in favor of it.

## 1. ACS authority audit (remote path: gateway -> bridge -> executor)

| Layer | Enforces | Evidence |
|---|---|---|
| Gateway `/jc/mcp` | OAuth bearer, then per-call ACS issuance for ACS-routed tools. Client `_meta.capability` and `acs*` keys stripped before issuance. Batches with `tools/call` refused (503). | `jc-route`, `managed` |
| Gateway `JC_PRESET=local` | Local tools skip issuance only when the policy says `local`. A missing explicit or unusable policy routes to ACS. | `jc-local-routing`, `jc-route` |
| Bridge (managed JC) | A `tools/call` without an `_meta.acsCapability` object is refused with 403 before session creation or forwarding. Batches are refused whole. | `jc-managed-attestation` (17) |
| Bridge attestation | Gateway attestation is required on every request. Forged, expired, mismatched, or malformed attestation is 401 before any session. | `jc-managed-attestation`, `jc-local-bridge-attestation` |
| Bridge attribution (new) | The bridge deletes any client-written `_meta.gateway`, then signs a fresh envelope with its Ed25519 private key. | `jc-attribution-boundary` (4) |
| Executor (managed) | Verifies the capability signature, audience, runtime, tool, arguments, nonce (single use), and time. Missing or forged envelopes fail with `JC_CAPABILITY_*`. | vendored `test-acs-capability.js`, `test-jace-commander-server.js` (15), `jc-managed-attestation` (real child, forged envelope) |
| Executor attribution (new) | Verifies `_meta.gateway` with the bridge's **public** key only. A signature under any other key, the retired HMAC, or an HMAC keyed with the public key is untrusted. | vendored `test-gateway-attribution.js` (9 cases) |
| Executor (local) | Decides from class policy (`allow` / `approve` / `deny`). `privileged` defaults to `approve`. A configured-but-invalid policy denies everything except `jc.meta`. | vendored `test-jace-commander-privileged.js` (17) |

**Outage:** ACS unreachable fails closed on the JC lane (`jc-route`, "ACS unreachable fails closed"). With the local
preset, a local tool still runs and an ACS-routed tool returns `ACS_UNAVAILABLE` without any upstream request.

**Restart:** after a bridge restart the old session is refused, unauthorized calls are still refused, and recovery requires a
fresh attested initialize. Authorized calls reach the executor again (`jc-restart-recovery`, 1 test with 5 checks).

**Replay:** the executor rejects a reused capability nonce, including under eight concurrent submissions (vendored
`testNonceReplayProtection`). The gateway issues a fresh capability per call and caches none (`managed`).

**Findings and decisions**

- *Fixed, Phase 4:* in managed JC mode the bridge forwarded capability-less `tools/call` to the executor and relied on the
  executor alone. The bridge now refuses them itself.
- *Fixed, Phase 9:* the executor was given `DC_GATEWAY_ATTESTATION_KEY`, a shared HMAC secret, to verify attribution. Any
  command the executor ran could read it from `/proc/<pid>/environ` and forge gateway identity in the audit trail. The
  executor now verifies Ed25519 signatures with a public key and holds no secret. The retired variable is ignored with a warning.
- *Design choice, kept:* `JC_PRESET=local` with **no** policy file at the default path means uniform local, on both the
  gateway and the executor. This matches the executor's documented rule. The preflight requires a policy file to exist.
- *Safe disagreement only:* the gateway reads one policy file, while the executor also reads a user layer that may only
  tighten. A gateway "local" with an executor "acs" yields a denial, never an escalation.

## 2. Credential map (canonical)

Identities are declared in `ops/jc-hardening/acs-jc.sysusers.conf`. Secrets live in `/etc/acs-secrets/` (root:group, mode 0640).

| Identity | Process | Holds | Must not hold |
|---|---|---|---|
| `acs-ingress` | public ingress (`edge/ingress.js`) | nothing secret | any key or token |
| `acs-edge` | OAuth gateway (`server.js`) | `SIGNING_KEY`, `CONSENT_PASSPHRASE`, `GATEWAY_EXECUTION_TOKEN` (attestation secret), `ACS_JC_GATEWAY_TOKEN` | the bridge's Ed25519 signing key, `ACS_WORKER_TOKEN` |
| `acs-jc` | MCP bridge (`bridge.js`) | `DC_GATEWAY_EXECUTION_TOKEN` (attestation secret, verify), `DC_GATEWAY_ATTESTATION_SIGNING_KEY` (Ed25519 private, sign), `ACS_WORKER_TOKEN`, ACS **public** key | gateway OAuth key, consent passphrase, `ACS_JC_GATEWAY_TOKEN` |
| `acs-jc-exec` | executor, started by the bridge via `setpriv` | nothing. Receives only `DC_GATEWAY_ATTESTATION_PUBLIC_KEY` and the ACS public key | any secret; no supplementary groups; all capabilities dropped |

The bridge builds the executor's environment from an explicit allowlist (`CHILD_ENV` and `JC_CHILD_ENV_KEYS` in `bridge.js`).
`test/jc-attribution-boundary.test.mjs` proves, by name and by SHA-256 digest of each forwarded value, that the executor
receives the public key and none of the bridge's secrets.

## 3. Residual credential and authorization risks

These are real and remain after Phase 9. None of them is a silent bypass; each is a stated limit.

1. **Model-run commands can read the executor's environment.** The executor runs as `acs-jc-exec`, and commands it starts
   share that uid, so they can read `/proc/<executor-pid>/environ`. What that exposes now is the ACS public key, the public
   attestation key, and any integration tokens below. The attestation **secret** is no longer there.
2. **`JC_ACS_TOKEN` and `JC_SWARM_TOKEN` are forwarded to the executor when the bridge environment defines them**
   (`JC_CHILD_ENV_KEYS`). The executor needs them for the `acs_read`, `acs_submit_mission`, and `swarm_read` tools, and
   model-run commands can read them. The hardened bridge env template does not define them, so they are absent unless added.
   Moving these calls behind the bridge or a broker would remove this exposure. That is a design change, not made here.
3. **The gateway and the bridge share the attestation secret** (`GATEWAY_EXECUTION_TOKEN` = `DC_GATEWAY_EXECUTION_TOKEN`).
   Compromise of either process lets an attacker forge `x-dc-attestation` toward the bridge on the loopback interface. It
   cannot mint ACS capabilities, and it cannot forge executor-side attribution. Converting this hop to asymmetric
   signatures would remove the risk and is the recommended next step.
4. **The bridge holds the Ed25519 signing key and its ACS worker token.** A bridge compromise can sign attribution and report
   results to ACS as the bridge. The bridge still cannot mint capabilities, because only ACS signs those.
5. **Local preset trust rests on attestation.** Under `JC_PRESET=local`, a forged gateway attestation (risk 3) would reach
   local tools without ACS. The local class policy still decides each call, and the executor runs as `acs-jc-exec`.
6. **Not evaluated:** the desktop-user executor identity. Running the executor as a human desktop account would give it that
   account's full authority. That is an explicit host decision.

## 4. Desktop Commander feature parity (hardened set vs current behavior)

| Capability | Hardened canonical set | Status and reason |
|---|---|---|
| Filesystem read/write/edit within allowed roots | Available for paths `acs-jc-exec` can access | **Reduced.** Executor runs as `acs-jc-exec`, not the user; the user's home is hidden (`ProtectHome`). Needs `JC_FS_ROOTS` on a shared workspace. |
| Search, process tools, status, doctor | Available | Full. |
| `git_status`, `git_diff`, `git_log`, `git_add`, `git_commit` (local) | Available for repos under allowed roots | Reduced by the filesystem limit above. |
| `git_fetch`, `git_push` (remote) | **Unavailable** | `IPAddressDeny=any` blocks remote network. Needs an explicit host decision to allow specific git hosts. |
| `privileged_exec` | **Unavailable** | `NoNewPrivileges=true` blocks the `sudo -n` helper. Needs a separate privileged-helper unit and an approved exception. |
| Managed ACS capability flow | Available | Full. Verified by the tests above. |
| Local preset (class policy) | Not in the canonical set | Use a separate, approved configuration. |
| Commands that need network (`npm`, `curl`, package installs) | **Unavailable** | Same as the network limit above. |

**Parity verdict: PARTIAL.** Authorization and the managed capability path are at parity. Remote git, privileged operations,
network-using commands, and access to the user's own workspace are not, and each needs a host decision.

## 5. Public HTTPS edge (default-deny)

Ingress: `edge/ingress.js` (loopback only), route policy in `edge/policy.js`. It supersedes the earlier `public-edge-*.js`
drafts, which are unchanged.

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
never open an upstream socket. Also enforced: an exact `Host` match, ASCII raw paths only, per-route body caps (413),
client identity headers stripped (`x-dc-*`, `x-acs-*`, `x-forwarded-*`, `forwarded`, `x-real-ip`), and timeouts.

Never routed publicly: `/ready`, `/authority`, `/jc/ready`, `/health`, `/healthz`, `/mcp` (DC), ACS internal APIs,
bridge and executor endpoints, and any path not listed above.

**Tailscale:** no Serve or Funnel config was changed. Funnel stays off. A TLS terminator, when approved, must forward only to
`127.0.0.1:8011`. That configuration has not been written.

## 6. Verification (this branch, isolated builds)

Built from a copy of the source outside the repository (`/home/jacen/projects/jc-sec-build`). The executor was compiled with
`tsc -p .` (exit 0). The gateway suite ran against that build.

- Full gateway suite in the isolated build: **242 / 242** pass.
- New tests: `jc-attribution-boundary` (4), `jc-restart-recovery` (1), `jc-preflight` (14), `edge-ingress` (14).
- Boundary tests against the **baseline** bridge (869cb71d): `jc-attribution-boundary` fails **4 / 4**. The same tests pass
  on the new code. So the tests detect the defect they target.
- Vendored executor, isolated build, `HOME` isolated: `test-gateway-attribution.js` passes (Ed25519 cases);
  `test-acs-capability.js` passes (includes nonce replay); `test-jace-commander-server.js` 15 passed; `test-jace-commander-privileged.js` 17 passed.
- Proxy setting check: with `HTTPS_PROXY` aimed at a closed port and `NODE_USE_ENV_PROXY=1`, the metadata fetch connects direct
  (`cimd-proxy-transport`, 3). The same setting sends the default agent to the proxy, so the test can fail.
- Units: `systemd-analyze verify` passes for the three canonical units. `systemd-sysusers` (dry root) creates the identities
  as declared. The migration script's dry-run plan changes nothing.

**Not verified (blockers):** creating real users and state directories; running the services under the sandbox; whether
`SystemCallFilter`, `PrivateUsers`, and `ProtectProc` work at runtime on Node 26; live ChatGPT OAuth; real DNS rebinding;
a live ACS outage; and the privileged helper under the hardened units.

## 7. Proposed host change (requires approval; not applied)

1. Dry-run: `ops/jc-hardening/migrate-acs-jc-identities.sh` (no arguments; prints the plan).
2. Apply as root: `sudo ops/jc-hardening/migrate-acs-jc-identities.sh --apply`. Creates identities, the executor state
   directory, and the three units, and writes placeholder secret files only where none exist. It does not enable or start anything.
3. Fill the placeholder secret files as root. Generate every secret with a CSPRNG. Do not reuse `ACS_GATEWAY_TOKEN` as
   `ACS_JC_GATEWAY_TOKEN`. Generate the Ed25519 signing key on the host and never copy it to another identity's file.
4. Place the root-owned policy at `/etc/acs-secrets/policy.json` (mode 0644, root-owned, directory chain root-owned).
5. Run `ops/jc-hardening/preflight.sh` until it reports PASS on the host. Do not start any service while it reports FAIL.
6. Stage and exercise in a separate environment first. Verify the public-route denials with TLS locally.
7. Cutover, only after approval: stop the legacy units, enable the canonical units, verify `/jc/ready` locally, and keep Funnel off.

## 8. Rollback

1. `systemctl disable --now acs-jc-public-ingress acs-jc-edge acs-jc-bridge`
2. `sudo ops/jc-hardening/migrate-acs-jc-identities.sh --rollback /var/backups/acs-jc/<stamp>`: restores replaced units and
   removes added units from the manifest. It does **not** delete identities, the executor state directory, or existing secret files.
3. Re-enable the legacy units from the backup. Confirm Funnel is off (`tailscale funnel status`).

## Approvals required (not granted)

- Creating system identities, changing live permissions, and installing units on the host.
- Starting or restarting any service, and replacing the running executor.
- Activating Tailscale Funnel or any public HTTPS route.
- Choosing the executor identity (`acs-jc-exec` versus a desktop account).
- Allowing remote network for git tools, and adding a privileged-helper unit exception.
- Moving `JC_ACS_TOKEN` and `JC_SWARM_TOKEN` behind the bridge (residual risk 2).
- Converting the gateway-to-bridge attestation hop to asymmetric signatures (residual risk 3).
- Merging the pull request.
