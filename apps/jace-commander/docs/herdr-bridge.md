# JC ↔ Herdr CLI bridge (read-only integration slice)

Status: isolated development branch; not deployed or activated in the user's live Herdr session.

This is a minimal bridge that uses Jace Commander's existing ACS-governed `run_command` rather than adding a new JC provider or changing its tool manifest. It invokes Herdr's **installed CLI** and converts JSON output into an inspectable JSON response.

## Outside Herdr: server metadata only

Through Jace Commander `run_command` with an authorized exact command and `cwd` under the permitted projects root:

```sh
node /home/jacen/projects/acs-jc-herdr-cli-20261112/apps/jace-commander/scripts/herdr-bridge.mjs direct status
node /home/jacen/projects/acs-jc-herdr-cli-20261112/apps/jace-commander/scripts/herdr-bridge.mjs direct sessions
```

## Inside a genuine Herdr-managed pane: opt-in live reads

The user must create or designate a dedicated Herdr pane and **run this command from within that pane**. Do not set `HERDR_ENV` artificially to bypass the check.

```sh
node /home/jacen/projects/acs-jc-herdr-cli-20261112/apps/jace-commander/scripts/herdr-bridge.mjs serve
```

This foreground process inherits Herdr's real pane/session identity and calls `herdr` in that context. Stop it with Ctrl+C in the dedicated pane. A socket is created at `~/projects/.jc-herdr-bridge/herdr.sock`, with a mode-0700 parent directory and mode-0600 socket. It refuses to replace an existing socket. Its session is the one inherited from its pane; it does not silently switch to the TUI-focused pane or another named session.

With that bridge running, the following exact commands may be issued via JC's ACS-governed `run_command`:

```sh
node /home/jacen/projects/acs-jc-herdr-cli-20261112/apps/jace-commander/scripts/herdr-bridge.mjs request snapshot
node /home/jacen/projects/acs-jc-herdr-cli-20261112/apps/jace-commander/scripts/herdr-bridge.mjs request workspaces
node /home/jacen/projects/acs-jc-herdr-cli-20261112/apps/jace-commander/scripts/herdr-bridge.mjs request panes
node /home/jacen/projects/acs-jc-herdr-cli-20261112/apps/jace-commander/scripts/herdr-bridge.mjs request agents
node /home/jacen/projects/acs-jc-herdr-cli-20261112/apps/jace-commander/scripts/herdr-bridge.mjs request pane_read 'w7:p1' 100
node /home/jacen/projects/acs-jc-herdr-cli-20261112/apps/jace-commander/scripts/herdr-bridge.mjs request agent_read 'agent-name' 100
```

Always obtain the actual pane/agent IDs from Herdr; above values are examples. Results are one bounded JSON object containing `ok`, `operation`, `result.format`, `result.data`, and the bridge's inherited `context`. An unavailable bridge fails explicitly. For commands that output text instead of JSON, `result.format` is `text`.

## Security and limits

- **No session mutation or agent input is implemented.** A request for `agent_prompt`, `pane_run`, layout changes, or arbitrary shell commands is rejected before invoking Herdr. This is intentional: JC's process authorization does not by itself prove per-operation approval to a separately running bridge.
- Each CLI call has a bounded output budget (32 KiB raw per Herdr invocation). Requests issued *through JC* still require its normal `acs.jc.v1`-governed `run_command` authorization. There is no change to JC managed mode, its sandbox, capability verifier, or approval policy.
- A same-UID process on the host can reach a mode-0600 socket; this is not an ACS-enforced authentication boundary. The bridge is **read-only** for that reason. Treat retrieved terminal content as potentially sensitive.
- A future write-capable variant must securely bind exact Herdr operation, target, session, caller, expiry, and human approval to an ACS-issued capability, then verify it in the bridge. Do not add mutations based on a trusted-by-convention socket or by supplying `HERDR_ENV=1` from outside.
- Live access has not been exercised in the user's real Herdr session and the socket transport has only been integration-tested with a mock Herdr CLI. Nothing is installed in the live Herdr session.
