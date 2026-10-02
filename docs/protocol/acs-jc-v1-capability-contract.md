# ACS/Jace Commander v1 Capability Contract (`acs.jc.v1`)

Status: implemented (`POST /jc/capability/issue`). The verifier and the root
helper live in `jnibarger01/desktop-commander` (`src/jace-commander/`,
`docs/jace-commander.md`).

`acs.jc.v1` authorizes calls to the Jace Commander MCP server. It includes
`privileged_exec`, which runs one exact argv as root on the managed host.
The contract is **identical to [`acs.dc.v1`](acs-dc-v1-capability-contract.md)**
in every rule not listed below:

- envelope `{payload, signature, keyId}`
- `strictCanonicalJsonV1`
- Ed25519
- exact payload keys, with a conditional `approvalId`
- TTL of 30 s or less, with 5 s skew
- single-use `(keyId, nonce)`

## Differences from `acs.dc.v1`

| Field                  | `acs.dc.v1`                                                                             | `acs.jc.v1`                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `version`              | `acs.dc.v1`                                                                             | `acs.jc.v1`                                                                                                                                                  |
| `audience`             | `desktop-commander`                                                                     | `jace-commander`                                                                                                                                             |
| scope vocabulary       | `fs.read`, `fs.write`, `process.exec`, `process.spawn`, `network.read`, `network.write` | `fs.read`, `fs.write`, `integration.read`, `integration.write`, `process.read`, `process.exec`, `process.privileged`, `git.read`, `git.write`, `git.network` |
| `invocationHash`       | `sha256("acs:desktop-commander-invocation:v1\n" + legacyCanonical(...))`                | `sha256("acs:jace-commander-invocation:v1\n" + strictCanonicalJsonV1({toolName, arguments}))`                                                                |
| signing key            | `ACS_DESKTOP_COMMANDER_CAPABILITY_PRIVATE_KEY`                                          | `ACS_JACE_COMMANDER_CAPABILITY_PRIVATE_KEY` (must be a different key)                                                                                        |
| issuer worker identity | `acs-dc-bridge`                                                                         | `acs-jc-bridge`                                                                                                                                              |
| issuance table         | `desktop_commander_capability_issuances`                                                | `jace_commander_capability_issuances` (migration 028)                                                                                                        |
| admin execution mode   | may auto-approve                                                                        | may auto-approve ordinary gated mutations; **never** `privileged_exec`                                                                                       |

Because the version and audience differ, a capability from either contract is
rejected by the other verifier.

## Tools

| Tool                                                                  | Scopes               | Approval                                        | Policy action kind     | Work-item risk |
| --------------------------------------------------------------------- | -------------------- | ----------------------------------------------- | ---------------------- | -------------- |
| `jc_status`, `acs_read`, `swarm_read`, `visualizer_read`              | `integration.read`   | no                                              | `jc.integration.read`  | low            |
| `acs_submit_mission`                                                  | `integration.write`  | no                                              | `jc.integration.write` | low            |
| `mission_router_list`, `looptrace_verify`                             | `fs.read`            | no                                              | `jc.fs.read`           | low            |
| `list_directory`, `get_file_info`, `read_file`, `read_multiple_files` | `fs.read`            | no                                              | `jc.fs.read`           | low            |
| Ordinary gated mutations (see manifest)                               | tool-specific        | required in strict; ACS may grant in admin mode | tool-specific          | medium/high    |
| `privileged_exec`                                                     | `process.privileged` | required in strict; ACS may grant in admin mode | `privileged.exec`      | critical       |

In the canonical manifest, `requiresApproval` means policy requires an approval
record in strict mode. In admin mode, every managed approval-gated mutation may
receive an ACS `acs:admin` approval, including `privileged_exec`.

The argument schemas are strict (unknown keys are rejected) and **are never
rewritten**. `normalizedArguments` equals the delivered arguments. For
`privileged_exec` the arguments are
`{argv: string[1..256], cwd?: abs path, timeoutMs?: 1..600000, stdin?: <=64KiB}`,
where `argv[0]` is a normalized absolute path and no argument contains NUL.

The canonical tool list, schemas, scopes, path arguments and CLI verbs live in
`packages/jc-tool-manifest`. Migration 029 moves the issuance allowlist out of
migration 028's `CHECK (tool_name IN (...))` and into the append-only
`jace_commander_tools` table, which `jace_commander_capability_issuances.tool_name`
references by foreign key. `tests/e2e/jc-tool-contract-drift.test.ts`
fails if the manifest and that table diverge.

**Filesystem containment.** For every tool with `pathArguments`, the route
checks each path against `ACS_JACE_COMMANDER_ALLOWED_ROOTS` /
`ACS_JACE_COMMANDER_DENIED_ROOTS` before creating a work item or signing. With
no roots configured it returns 503 `jace_commander_containment_unconfigured`.
A path outside the roots gets 403 `{decision:"deny", reason:"path_not_allowed"}`.
Jace Commander re-checks the realpath against its own roots after it verifies
the capability.

Interop vectors (the ACS and desktop-commander tests both pin these):

- `invocationHash("privileged_exec", {argv:["/usr/bin/apt-get","update"],timeoutMs:120000})`
  = `3c91cc6896164f03068b6f377290f64589a7f034e5135b6a2940651ea4b10bc6`
- `invocationHash("acs_read", {view:"health"})`
  = `92aa7dd353ab8a15eadd7524b00e43aff6287cca90aef6194172861f41991461`

## Ordinary mutation admin-mode rules

For approval-gated non-root JC mutations (`write_file`, `create_directory`,
`move_file`, `edit_block`, `start_process`, `kill_process`, `git_add`,
`git_commit`, `git_fetch`, and `git_push`), canonical `admin` mode may
record an `acs:admin` approval only after the managed-authority gate passes.
The request then continues through the same lease, capability, containment, and
audit path as a human-approved request. After any admission wait, ACS performs
a defense-in-depth mode/authority recheck, then the exact-id claim enforces the
canonical `admin` mode and `acs:admin` approval origin inside the same
`BEGIN IMMEDIATE` SQLite transaction that creates the lease and consumes the
approval. A concurrent switch to `strict` therefore cannot interleave between
the fence and approval consumption. In `strict` mode, candidate reuse also
excludes work items carrying an `acs:admin` grant, so an approval left behind
by an interrupted admin-mode request cannot cross the mode boundary.

Migration 039 introduced durable JC admin approvals. Migration 040 extends the
durable issuance constraint so `acs:admin` may approve every approval-gated JC
tool, including `privileged_exec`. Requester self-approval remains forbidden
for every approval-gated JC tool.

## `privileged_exec` approval rules

These are enforced in three independent places.

1. **Policy** (`packages/policy-gate/src/rules.ts`):
   - `privileged.exec` always evaluates to `require_approval`
     (`approval:privileged-exec`), regardless of risk or flags.
   - In admin mode, `acs:admin` may satisfy that approval record.
   - An approval by the requester evaluates to `deny` (`deny:self-approval`).
   - The argv is not mapped to `command`, so the ordinary `deny:sudo`,
     shell-metacharacter and destructive rules still apply to every other
     action kind unchanged.
2. **Route** (`/jc/capability/issue`):
   - The admin branch applies to every approval-gated JC tool, including
     `privileged_exec`.
   - In strict mode, candidate reuse excludes work items carrying an
     `acs:admin` grant.
   - An approval-required tool with no `require_approval` evaluation returns
     409, not a signed capability.
3. **Durable issuance gate** (`SqliteJaceCommanderIssuanceRegistry` plus the
   migration 040 `CHECK` constraints):
   - The lease-bound approval must be `consumed` and bound to this plan,
     action and request hash, and must not expire before the capability.
   - The approval must not come from the requesting subject; `acs:admin` is
     accepted when canonical admin mode created the grant.
   - At most one capability is issued per approval, and at most one per
     lease/invocation.
   - The nonce hash is unique.

## Flow

1. The bridge calls `POST /jc/capability/issue`. It sends
   `{client_id, tool, argsSummary, correlationId?}` with `x-jc-actor` (the
   legacy `x-dc-actor` is still accepted; two headers that disagree get 400),
   authenticated as `acs-jc-bridge`.
2. For `privileged_exec`, ACS creates a `needs_approval` work item (risk
   critical; title `ROOT: <argv>`, plus an `approvalSummary` with argv, cwd,
   timeout and stdin size). In strict mode it returns the normal 409 approval
   challenge. In admin mode ACS records the exact `acs:admin` approval itself.
3. ACS claims the approved item under a fresh lease, consumes the approval,
   records the issuance, appends `jace_commander.capability_issued` to the
   canonical audit chain, and returns the signed envelope.
4. The approval is consumed. The same argv needs a new approval record next time;
   admin mode creates that record automatically.

## Configuration

```
ACS_JACE_COMMANDER_CAPABILITY_PRIVATE_KEY=<base64url PKCS#8 DER Ed25519>
ACS_JACE_COMMANDER_CAPABILITY_KEY_ID=<key id>
ACS_JACE_COMMANDER_RUNTIME_ID=<must equal the MCP server's JC_RUNTIME_ID and the helper's runtimeId>
ACS_JACE_COMMANDER_ALLOWED_ROOTS=<:-separated absolute paths; unset = filesystem tools fail closed>
ACS_JACE_COMMANDER_DENIED_ROOTS=<optional>
```

All three must be set together. If they are partial or invalid, the route
answers 503 and issues nothing. Give the `acs-jc-bridge` worker credential
only to the Jace Commander gateway bridge.

## Not yet implemented

- A runtime identity bootstrap handshake for Jace Commander (the equivalent
  of `acs.dc.v1` §7). The runtime is pinned by configuration on both sides.
- Result submission for jc attempts. Leases expire after `JC_BRIDGE_LEASE_MS`.
  The helper's root-owned audit chain is the execution evidence until
  results are wired.
