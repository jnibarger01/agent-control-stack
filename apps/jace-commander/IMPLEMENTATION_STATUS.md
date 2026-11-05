# Native JC implementation status

Branch `feat/jc-native-runtime-20261103`. Development continued from the release
gates on Codex's checkpoint `5bb846f3`. The clean-install verifier passed on
`0497b505`, and that commit is the installed CachyOS user release. The unit is
started and not enabled. A live `acs:read` authority credential is still absent,
so `/ready` stays 503 and every mutation fails closed.

## Release gates

| Gate | Status | Evidence |
| --- | --- | --- |
| 1. Credential isolation | Closed | bubblewrap workload sandbox for every workload and git; `test/workload-isolation.test.mjs` (13 checks, real bwrap, host-visible fixtures): no host PIDs/environ, masked credential stores / ACS DB / env files / runtime bus, read-only runtime, no persistence, no capabilities or nested userns, network namespace, PTY works, no survivor after kill/timeout (fails on the previous engine), fail closed |
| 2. Authenticated ACS integration | Closed | `tests/e2e/acs-jc-mcp` 27/27 against real ACS (SQLite, acs.jc.v1 signing), OAuth edge, bridge and native JC: approval-gated execution, denial, post-issuance revocation and lease expiry, replay, principal isolation, audited `execution_result.accepted` |
| 3. Dependencies and migrations | Closed (17 moderate remain, dev tooling / @vercel/queue) | npm audit 39 -> 17 (high 5 -> 0); shipped JC graph 0 findings; migration 076 order-safe vs both 075s; migration suites 63/63 |
| 4. Standalone runtime | Closed | `npm run jc:verify-release`: clean install outside all repos with `$HOME/projects` masked, 123 runtime packages all inside the release, 30/30 + 27/27 suites, real MCP SDK client session (11 checks), 309 resolved modules all inside the release; chain e2e 27/27 against an installed release |
| 5. Hardening | Done for this scope | defects fixed below; docs and templates updated |

## Live installation (CachyOS, 2026-11-04)

- Release `1.0.0-0497b505a9c2` installed by `deploy/install-user-release.sh` at
  `~/.local/lib/jace-commander/releases/1.0.0-0497b505a9c2` (read-only). `current`
  points at it. `previous` is `1.0.0-3662ddf96d50`.
- `jace-commander-mcp.service` (user unit, loopback 127.0.0.1:8003) is active and
  not enabled. The child is `.../current/dist/cli.js serve` with cwd inside the
  release. `/authority` reports that release, `readOnly: true`, and
  `currentAuthorityCredentialConfigured: false`.
- `/health` is 200. `/ready` is 503: `dedicated ACS authority credential
  (JC_ACS_AUTHORITY_TOKEN_FILE) not configured`. `~/.config/acs/jc-authority.token`
  does not exist. An unauthenticated `initialize` on `/mcp` returns 401
  `gateway attestation required`.
- ACS (127.0.0.1:3000) is not listening. Issuing the dedicated credential and
  starting ACS were not authorized. No Tailscale Serve or public ingress was enabled.
- The bridge env example now matches the unit. `JC_ACS_TOKEN` is documented as
  the model-facing tool credential only.
- A throwaway `PREFIX` proved install, upgrade, and `--rollback` (both releases
  read-only) without moving the live `current` symlink.

Rollback:

```sh
systemctl --user stop jace-commander-mcp                     # stop the lane
apps/jace-commander/deploy/install-user-release.sh --rollback # current <-> previous (after an upgrade)
systemctl --user restart jace-commander-mcp
# full removal (back to the captured pre-install state):
systemctl --user stop jace-commander-mcp && rm ~/.config/systemd/user/jace-commander-mcp.service && systemctl --user daemon-reload
```

## Final hardening (on 318c5f25)

- No ACS token fallback: the live authority check and bridge readiness accept only `JC_ACS_AUTHORITY_TOKEN(_FILE)`; `JC_ACS_TOKEN` and the worker token never count (unit + bridge + e2e regression tests).
- Least privilege proven in the real chain: JC's authority token is a separate `service` credential with `acs:read` only; ACS refuses it for approve, issue, result submission and work-item creation; the worker token stays bridge-only for result submission.
- Production runtime pinned: the CachyOS unit launches `~/.local/lib/jace-commander/current` with `JC_REQUIRE_INSTALLED_RELEASE=1`; the bridge refuses the checkout, writable or unmarked releases, a missing `JC_RUNTIME_DIR` and `DC_ARGS` overrides, and reports the release in `/authority`.

## Defects found and fixed in this continuation

- Live authority check unusable against real ACS (model-facing token, never set) -> dedicated read-scoped credential; mismatch reasons reported.
- Sandboxed workload could survive `kill_process` (die-with-parent startup race) -> PID-namespace init killed on every exit path.
- `kill_process` returned before termination; `interact_with_process` returned the terminal echo instead of output.
- ACS database / `~/.config/acs` env file were reachable by workloads and file tools.
- Release verifier recorded `ENOLOCK` as "no audit findings".

## Baseline failures (not introduced by this branch; identical at 69dc9fbd)

- `packages/local-advisor` egress NO_PROXY case `*,example.com` on Node v26.13 (guard is stricter: the safe direction).
- Real CLI interop tests for the locally installed OpenCode, Hermes and OpenClaw CLIs (installed CLI versions).

Root vitest at `51fbc2d5` (recovered completed run, nothing still running): 5098 passed, 4 failed (the baseline cases above), 99 skipped. The following commit only changes the env example, its regression test, and the README.

## Not verified here

- ChatGPT, Claude, Codex and OpenClaw against a published endpoint (not authorized).
- Privileged helper and approverd installation (root changes; not performed).
- A live `acs:read` authority credential in `~/.config/acs/jc-authority.token` (operator issuance; the lane stays fail-closed without it).
