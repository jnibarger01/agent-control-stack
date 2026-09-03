# Autonomous development-agent supervisor

`scripts/autonomous_agent.py` is a bounded development loop for repeatedly
invoking a coding-agent CLI in the current repository. It is intentionally not
part of ACS: it does not create work items, acquire leases, record attempts,
route work, apply approvals, recover ACS state, or publish changes.

## Usage

From the repository root, give it a master implementation prompt:

```bash
python scripts/autonomous_agent.py prompts/acs-implementation.md
```

The default executor is Codex. Select another supported executor with
`--agent` (`codex`, `claude`, `gemini`, `grok`, `opencode`, or `pi`). The
executor command is an argument array, not a shell string. Override it with a
JSON argv array when a local CLI needs different flags:

```bash
python scripts/autonomous_agent.py prompts/feature.md \
  --agent-command-json '["opencode", "run"]' \
  --max-invocations 20 --timeout 1800
```

The maximum defaults to 100 and can also be set with
`AUTONOMOUS_AGENT_MAX_INVOCATIONS`. The timeout defaults to 30 minutes and can
be set with `AUTONOMOUS_AGENT_TIMEOUT_SECONDS`.

## Verification

When the agent emits `<ACS_MILESTONE_COMPLETE>`, the supervisor independently
runs repository-local checks. It uses a `check` package script when present;
otherwise it discovers `test`, `lint`, `typecheck`, and `build` scripts, or
falls back to `python -m pytest` for Python repositories. Override discovery
with one or more JSON argv arrays:

```bash
python scripts/autonomous_agent.py prompts/feature.md \
  --verify-command-json '["npm", "run", "test"]' \
  --verify-command-json '["npm", "run", "typecheck"]'
```

A completion marker is never trusted by itself. Failed verification evidence is
included in the next continuation prompt. Absence of a marker also continues;
`<ACS_CONTINUE>` is informative rather than required.

## Outcomes and logs

- `0`: completion marker plus independent verification passed.
- `2`: agent reported `<ACS_BLOCKED>`.
- `3`: maximum invocation count exhausted.
- `4`: maximum reached after a completion marker failed verification.
- `130`: interrupted with SIGINT or SIGTERM.

Each invocation is recorded under `.agent-runs/` as `run-0001.log`, etc.; the
each independent verification is recorded as `verification-0001.log`, etc.
These transient logs are ignored by Git. The supervisor never commits, pushes,
merges, or deploys automatically.
