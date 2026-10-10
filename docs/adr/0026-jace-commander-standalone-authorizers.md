# ADR 0026: Jace Commander provider registry, authorizers, and optional ACS

Status: Accepted. Slices 1-6 implemented (see [Implementation notes](#implementation-notes))
Date: 2026-10-09
Supersedes the assumption that Jace Commander (JC) cannot operate without ACS.
Builds on the 2026-10-05 standalone architecture draft and its 2026-10-09 review.

This ADR settles the open design questions before code. Everything below was
checked against `vendor/desktop-commander/src/jace-commander` at `b2b146a`
(`server.ts`, `contract.ts`, `privileged-core.ts`, `looptrace.ts`) and
`apps/dc-mcp-gateway/managed.js`.

## Context

Verified at `b2b146a`:

- Managed mode requires an `acs.jc.v1` capability for **every** call, including
  `ping`; an ACS outage is a total JC outage that fails closed.
- `--standalone` serves only the 24 read-only tools and refuses the other 12
  with `JC_STANDALONE_TOOL_REFUSED`. It is a development mode.
- Capability **verification** is offline (pinned ACS public key). ACS is needed
  only at the OAuth edge for **issuance**, and for best-effort result reporting.
- The nonce store is already file-backed (`FileNonceStore`, `O_EXCL`), shared
  between the server and the root helper, and fails closed.
- The local trace (`JsonlTraceChain`) is a hash chain re-verified under a lock
  before every append, but the server's `recordTrace` swallows write failures.
- The root helper (`privileged-core.ts`) already writes a durable audit intent
  record before it executes and reads a root-owned config.

## Decisions

### D1. Fail-closed rules (review P0/P1)

1. **`admin-delegated` never degrades.** It verifies an ACS `acs.jc.v1`
   capability exactly like `acs-capability`. If ACS is unavailable the call
   fails with `ACS_UNAVAILABLE`. It is never re-evaluated under the `local`
   authorizer, and a call authorized by one authorizer is never retried under
   another.
2. **Approval lifetime is separate from execution lifetime.** A local approval
   is a pending record with its own TTL (default 15 minutes) that can be
   *claimed once*. Claiming mints a `jc.local.v1` token valid for at most 30 s
   bound to one invocation hash. The token is single-use; the approval is
   consumed by the claim. Any retry after a claim, including after a failed
   execution, needs a **new** approval. An indefinite admin-mode toggle in ACS
   does not imply reusable execution tokens.
3. **Policy errors deny.** If a policy is configured (`JC_POLICY_PATH` is set,
   or a policy file exists at the default path or the user layer) and it is
   missing, unreadable, invalid, or fails the immutability check (D3), every
   tool except the `jc.meta` diagnostics (`ping`, `get_config`, `jc_status`,
   `jc_doctor`, `looptrace_verify`) is denied with `JC_POLICY_INVALID`, so the
   operator can still diagnose. Built-in defaults apply only when NO policy was
   ever configured, because defaults carry no denied roots.
4. **Trace failure denies mutation.** For `local` and `admin-delegated`
   calls in classes above `read`, a durable *intent* record is written before
   the handler runs. If it cannot be written the call is refused with
   `JC_TRACE_UNAVAILABLE`. Reads and managed-mode calls keep today's best-effort
   behavior so managed parity is unchanged.
5. **Unknown means refused.** Unknown tools, unknown providers, unknown
   authorizers and unknown policy keys are errors, not defaults.

### D2. Providers, classes, authorizers

Providers are the table in the 2026-10-05 draft (`jc.fs`, `jc.git`,
`jc.process`, `jc.privileged`, `jc.meta`, `jc.integration`, `acs`). The
canonical manifest stays the source of truth for names, schemas and scopes; the
registry only adds the provider mapping. Startup asserts every manifest tool
has exactly one provider and every provider tool exists in the manifest. The
manifest is **not** changed, so `manifestHash` and the ACS issuer are
unaffected.

Risk classes are derived from scopes, never configured:

| scopes                                                 | class        |
| ------------------------------------------------------ | ------------ |
| `*.read`                                               | `read`       |
| `fs.write`, `git.write`                                | `mutate`     |
| `process.exec`                                         | `exec`       |
| `git.network`, `integration.write`                     | `network`    |
| `process.privileged`                                   | `privileged` |

A tool with mixed scopes takes the most severe class
(`privileged > exec > network > mutate > read`).

Authorizer resolution is **per-tool override, then provider, then server
default**. Values: `local`, `acs-capability`, `admin-delegated`. A fourth
internal result, `refused`, exists only for the `standalone` preset.

Presets (the only way to get a table without a policy file):

| preset       | resolution                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------- |
| `managed`    | every tool `acs-capability` (default; identical to today)                                           |
| `standalone` | the 24 read-only tools `local`/`allow`; the other 12 `refused` (identical to today, development)   |
| `local`      | **new**: every provider `local`; class decisions from the policy (defaults below)                   |

`standalone` is **not** redefined. `local` is a distinct preset (review
recommendation) so no existing standalone deployment gains permissions.

Class decisions in `local`: `allow` (constraints enforced, audited), `approve`
(human approval via `approverd`), `deny`. Defaults: `read: allow`, `mutate:
approve`, `exec: approve`, `network: approve`, `privileged: approve`.
`privileged` can never be `allow`. `network` defaults to `approve` and the
documented DC-like profile keeps it `approve`.

### D3. Policy trust model (resolves operator questions 1, 3)

The model must not be able to widen its own authority.

- **Rule.** A policy file may *loosen* anything above the built-in defaults
  only if the JC process cannot modify it: the file and every parent directory
  must not be a symlink, must not be group/world-writable, and
  `access(W_OK)` must **fail** for the process's effective uid on the file and
  its directory chain. This holds for a root-owned policy and for an
  operator-owned one when JC runs as a distinct account.
- **Two layers.** The *system layer* is `/etc/jace-commander/policy.json`
  (override path: `JC_POLICY_PATH`). It is subject to the rule above. An
  optional *user layer* `<stateDir>/policy.user.json` may only **tighten**:
  stricter class decisions, extra denied roots, narrower roots, fewer allowed
  commands. A user-layer entry that loosens is rejected as `JC_POLICY_INVALID`.
  The user layer lives under the already-denied state dir.
- **Dev override.** `JC_POLICY_UNSAFE_DEV=1` accepts a self-writable system
  policy. It is read from the process environment only (never from tool
  arguments or child env), surfaces in `jc_status`, and makes `jc_doctor` fail
  its required policy check so it cannot pass unnoticed.
- **Hash.** The loaded effective policy has a canonical SHA-256 recorded in
  every trace record. The policy is loaded at startup and on explicit reload,
  never re-read per call from a writable location.
- **Denied roots.** The policy path, the approver socket directory and the
  approver config are added to the fs tools' denied roots.
- **Honest limits.** `exec: allow` is not a security boundary. Command
  allow/deny patterns are guardrails; an allowed interpreter runs arbitrary
  code. The DC-like profile must be paired with OS containment
  (`deploy/jace-commander/systemd/jace-commander.service` hardening, dedicated
  `jc` user). This is stated in `jc_doctor` output for the `local` preset.

### D4. `approverd` and `jc.local.v1` (resolves operator question 4)

Deviation from the draft: Node has no portable `SO_PEERCRED`. Identity
separation uses **two Unix sockets whose filesystem permissions are the
identity check**:

- `request.sock` — owner `jc-approverd`, group `jc`, mode `0660`. Used by the
  JC server (user `jc`) to submit invocations and to claim approvals. It cannot
  list, approve or reject.
- `decide.sock` — owner `jc-approverd`, group `jc-approvers`, mode `0660`.
  Used by `jace-commander approve|reject|pending` run by the human operator
  (a member of `jc-approvers`). The `jc` user is **not** in that group and the
  socket directory is `0750`, so the server, the model and any child process of
  the server cannot reach it.
- `approve` additionally requires `stdin` and `stdout` to be TTYs and an
  interactive typed confirmation showing the exact action; non-TTY refuses.
- The signing key (Ed25519, `0600`) is owned by `jc-approverd` only. The JC
  server holds **no** signing key and only the public key.

Flow: server → `request` (tool, normalized args, invocation hash, runtime id)
→ `JC_LOCAL_APPROVAL_REQUIRED` with `approvalRequestId` returned to the client →
human `jace-commander approve <id>` → client retries the **identical** call →
server → `claim` (invocation hash) → approverd consumes the approval and mints
`jc.local.v1`
`{version, tokenId, runtimeId, tool, invocationHash, approverId, issuedAt,
expiresAt ≤ 30 s, nonce}` → server (or root helper for `privileged`) verifies
and executes. Nonces use the existing `FileNonceStore`.

Verification anchors: the server verifies `jc.local.v1` for `mutate`, `exec`,
`network`. The root helper verifies it for `privileged` and keeps **both**
trust anchors (ACS and local) in its root-owned config, selecting by `keyId`;
key ids must differ; neither anchor can come from the environment when running
as root (existing behavior, extended).

### D5. Trace and ACS mirroring

- Local chain records every call (all authorizers) with `authorizer`,
  `provider`, `class`, `policyHash` and an intent/result pair for classes above
  `read` under `local`/`admin-delegated` (D1.4).
- The ACS mirror is a **bounded, ordered, idempotent outbox** (JSONL spool +
  cursor) that ships already-redacted local records with the chain head so ACS
  can detect gaps. Backpressure drops *mirror* delivery state only (it records
  `mirror_overflow` locally); it never drops, reorders or blocks a local record.
- Known limitation, stated plainly: a hash chain on the same host proves
  tampering only against an actor that cannot rewrite the whole file. Stronger
  guarantees come from the helper's root-owned chain (privileged) and from ACS
  holding the mirrored chain head. Deployment guidance adds `chattr +a` on the
  trace directory; checkpoint signing is out of scope for this ADR.

### D6. ACS optional (resolves operator question 2)

- Per-provider `acs: off | optional | required`. Existing deployments default
  to `required` for every provider (no behavior change); the `local` preset
  defaults to `off` for local providers and `optional` for the `acs` provider.
- With an `acs-capability` tool and a missing capability, if ACS is configured
  and its readiness probe fails the server returns `ACS_UNAVAILABLE` (distinct,
  actionable), otherwise `JC_CAPABILITY_MISSING` as today.
- One provider failing never affects another; `jc_status` reports each
  provider's health separately. ACS health is probed at `/readyz` (60 ms), not
  the deep `/health` (about 3.2 s), and cached briefly.
- **The OAuth edge stays in this repo** (`apps/dc-mcp-gateway`). It remains the
  *authentication* boundary for every call, including local ones. Only
  capability **issuance** is skipped, and only for tools whose effective
  authorizer is `local`. The server remains the authority: if the edge omits a
  capability for a tool the server resolves to `acs-capability`, the server
  denies. If the edge's policy file is missing or invalid it issues exactly as
  today (fail toward ACS, not toward local). Edge and server provider maps are
  compared by the drift test.
- A deployment with no ACS at all sets `JC_ACS_OPTIONAL=1` on the edge; it then
  needs no `ACS_JC_GATEWAY_TOKEN`, and any `acs-capability` tool is refused with
  `ACS_UNAVAILABLE`.

### D7. Compatibility

- `acs.jc.v1` is unchanged. `jc.local.v1` is additive and versioned separately.
- No change to `manifest.generated.ts` or `packages/jc-tool-manifest`.
- Dual-repo lockstep applies only to protocol-breaking changes. Everything in
  this ADR ships from this monorepo (the JC server is vendored in-tree).
- Absent new config means today's managed behavior. Parity is enforced by tests.

## Failure matrix (target behavior)

| Failure                         | `local` tools                      | `acs-capability` / `admin-delegated` | Privileged                                        |
| ------------------------------- | ---------------------------------- | ------------------------------------ | ------------------------------------------------- |
| ACS down                        | unaffected                         | `ACS_UNAVAILABLE`, fail closed       | local approval path unaffected                    |
| `approverd` down                | `allow` classes unaffected         | unaffected                           | fail closed (`JC_LOCAL_APPROVAL_UNAVAILABLE`)     |
| Mirror outbox full / ACS slow   | unaffected, local trace intact     | unaffected                           | unaffected                                        |
| Policy missing/invalid/writable | all but `jc.meta` denied (`JC_POLICY_INVALID`) | n/a                         | denied                                            |
| Trace intent cannot be written  | non-read denied (`JC_TRACE_UNAVAILABLE`) | n/a                            | helper's own audit rule unchanged                 |
| One provider failing            | other providers unaffected         | other providers unaffected           | n/a                                               |

## Rollout

Each slice is independently shippable, leaves managed behavior byte-identical,
and carries its own tests. Order of merge: 1 → 2 → 3 → 4 → 5 → 6.

1. **Provider registry**: mapping + coverage assertions, per-provider health in
   `jc_status`, `/readyz` probe. No behavior change. Managed/standalone parity
   tests.
2. **`local` authorizer, read class** and per-call resolver dispatch;
   `standalone` expressed as a preset with identical behavior; new `local`
   preset.
3. **Local policy**: `allow` classes with constraints, immutability rule, hash
   in trace, intent/result records, edge routing change, systemd hardening unit.
4. **`approverd` + `jace-commander approve` + `jc.local.v1`** for `approve`
   classes. Installing the OS accounts and units is a root action the operator
   performs; the repo ships the installer, not an executed install.
5. **Root helper dual trust anchors** for `privileged`.
6. **ACS optional**: outbox mirror, `acs: off|optional|required`,
   `ACS_UNAVAILABLE`, opt-in `admin-delegated`.

## Consequences

- Operators gain a DC-like mode that cannot widen itself and cannot approve its
  own privileged actions, at the cost of an explicit install step and an
  immutable policy file.
- `exec: allow` remains arbitrary code execution by design; the control is the
  OS account and unit hardening, not the command pattern.
- `approverd` identity separation relies on filesystem permissions and group
  membership rather than socket credentials; misconfigured group membership
  breaks the guarantee, so `jc_doctor` verifies socket modes, owners and that
  the server's uid cannot open `decide.sock`.

## Implementation notes

Deviations and facts learned while implementing, so the record matches the code:

- **`approverd` identity** is filesystem-based (two sockets in separate 0750 directories owned by
  different groups), as D4 states, because Node has no `SO_PEERCRED`.
- **The policy denies the policy FILE, not its directory** to the fs tools (denying the directory
  blocked workspaces that shared it).
- **Tokens carry `approvalId`** in addition to the fields in D4, and the signature covers a
  `jc.local.v1\n` domain prefix so an `acs.jc.v1` signature can never validate as a local token.
- **`ACS_UNAVAILABLE` is local-preset only.** Managed keeps `JC_CAPABILITY_MISSING` /
  `acs_http_unreachable` so its responses are unchanged (parity matrix).
- **Mirroring needs an ACS route that does not exist yet.** The JC half and the `jc.trace.mirror.v1`
  wire format are implemented; the ACS ingest route is a separate change and the mirror stays off
  until `JC_ACS_MIRROR_URL` is set.
- **Pre-existing bug fixed:** `install-privileged-helper.sh` did not copy `manifest.generated.js`
  (imported by `contract.js`), so a fresh helper install could not start. Both installers now declare
  one `FILES` array that a test pins to the real import closure.
- **Not implemented:** trace checkpoint signing and automatic rotation (the reader's 32 MiB cap fails
  closed instead), `outputCapBytes` constraints, and any ACS-side change.
- **Needs a root operator:** creating the `jc`, `jc-approverd` accounts and groups, installing the units
  and policy, and re-running the helper installer with the local anchor. None of that was executed.
