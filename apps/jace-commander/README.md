# Jace Commander native runtime

Jace Commander (JC) is an independent MCP computer-control runtime: it owns its
MCP server, terminal and PTY engine, process registry, filesystem tools,
document readers, git operations, credential scanner, capability verifier and
workload sandbox. It neither imports nor starts Desktop Commander, and it has no
workspace dependencies: the ACS tool contract is embedded by the canonical
generator (`npm run jc-contracts:generate`). ACS is the sole authority for every
privileged action.

```text
AI client --HTTPS/OAuth--> edge (apps/dc-mcp-gateway/server.js, 127.0.0.1:8010)
   --per-call acs.jc.v1 issuance--> ACS (127.0.0.1:3000)
   --attested--> bridge.js (BRIDGE_PROFILE=jace-commander, 127.0.0.1:8003)
   --stdio--> jace-commander serve (this package, managed preset)
        verify capability (Ed25519, exact tool/arguments/runtime/scopes/expiry, single-use nonce)
        confirm CURRENT authority with ACS (work item running, lease active, approval bound)
        run the workload in a bubblewrap sandbox
   --terminal result--> ACS (audited execution_result, releases the admission permit)
```

## Build and verify

From the repository root:

| Command | What it proves |
| --- | --- |
| `npm test -w apps/jace-commander` | 30 suites: contract, tools, terminal/PTY, sandbox isolation, live authority, documents, approval, privileged helper |
| `ACS_DC_E2E=1 npx vitest run tests/e2e/acs-jc-mcp` | Real chain: OAuth edge, bridge, native JC and authenticated ACS with JC holding an `acs:read`-only token (30 tests, incl. revocation, lease expiry, replay, principal isolation, audited outcome, least privilege, missing-token refusal) |
| `npm run jc:verify-release` | Clean install outside every repository, runtime deps only, with `$HOME/projects` masked; dependency graph, shipped-graph audit, full suite, real MCP client session, module-resolution trace. Evidence: `verification/jc-release-standalone-evidence.json` |
| `npm run jc:verify-independence` | Copy-out build and test with no workspace or vendor tree |
| `npm run jc-contracts:check` | Embedded manifest matches the canonical ACS contract |

Set `JC_E2E_RUNTIME_DIR=<release>/current` to run the chain e2e against an
installed release (pinned with `JC_REQUIRE_INSTALLED_RELEASE=1`) instead of the
source tree. Linux, Node >= 24.16,
`/usr/bin/python3` (PTY allocation) and bubblewrap (`/usr/bin/bwrap`) are required.

## Authorization

- Every managed call needs an ACS-issued `acs.jc.v1` capability bound to the
  exact tool, arguments, runtime, scopes, expiry and a single-use nonce. JC only
  verifies; it holds no signing key.
- Every managed non-read call then reads the work item and attempt lease from
  ACS with a dedicated `acs:read`-only credential (`JC_ACS_AUTHORITY_TOKEN_FILE`,
  or `JC_ACS_AUTHORITY_TOKEN`; there is no fallback to the model-facing
  `JC_ACS_TOKEN` or the worker token, and an empty or unreadable file counts as
  unset) and requires that ACS still confirms that exact
  authority: work item `running`, requester = authenticated principal, matching
  action and invocation hash, lease `active` and unexpired, same fencing epoch,
  plan and approval. Refusals name the failed binding (`lease_not_active`,
  `lease_expired`, `requester_mismatch`, ...). No credential, an ACS outage or
  any mismatch refuses execution; there is no cached success and no fallback.
- Process sessions belong to the authenticated subject and OAuth client that
  started them; other principals cannot list, read, write to or kill them.
- `standalone` (read-only) and `local` presets remain explicit compatibility
  modes; the managed bridge refuses both and `--standalone`.

## Workload isolation

Every workload (`run_command`, `start_terminal_session` / `interact_with_process`,
`start_process`, all git operations) runs in a bubblewrap sandbox
(`src/sandbox.ts`), enforced by kernel namespaces even though it runs as the JC
account's UID:

- **PID/IPC/UTS namespaces**: JC, the bridge and every host process are
  invisible; `/proc/<pid>/environ` (gateway execution token, ACS tokens) cannot be
  read and nothing outside can be signalled or traced.
- **Filesystem**: `/` read-only; only `JC_FS_ROOTS` (+ `JC_SANDBOX_WRITABLE`) are
  writable, so no dotfile/autostart/unit persistence. Masked (empty, read-only):
  credential stores (`~/.ssh`, `~/.gnupg`, cloud CLIs, `~/.netrc`, keyrings, ...),
  `~/.config/acs`, JC/gateway state and env files, `$XDG_RUNTIME_DIR` (user bus,
  agent and X auth sockets), and the database/config of every ACS checkout
  reachable from the roots. Private `/tmp` and devpts. JC's runtime, its
  `node_modules`, the bridge and `~/.config/systemd` are read-only.
- **Capabilities**: all dropped; nested user namespaces disabled, so masks
  cannot be undone.
- **Network**: own network namespace by default (`JC_WORKLOAD_NETWORK=none`);
  `host` is an explicit opt-in. git fetch/push get the network with only the
  ssh agent socket and `known_hosts` re-exposed (key files stay masked).
- **Lifetime**: each sandbox's PID-namespace init is recorded (`--info-fd`) and
  killed on kill, timeout, exit and shutdown, so no workload outlives its session.
- **Fail closed**: a startup self-test must pass before a managed or local preset
  serves; otherwise every workload tool returns `JC_SANDBOX_UNAVAILABLE`.
  `JC_WORKLOAD_ISOLATION=none` is refused in managed mode and never forwarded by
  the bridge.

Residual risks: with `JC_WORKLOAD_NETWORK=host` a workload can reach host
loopback services and abstract sockets (every JC/ACS/edge endpoint still
requires credentials the workload cannot see). An approved command can modify
anything inside the filesystem roots, including code that other, unsandboxed
tools later execute; keep the JC release, the edge and the running ACS outside
the roots (or list them in `JC_SANDBOX_READONLY`).

## Tools and compatibility

The 36 original tool schemas are preserved (`test/fixtures/jc-tools-baseline-v1.json`;
only optional properties were added). Four approval-gated tools are new:

| Tool | Behavior |
| --- | --- |
| `run_command` | Shell command (configured shells only, default `/bin/bash`) with contained cwd, bounded timeout, optional PTY; CLI `jc run` |
| `start_terminal_session` | Interactive PTY shell; every input is separately approved |
| `interact_with_process` | Approved exact input to an owned session; waits for output to go quiet; CLI `jc send` |
| `delete_file` | Contained unlink or recursive delete; roots and `.git` refused; CLI `jc rm` |

`write_file` accepts `encoding: base64` for binary content. `read_process_output`
accepts per-stream byte cursors (`stdoutOffset`/`stderrOffset`) and `waitMs` and
returns `nextStdoutOffset`/`nextStderrOffset`; the legacy `offset` still applies to
both streams. `kill_process` returns once the process group is gone
(`exited: true`). `read_file` parses pdf (unpdf), docx and xlsx (pizzip, JC-owned
readers; xlsx returns raw cell values without number formatting).

## Deployment (CachyOS user services)

Templates: `apps/dc-mcp-gateway/deploy/systemd/jace-commander-mcp.service` (bridge
+ native JC on 127.0.0.1:8003) and `apps/dc-mcp-gateway/deploy/jace-commander-bridge.env.example`.
The unit pins the non-secret managed settings (`JC_PRESET=managed`,
`JC_WORKLOAD_ISOLATION=bwrap`, `JC_WORKLOAD_NETWORK=none`,
`JC_ACS_AUTHORITY_TOKEN_FILE`) and loads secrets and site values from
`~/.config/acs/jc-bridge.env` (plain `KEY=VALUE` lines; no JSON or multi-line
values, which systemd's `EnvironmentFile` would mangle). It uses `/usr/bin/node`
(no version-manager shims) and binds loopback only.

Production runtime (pinned): install a read-only release outside `JC_FS_ROOTS`
with `apps/jace-commander/deploy/install-user-release.sh` (default
`~/.local/lib/jace-commander/releases/<version>-<commit>` plus an atomically
switched `current` symlink). The unit sets
`JC_RUNTIME_DIR=%h/.local/lib/jace-commander/current` and
`JC_REQUIRE_INSTALLED_RELEASE=1`: the bridge then refuses to start unless that
path is an installed release (`RELEASE.json`, package identity, code and
directories not writable, outside the bridge's checkout, no `DC_ARGS` override).
There is no fallback to the development checkout. `/authority` reports
`runtime.{dir, releaseRequired, installedRelease:{realDir, version, commit, readOnly}}`.

Readiness: the bridge's `/authority` reports the pinned runtime and
`enforcement.{executionTokenConfigured, capabilityVerificationConfigured,
currentAuthorityCredentialConfigured}`; the edge's `/jc/ready` is ready only when
all hold and ACS issuance is reachable.

## Migration from the Desktop Commander-hosted JC

Prepared, not executed. Do not change live services without review and explicit
rollout approval.

1. Verify: `npm test -w apps/jace-commander`, `ACS_DC_E2E=1 npx vitest run tests/e2e/acs-jc-mcp`, `npm run jc:verify-release`.
2. Apply ACS migration 076 (`jace_commander_native_tools`) through the normal
   procedure. 075 is claimed by two unmerged branches; neither touches what 076
   rebuilds and the runner applies any missing version, so either order works.
3. Provision a dedicated ACS credential for JC with role `service` and scope
   `acs:read` only (not the worker token) into
   `~/.config/acs/jc-authority.token` (0600). Without it every mutation fails closed
   and `/jc/ready` stays not ready.
4. Install the release (`install-user-release.sh`). Copy
   `apps/dc-mcp-gateway/deploy/jace-commander-bridge.env.example` to
   `~/.config/acs/jc-bridge.env` (0600) and fill the placeholders. The unit, not
   that file, sets `JC_ACS_AUTHORITY_TOKEN_FILE`, `JC_RUNTIME_DIR`, and
   `JC_REQUIRE_INSTALLED_RELEASE`. Optional workload overrides
   (`JC_WORKLOAD_NETWORK=host`, `JC_SANDBOX_HIDE`, `JC_SANDBOX_WRITABLE`) belong
   in the env file. `JC_ACS_TOKEN` is the model-facing tool credential only and
   never satisfies the authority check.
5. Replace the old unit with the template, `systemctl --user daemon-reload`, restart
   `jace-commander-mcp`, and check `127.0.0.1:8003/authority` (`runtime.dir` must be
   the native release, never `vendor/desktop-commander`) and the edge `/jc/ready`.
6. Rollback: re-point `current` at the previous release, or set
   `JC_RUNTIME_DIR` back, and restart. The vendor Desktop Commander tree is not
   used by JC and is unaffected either way.

The public endpoint `https://cachyos-x8664.tailaa6d41.ts.net/jc/mcp`, Tailscale
Serve, live credentials and the privileged helper were not changed by this work.
