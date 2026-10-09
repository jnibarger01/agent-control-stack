# Jace Commander `local` preset: operator guide

Companion to [ADR 0026](adr/0026-jace-commander-standalone-authorizers.md).
`jace-commander serve --preset local` (or `JC_PRESET=local`) authorizes calls
with JC's own policy instead of an ACS capability. `managed` (default) and
`standalone` are unchanged.

## What you get

| Class        | Tools                                                         | Default    |
| ------------ | ------------------------------------------------------------- | ---------- |
| `read`       | list/read/search, `git_status/diff/log/branch/show`, meta     | `allow`    |
| `mutate`     | `write_file`, `create_directory`, `move_file`, `edit_block`, `git_add`, `git_commit` | `approve` |
| `exec`       | `start_process`, `kill_process`                               | `approve`  |
| `network`    | `git_fetch`, `git_push`, `acs_submit_mission`                 | `approve`  |
| `privileged` | `privileged_exec` (never `allow`)                             | `approve`  |

`approve` needs a human via `approverd`. With no approver configured an `approve`
call fails closed with `JC_LOCAL_APPROVAL_UNAVAILABLE` and nothing runs. Setting a
class to `allow` in the policy is how you get a Desktop Commander-like mode.
`privileged_exec` also needs a human approval under `local`, and is then verified
a second time by the root helper (see below).

## Human approval (`approverd`)

Install with `sudo deploy/jace-commander/install-approverd.sh` (a root action; the
repo never runs it for you). It creates three distinct identities: the `jc` server
account, the `jc-approverd` signer that alone holds the signing key, and your login,
added to `jc-approvers`.

1. The model calls an `approve`-class tool. The server answers
   `JC_LOCAL_APPROVAL_REQUIRED` with `_meta.jcApproval.approvalId` and nothing runs.
2. On a real terminal run `jace-commander approve <id>`. It shows the exact tool and
   arguments and requires you to type the first 8 hex characters of the invocation hash.
   It refuses without a TTY on stdin and stdout.
3. Retry the identical call. The approval is claimed once and approverd mints a
   `jc.local.v1` token that lives at most 30 s; the server verifies it itself.

The approval (default 15 min) and the execution token (at most 30 s) are separate.
A claimed approval is consumed, so a retry after any outcome, or a call with changed
arguments, needs a new approval. Identity separation is by filesystem permissions, not
socket credentials: `request.sock` is reachable by group `jc`, `decide.sock` only by group
`jc-approvers`, in separate 0750 directories, so the server and anything it spawns cannot
approve. `jc_doctor`'s **local approver** check fails if the server identity can open
`decide.sock`. Every transition is appended to approverd's own hash-chained audit; if it
cannot be written nothing is approved or minted.

## Policy file

`/etc/jace-commander/policy.json` (override: `JC_POLICY_PATH`). See
`vendor/desktop-commander/deploy/jace-commander/policy.example.json`.

**The JC process must not be able to modify it.** The file and every parent
directory must be non-symlink, not group/world-writable, and `access(W_OK)` must
fail for the user JC runs as. Otherwise the policy is `invalid` and everything
except the `jc.meta` diagnostics is denied. Run JC as a dedicated `jc` account
and keep the policy root-owned.

An optional `<JC_STATE_DIR>/policy.user.json` may only **tighten**: stricter
class decisions, extra denied roots, narrower roots, fewer commands or remotes.
Loosening it makes the whole policy invalid. It cannot set `authorizers`.

`JC_POLICY_UNSAFE_DEV=1` accepts an editable policy for local development. It is
read from the process environment only, is not forwarded by the bridge, appears
in `jc_status`, and makes `jc_doctor` fail.

## What the constraints are, and are not

`fs.roots`/`deniedRoots` are enforced with symlink-safe containment. The policy
and the user layer are added to the denied roots so the model cannot read or
edit them. `exec.allowCommands`/`denyCommands` and `git.remotes` are
**guardrails, not a sandbox**: an allowed interpreter runs arbitrary code. With
`exec: allow` the real boundary is the OS account and unit hardening; use
`apps/dc-mcp-gateway/deploy/systemd/jace-commander-mcp-local.service.example`.

## Audit

Every call is written to the hash-chained local trace with `authorizer`,
`provider`, `riskClass` and the `policyHash`. For `local` calls above `read`, a
`tool_call_started` intent record is written **before** the handler runs; if it
cannot be written the call is refused with `JC_TRACE_UNAVAILABLE`. Reads and the
managed path keep their previous best-effort behavior. Trace files are
per-process and capped at 32 MiB (the reader refuses larger files, which also
fails closed). Add `chattr +a` on the trace directory for tamper resistance.

## OAuth edge

With `JC_PRESET=local` on the edge, ACS capability **issuance** is skipped for
tools the policy routes to `local`. OAuth authentication, audience binding and
anti-spoofing are unchanged, and the edge fails toward ACS if the policy is
unusable. A tool the policy routes to `acs-capability` is still issued by ACS.

## Privileged execution under `local`

The root helper keeps **two** trust anchors, both only in its root-owned
`/etc/jace-commander/privileged.json` (never the environment, which the helper
ignores as root): the ACS key (`acs.jc.v1`) and the approver key (`jc.local.v1`,
`localPublicKey` + `localKeyId`). The envelope's `keyId` selects the anchor; the two
keys must differ and neither can verify the other's artifact. Install the second
anchor by re-running `install-privileged-helper.sh` with `JC_LOCAL_PUBLIC_KEY` and
`JC_LOCAL_KEY_ID` (the values `install-approverd.sh` prints).

Under the local preset the helper token comes **only** from approverd. A capability a
client puts in `_meta` is ignored. The helper audits `authority: jc.local.v1` with the
approval id and approver, not an ACS work item. `jc_doctor`'s **privileged local anchor**
check compares the helper's configured anchor to `JC_APPROVER_KEY_ID`.

**Upgrade note.** The helper's installed files are a set. Re-run the installer when you
upgrade; it now copies every module the helper imports (earlier installer versions
omitted `manifest.generated.js`, so a fresh install could not start).
