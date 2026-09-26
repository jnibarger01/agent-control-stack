# Jace Commander

A Desktop-Commander-style MCP server for the Jace stack. It gives an agent read
access to ACS, codex-swarm, the visualizer, Mission Router state and LoopTrace
chains. It also gives **root on jacen-ubuntu, one exact command at a time,
only after a human approves that command in ACS**.

Source: `src/jace-commander/`. Deploy: `deploy/jace-commander/`. Tests:
`test/test-jace-commander-*.js`.

## Status

| Piece | State |
| --- | --- |
| MCP server, 8 tools, managed/standalone modes | Implemented and tested |
| `acs.jc.v1` capability verifier | Implemented and tested (23 negative/positive cases) |
| Root privileged helper, sudoers rule, installer | Implemented. Live-tested in a container with a real `sudo` and an unprivileged user |
| CLI device login (ACS RFC 8628 + Ed25519 PoP) | Implemented and tested against a fake ACS |
| LoopTrace chain (byte-compatible with ACS `agentos-contracts`) | Implemented. Pinned to a vector produced by the ACS reference code |
| ACS issuing `acs.jc.v1` capabilities | Implemented in ACS (`POST /jc/capability/issue`, branch `feat/jc-capability-issuer`). Interop vector pinned in both repos (`test/test-jace-commander-acs-interop.js`) |
| Gateway route `https://jacen-ubuntu.tailaa6d41.ts.net/jc/mcp` | Not wired yet, see [Deployment](#deployment) |

Until the ACS issuer is deployed and the gateway calls it, managed mode rejects
every call and `privileged_exec` can never run. The feature is fail-closed until then.

## Architecture

```text
ChatGPT / Claude
   │ HTTPS
   ▼
Tailscale Funnel  https://jacen-ubuntu.tailaa6d41.ts.net
   │
   ▼
desktop-commander-mcp-gateway  server.js  (OAuth 2.1 AS, consent passphrase; same flow as DC)
   │  per tools/call: ask ACS for a capability (managed mode), inject _meta.acsCapability
   ▼
bridge (stdio ⇄ Streamable HTTP)
   │ stdio
   ▼
jace-commander serve        (runs as the agent user, e.g. jacen)
   ├── acs_read / acs_submit_mission ──► ACS gateway   127.0.0.1:3000  (sole authority)
   ├── swarm_read ─────────────────────► codex-swarm   127.0.0.1:9711  (read-only)
   ├── visualizer_read ────────────────► visualizer    127.0.0.1:<port> (read-only, same UID)
   ├── mission_router_list ────────────► ~/.mission-router (read-only; router is retired)
   ├── looptrace_verify ───────────────► LoopTrace JSONL under allowed roots
   └── privileged_exec ── sudo -n ─────► /usr/local/libexec/jace-commander/jc-privileged-helper  (root)
                                           re-verifies the capability, audits, then execs
```

Authority follows ACS ADR 0009, 0011 and 0017. **ACS is the only component
that decides.** codex-swarm, Mission Router, LoopTrace and the visualizer are
read here, never driven around ACS. The only write is `acs_submit_mission`,
which asks ACS to create a governed work item.

## Tools

| Tool | Scope (`acs.jc.v1`) | Approval | What it does |
| --- | --- | --- | --- |
| `jc_status` | `integration.read` | no | Mode, endpoints, reachability, and whether sudo will run the helper |
| `acs_read` | `integration.read` | no | `health`, `work-items[?status]`, `work-item/{id}` (events, attempts, leases) |
| `acs_submit_mission` | `integration.write` | no | `POST /work-items`. ACS policy returns allow / deny / require_approval |
| `swarm_read` | `integration.read` | no | codex-swarm `health`, `mission-control`, `runs`, `status`, `task` |
| `visualizer_read` | `integration.read` | no | `system-status`, `runtimes`, `executions`, `approvals`, `alerts`, `agents` |
| `mission_router_list` | `fs.read` | no | Mission ids/states plus JSONL chain verification. Goals are never returned |
| `looptrace_verify` | `fs.read` | no | Verify a LoopTrace chain under an allowed root |
| `privileged_exec` | `process.privileged` | **yes** | Run one exact argv as root |

Views are fixed allowlists. Callers cannot supply upstream paths.

## The sudo flow

1. The agent calls `acs_submit_mission` describing the exact command (for
   example `argv: ["/usr/bin/apt-get","update"]`).
2. ACS policy marks it `require_approval`. A human approves the exact
   `actionHash` in ACS Mission Control (or via the device-verified CLI).
3. On the agent's `privileged_exec` call, the gateway asks ACS for a
   capability. ACS consumes the approval and signs an `acs.jc.v1` capability
   bound to that exact `{argv, cwd, timeoutMs, stdin}`, with `approvalId`, a
   TTL of 30 s or less, and a single-use nonce.
4. `jace-commander` forwards `{capability, arguments}` to the helper through
   `sudo -n`. It makes no decision itself.
5. The helper, as root, with **root-owned** config, checks all of the following:
   * the Ed25519 signature and key id
   * `version`, `issuer`, `audience`, `runtimeId`
   * `toolName == privileged_exec` and `scopes == ["process.privileged"]`
   * `approvalId` is present
   * the arguments match exactly (strict canonical JSON) and the invocation hash matches
   * the time window
   * the nonce is unused (root-owned store)

   It then appends a `tool_call_started` intent to the root-owned
   hash-chained audit log, executes without a shell (absolute `argv[0]`,
   scrubbed env, own process group, timeout, 1 MiB output caps), and appends
   `tool_call_finished` with the exit code and output digests.

"Free" sudo means **no local command blocklist second-guesses an approved
command**. Once a human approves an exact argv, it runs as root. It does not
mean ambient sudo: every capability authorizes one invocation, once. If the
audit write fails, the command does not run. If the audit chain has been
tampered with, privileged execution stops until it is repaired.

### Why the helper, not the MCP server, verifies

The MCP server runs as the agent user. Anything that user can modify is
agent-controllable, so it cannot be the gate. The only elevation path is a
sudoers rule for one root-owned program with an empty argv (`""`). That
program checks the ACS signature against a root-owned public key. There is
**no signing key on this host**: ACS keeps the private key. This repo has no
production signing code; `test/fixtures/jc-mint.js` is for tests only.

## Contract: `acs.jc.v1`

Identical to [`acs.dc.v1`](https://github.com/jnibarger01/agent-control-stack/blob/main/docs/protocol/acs-dc-v1-capability-contract.md)
(envelope `{payload, signature, keyId}`, `strictCanonicalJsonV1`, Ed25519,
exact payload keys, conditional `approvalId`, TTL of 30 s or less, 5 s skew,
single-use `(keyId, nonce)`), with these differences:

| Field | `acs.dc.v1` | `acs.jc.v1` |
| --- | --- | --- |
| `version` | `acs.dc.v1` | `acs.jc.v1` |
| `audience` | `desktop-commander` | `jace-commander` |
| scope vocabulary | `fs.*`, `network.*`, `process.exec`, `process.spawn` | `fs.read`, `integration.read`, `integration.write`, `process.privileged` |
| invocation hash | `sha256("acs:desktop-commander-invocation:v1\n" + legacyCanonical({toolName, arguments}))` | `sha256("acs:jace-commander-invocation:v1\n" + strictCanonicalJsonV1({toolName, arguments}))` |

It is a new version rather than an extension because `acs.dc.v1` fixes its
scope vocabulary, and ACS policy (`policy-gate/src/rules.ts`) and the DC
adapter both hard-deny `sudo`. A DC capability cannot be replayed here: the
version and audience are rejected. The reverse also holds, because DC rejects
the `jace-commander` audience.

## ACS work required

Items 1 and 2 are implemented in `agent-control-stack`
(`docs/protocol/acs-jc-v1-capability-contract.md`). Item 3 is still open.

1. An `acs.jc.v1` issuer route, e.g. `POST /jc/capability/issue`, mirroring
   `/dc/capability/issue`. It should use a dedicated bridge worker identity, a
   separate Ed25519 key (`ACS_JACE_COMMANDER_CAPABILITY_PRIVATE_KEY`), the
   tool→scope table in `src/jace-commander/contract.ts`, and the invocation
   hash above.
2. A policy rule for `privileged_exec`: **always `require_approval`, never
   `allow`**, with self-approval denied (the existing high/critical rule),
   `approvalId` consumed transactionally at issuance, and the approval bound
   to the exact normalized argv. Today `isSudo()` returns `forbidden`. The
   change is to route `privileged_exec` to `require_approval` while keeping
   `sudo` inside ordinary DC `run_command` forbidden.
3. Runtime identity bootstrap for `jace-commander` (same §7 handshake as DC).
   This repo does not implement the bootstrap handshake yet. The runtime is
   pinned by `JC_RUNTIME_ID` / `runtimeId` in the helper config.

## Authentication

* **MCP clients (ChatGPT/Claude)** use the same OAuth 2.1 flow and consent
  passphrase at the same Tailscale Funnel host as Desktop Commander. That
  flow lives in `desktop-commander-mcp-gateway`.
* **CLI / operator** run `jace-commander login`. This is ACS's RFC 8628 device
  flow (`/oauth/device/code` → approve at `/device/verify` → poll
  `/oauth/token`), with an Ed25519 device key proving possession
  (`acs-device-code-proof-v1`). It works like DC's "open URL, approve, CLI
  polls" pairing. Credentials are stored `0600` in `~/.jace-commander/`, and
  `JC_ACS_TOKEN` overrides them for services.
* **jace-auth** is the IdP behind ACS (`ACS_OAUTH_ISSUER`, audience
  `…/resources/agent-control-stack`), so ACS sessions and tokens can come from
  jace-auth. Jace Commander needs no direct jace-auth client.
* **Supabase is not used.** DC's hosted remote-device channel uses it; nothing
  on the jacen-ubuntu path needs it.

## Configuration

| Env | Default |
| --- | --- |
| `JC_STATE_DIR` | `~/.jace-commander` |
| `JC_PUBLIC_MCP_URL` | `https://jacen-ubuntu.tailaa6d41.ts.net/jc/mcp` |
| `JC_ACS_URL` | `http://127.0.0.1:3000` |
| `JC_SWARM_URL` / `JC_SWARM_TOKEN` (or `SWARM_OPERATOR_TOKEN`) | `http://127.0.0.1:9711` |
| `JC_VISUALIZER_URL` | unset (the visualizer uses an ephemeral port unless pinned; must be `http://127.0.0.1:<port>`) |
| `JC_MISSION_ROUTER_DIR` | `~/.mission-router` |
| `JC_TRACE_ROOTS` | `~/.looptrace:~/.mission-router:$JC_STATE_DIR/traces` |
| `JC_RUNTIME_ID` | `jc-<hostname>` |
| `JC_ACS_PUBLIC_KEY`, `JC_ACS_KEY_ID` | required for `serve` in managed mode |
| `JC_PRIVILEGED_HELPER`, `JC_SUDO_PATH` | `/usr/local/libexec/jace-commander/jc-privileged-helper`, `/usr/bin/sudo` |

The helper does **not** read these. It reads only `/etc/jace-commander/privileged.json`.

## Deployment

```bash
npm run build
sudo ACS_JC_PUBLIC_KEY=<from ACS> ACS_JC_KEY_ID=<id> JC_RUNTIME_ID=jc-jacen-ubuntu \
     JC_AGENT_USER=jacen deploy/jace-commander/install-privileged-helper.sh
sudo -n -l /usr/local/libexec/jace-commander/jc-privileged-helper   # as jacen: must list the helper
jace-commander login                                                # device flow against ACS
JC_ACS_PUBLIC_KEY=... JC_ACS_KEY_ID=... JC_RUNTIME_ID=jc-jacen-ubuntu jace-commander serve
```

The installer refuses a node binary that is not root-owned (for example
nvm or `~/.local`). It copies only the helper's five modules to
`/opt/jace-commander`, validates the sudoers file with `visudo -cf`, and
creates `/var/lib/jace-commander/nonces` and `/var/log/jace-commander` as
root `0700`.

Gateway wiring (follow-up in `desktop-commander-mcp-gateway`): run a second
bridge instance with `jace-commander serve` as its child on its own loopback
port. Route `/jc/mcp` in `server.js` to it, with the same OAuth check and a
`/jc/capability/issue` call in managed mode.

## Known risks

* **Agent as your own user.** If the MCP runs as `jacen`, the agent can edit
  jacen's shell rc files and capture jacen's sudo password the next time it
  is typed. That bypasses ACS entirely. This risk exists independently of
  this server. Run `jace-commander` (and DC) as a dedicated `jc-agent` user
  and set `JC_AGENT_USER=jc-agent`.
* **Approval quality.** The helper enforces exactly what was approved.
  Approving `/bin/sh -c '…'` approves whatever that script does.
* **Post-execution audit gap.** If the outcome append fails after the command
  ran, the result reports `AUDIT_APPEND_FAILED_AFTER_EXECUTION`. The intent
  record already exists. A database cannot roll back an external side effect
  (ACS ADR 0011, two-boundary rule).
* **Audit log growth.** The helper re-verifies the whole privileged audit
  chain before each append, and chain files are capped at 32 MiB (about 20k
  privileged runs). At the cap, privileged execution fails closed with
  `PRIVILEGED_AUDIT_UNAVAILABLE`. Archive and replace
  `/var/log/jace-commander/privileged-audit.jsonl` before then.
* **Install-time trust.** The installer copies `dist/` into root-owned
  `/opt/jace-commander`. Build from a checkout the agent user cannot write
  to, or review `dist/` first.
* **Local traces are telemetry.** `~/.jace-commander/traces` is a LoopTrace
  projection for the visualizer and LoopTrace. The ACS SQLite chain is still
  the only canonical audit.

## Verification

```bash
npm run build
for t in test/test-jace-commander-*.js; do node "$t"; done
```
