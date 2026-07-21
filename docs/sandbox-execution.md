# Sandbox execution contract

The worker remains dry-run by default. A work item is never allowed to select an unconstrained subprocess path.

The optional `codex-bubblewrap` profile is enabled only when
`ACS_AGENT_EXECUTION_MODE=codex-bubblewrap` is set in the worker environment. It accepts only a `codex`/`codex-cli` provider and requires:

- `permissionMode: "read-only"` and `networkAccess: "none"` in the canonical `agent.prompt` action;
- Bubblewrap on the host (`/usr/bin/bwrap` or `ACS_BWRAP_PATH`);
- an existing absolute workspace that passes realpath containment and a before/after manifest check;
- a read-only workspace bind, cleared environment, temporary HOME/TMPDIR, capped stdout/stderr, and a bounded timeout;
- process-group termination evidence after timeout; and
- no inherited provider credentials or network namespace.

Claude, Gemini, OpenCode, OpenClaw, and Pi profiles are disabled until each has an independently reviewed containment contract. Windows fails closed because this implementation does not prove equivalent process-tree termination there. There is no unconstrained fallback.

The profile can execute a locally installed Codex CLI, but the sandbox deliberately has no network and does not expose API credentials. A remote model call therefore requires a separately reviewed local inference broker; this repository does not claim that broker exists. A provider failure is recorded as a structured `not_started`/failed worker result rather than silently falling back to dry-run or host execution.

Evidence fields persisted with worker results include execution mode, provider/model, timestamps, exit and timeout state, redacted output, changed paths, workspace hashes, verification results, sandbox identity, and whether evidence was worker-reported or ACS-derived.
