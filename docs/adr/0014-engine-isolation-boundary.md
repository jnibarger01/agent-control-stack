# ADR 0014: Engines get an ACS-enforced isolation boundary independent of the CommandBroker sandbox

## Status

Accepted

## Context

An independent security review returned FAIL on the Engine Harness. The
central finding: `packages/engine-adapter`'s `CodexEngineAdapter` (and the
Claude verifier in `packages/verification`) run model-backed engine CLIs as
plain, workspace-scoped, env-allowlisted subprocesses — not inside
`packages/sandbox`'s Bubblewrap boundary. That boundary was deliberately
skipped in the original Phase 3 implementation because it hardcodes
`--unshare-net`, and an engine that cannot reach its own model API cannot run
at all.

The commit message that shipped that gap said so plainly, and ADR 0010
restricted itself to the CommandBroker path on purpose. But "documented and
tracked" is not "contained." Engines are untrusted: they execute
model-generated tool calls, read repository content an attacker may have
poisoned, and are the one component in this system whose behavior ACS cannot
predict in advance. Working-directory scoping and an environment allowlist
are hygiene, not sandboxing — a subprocess with `cwd` set to a worktree still
has the full host network, the real `$HOME`, every ambient credential in
`process.env` that isn't on the allowlist's *complement*, and an unbounded
process tree if it forks. Selecting where a process starts does not bound
what it can reach.

`packages/sandbox`'s existing `network: "none"` contract is correct for its
job (build/test/lint/git commands never need network) and must not be
weakened to accommodate engines. Engines need a *different* contract with a
narrower, audited exception: network access to exactly the model provider
endpoint the invocation requires, and nothing else.

## Decision

Add a second, independent isolation backend — `EngineIsolationBackend` in
`packages/sandbox` — used by every model-backed engine invocation (Codex
adapter, Claude verifier, and any future engine adapter). It is not a relaxed
version of `BubblewrapSystemdSandbox`; it is a distinct backend with its own
contract, reusing `linux.ts`'s proven cgroup-scope and process-tree-kill
primitives rather than duplicating them, because those primitives are
already independently tested and their correctness is orthogonal to what
gets mounted or how egress is scoped.

### Workspace mount boundary

- The workspace path is never caller-supplied. It is resolved by loading the
  authoritative allocation record from the Workspace Manager's persisted
  state for the exact `(workItemId, attemptId)` pair, then canonicalized
  with `realpathSync` and compared byte-for-byte against the persisted
  `canonicalWorkspacePath` before every launch — the same check
  `packages/sandbox/src/linux.ts`'s `verifyWorkspace` already performs for
  CommandBroker, applied here independently.
- Only that single canonical path is bind-mounted, read-write, at a fixed
  in-sandbox path (`/workspace`). No parent directory, sibling worktree, or
  `.git` object store outside the allocation is reachable.
- The host user's real `$HOME` is never mounted. The sandbox gets a private,
  empty, freshly created `HOME` under the sandbox's own tmpfs
  (`--tmpfs /tmp`, `--dir /tmp/home`, `--setenv HOME /tmp/home`), identical
  in spirit to the CommandBroker sandbox's existing private-HOME setup.
- Only the engine binary's runtime root (e.g. the Node.js install backing
  the Codex/Claude CLI) is mounted read-only, mirroring how the
  CommandBroker sandbox mounts `/opt/acs-node` for `npm`.

### Credential delivery

- The isolation boundary accepts exactly one named credential
  (`credentialEnvName` + `credentialEnvValue`) per invocation, injected as a
  single `--setenv` into the clean, `--clearenv`'d child environment. No
  other environment variable crosses the boundary except a small fixed
  allowlist of locale/PATH values already used by the CommandBroker sandbox.
- Ambient SSH agent sockets, Git credential helpers, cloud provider
  credential files, browser profile data, and any `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY` sitting in the *host* process environment are never
  visible — `--clearenv` plus the mount boundary above makes them physically
  unreachable, not merely unset by convention.
- The credential value itself is never logged, included in an audit event,
  or echoed into stdout/stderr capture; only the *name* of the credential
  that was injected is recorded.

### Scoped network egress

Full `--unshare-net` denies the sandboxed process a network stack entirely —
no interfaces, not even loopback routing to the host. That is the correct
default and stays the default. Scoped egress is added as an explicit,
narrow, auditable exception, not a relaxation of the namespace:

1. Before launch, the ACS host process opens a short-lived allowlist proxy
   (`packages/sandbox/src/egress-proxy.ts`) listening on a fresh,
   per-invocation `AF_UNIX` socket. `AF_UNIX` sockets are filesystem
   objects, not network devices — they are unaffected by
   `CLONE_NEWNET`/`--unshare-net`, which only governs interfaces and routing.
2. The proxy speaks HTTP `CONNECT`. For every request it checks the
   requested `host:port` against an explicit allowlist supplied by the
   engine adapter for that invocation (e.g. exactly
   `api.anthropic.com:443`); anything else is refused and audited as a
   denied-egress event. An allowed request is bridged to a real outbound
   socket the host process opens on the host's own network stack.
3. The proxy's socket file (and only that file, inside a private per-attempt
   directory) is bind-mounted into the sandbox. Inside the sandbox, a
   minimal `socat` bridge (`TCP-LISTEN:<port>,bind=127.0.0.1,fork
   UNIX-CONNECT:<mounted-socket>`) is started before the engine process and
   relays raw bytes between the sandbox's own private loopback (which the
   sandboxed process may bring up inside its own unshared network namespace
   — a namespace it owns, reachable only from itself) and the mounted
   `AF_UNIX` socket.
4. The engine is pointed at that private loopback address via
   `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`. Because the sandbox's network
   namespace has no route to anything else — not the host, not the
   internet, not another sandbox's namespace — there is no bypass available
   to a compromised or malicious engine binary that ignores the proxy
   environment variables and opens raw sockets: `connect()` to any address
   other than the sandbox's own loopback fails at the kernel level with
   `ENETUNREACH`.
5. The proxy process, its socket, and the per-attempt directory are torn
   down when the invocation finishes, whether it succeeded, failed, or was
   killed on timeout.

This gives "scoped network egress through an enforceable... mechanism"
without requiring root, new kernel capabilities, veth pairs, or installed
userspace network stacks (slirp4netns/passt) that may not be present on a
given host — it is buildable from primitives already used elsewhere in this
sandbox (`bwrap`, `socat`) plus a small amount of new ACS-controlled Node.js
code.

### Process containment, output, and audit boundary

Reused, not reimplemented, from `packages/sandbox/src/linux.ts`:
`--unshare-pid`/`--unshare-ipc`/`--unshare-uts`/`--cap-drop ALL`, a systemd
`--user --scope` cgroup with `TasksMax`/`MemoryMax`/`CPUQuota`, SIGTERM then
SIGKILL against the whole scope (`systemctl kill --kill-whom=all`) plus the
local process group on timeout or cancellation, byte-bounded and
redaction-passed stdout/stderr capture, and a `cleanup: verified | failed |
unknown` observation where anything but `verified` blocks a success outcome.

### Fail-closed behavior

Preflight must positively confirm, before any engine process starts: `bwrap`
and `systemd-run`/`systemctl` are present and support the required options;
cgroup v2 is mounted; the workspace allocation is authoritative and
canonical; `socat` is present at the pinned path used to build the egress
bridge; the egress proxy's `AF_UNIX` socket was created successfully and is
listening. Any missing primitive is a launch-time error, not a silent
downgrade to an unsandboxed subprocess or to full open network access. There
is no "best effort" mode for engines.

### Independence from the CommandBroker sandbox

`BubblewrapSystemdSandbox` (`network: "none"`) is unchanged and remains the
only path for build/test/lint/git commands, which never need network. The
new `EngineIsolationBackend` (`network: "scoped-egress"`) is a distinct
contract, distinct Zod schema, and distinct integration test suite living
next to it in `packages/sandbox`. A claim that engines are contained must be
backed by tests that launch an engine-shaped process through the new backend
specifically and prove: it cannot read a file under the real host `$HOME`,
it cannot reach a TCP destination outside the allowlist, it *can* reach an
allowlisted destination only through the proxy, and its full process tree is
reaped on timeout. Pointing at the existing CommandBroker integration suite
does not satisfy this ADR.

## Consequences

- `CodexEngineAdapter` and `ClaudeVerifier` change from "spawn a
  workspace-scoped subprocess" to "launch through `EngineIsolationBackend`."
  Both were previously documented as an explicit, tracked gap; this ADR
  closes it.
- A new small always-on component (`egress-proxy.ts`) runs on the host for
  the duration of each engine invocation. Its allowlist is per-invocation
  and supplied by the caller (the engine adapter), not global configuration,
  so a future engine that legitimately needs a different provider endpoint
  does not require touching this module.
- `socat` becomes a required host prerequisite for live engine execution,
  alongside the existing `bwrap`/`systemd-run` prerequisites. Its absence is
  a fail-closed preflight error, exactly like a missing `bwrap`.
- This does not by itself make engine actions authoritative — that is ADR's
  companion finding (CommandBroker/approval binding, tracked separately).
  Isolation bounds what an engine process can *reach*; it does not decide
  whether a given action was *approved*.

## Rejected alternatives

### `HTTPS_PROXY` env var alone, network namespace shared with the host

Rejected. An env-var-configured proxy is advisory: a compromised or
adversarially-generated engine invocation can simply ignore it and open a
direct socket. Advisory configuration is not a security boundary; the
namespace-level denial is.

### Full network namespace with veth pair to the host

Rejected for this environment. Configuring the host side of a veth pair
requires host root/`CAP_NET_ADMIN` in the *host's* network namespace, which
this service does not have and installing tooling to grant it is out of
scope. The `AF_UNIX`-socket-plus-loopback-bridge design achieves the same
enforcement property (no route to anywhere except the audited chokepoint)
entirely inside namespaces the unprivileged service account already owns.

### Installing `slirp4netns`/`passt` for user-mode networking

Rejected for now. Not present on this host, and installing new packages is
outside this remediation's authorization. The `socat`-bridge design reaches
the same fail-closed property with tooling already available. If
`slirp4netns`/`passt` becomes available, it is a strict upgrade path (real
per-destination routing instead of a single-proxy bridge) and can replace
`egress-proxy.ts`'s transport without changing the contract.

### Relaxing `packages/sandbox`'s existing `network: "none"` contract to add an engine mode

Rejected. CommandBroker's contract is deliberately narrow and
network-incapable; conflating it with a network-capable engine contract
would make the safest path (build/test/lint) harder to reason about for the
sake of a fundamentally different caller. Two contracts, two schemas, two
test suites.

## Required tests

Application-level: strict request parsing for the new contract, credential
allowlist enforcement (exactly one named variable crosses the boundary),
egress-proxy allow/deny decisions in isolation (no sandbox required to test
the proxy's own logic).

Linux integration (must run for real, not skip, wherever `bwrap` +
cgroup v2 + `socat` are present, and must report `BLOCKED` rather than pass
when they are not): host `$HOME` file unreachable from inside the sandbox;
a TCP destination outside the allowlist is unreachable; an allowlisted
destination is reachable only via the proxy and denied entries are audited;
full descendant process tree (including the `socat` bridge) is reaped on
timeout; workspace-escape and symlink-substitution attempts are refused
identically to the CommandBroker sandbox's existing coverage.
