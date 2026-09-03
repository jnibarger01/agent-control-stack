# Local Development Runbook

## Install

```sh
npm install
```

## Validate

```sh
npm run build
npm test
```

The normal test suite proves application behavior and keeps the production
worker in dry-run mode. On a Linux host with Bubblewrap, a working user systemd
manager, and cgroup v2, run the separate containment gate:

```sh
npm run test:sandbox-integration
```

That gate executes disposable fixtures in real namespaces and cgroup scopes. It
must pass filesystem and network denial, output and wall-clock bounds,
process-tree cleanup, cancellation, memory and PID enforcement, and exact
CPU/memory/PID scope-property checks. A skipped or unavailable host gate is not
containment proof.

## Run Gateway

```sh
npm run build
ACS_DB_PATH=storage/local.db npm run start:gateway
```

Open `http://127.0.0.1:3000`.

For MCP auth testing in local development, set `ACS_MCP_BEARER_TOKEN` and send it as `Authorization: Bearer <token>` on `/mcp` requests. OAuth and tunnel ID setup are documented in `docs/oauth-authentication.md`.

The real loopback MCP interoperability smoke path uses a temporary SQLite
database, deterministic OAuth test keys, and an explicitly registered harmless
fixture agent. It starts the gateway on `127.0.0.1` and sends the actual
`initialize`, `tools/list`, and `tools/call` JSON-RPC requests through `/mcp`:

```sh
npx vitest run apps/gateway/src/server.test.ts -t 'runs an explicitly registered deterministic agent through the real loopback MCP boundary'
```

This proves local MCP protocol interoperability and ACS authorization,
approval-scope, bounded-output, timeout, and audit behavior only. It does not
prove Claude, ChatGPT, OpenCode, OpenClaw, or Hermes interoperability.

The installed Claude Code interoperability test uses only a temporary Claude
home and inline `--mcp-config`, a loopback Anthropic-format model mock, and the
real Claude CLI. It does not read global Claude credentials or call an external
model:

```sh
npx vitest run apps/gateway/src/claude-interoperability.test.ts
```

This proves Claude Code's local MCP client path can authorize and invoke the
explicit fixture agent through ACS. Claude's model report may contain provider
metadata synthesized by the CLI; the test's provider requests are served only
by the loopback mock. It does not prove Claude-hosted, ChatGPT, trusted-LAN, or
production interoperability.

The installed-CLI interoperability tests (Claude Code, OpenCode, Hermes,
OpenClaw) resolve their client executable from `PATH` or an explicit override
(`ACS_TEST_CLAUDE_EXECUTABLE`, `ACS_TEST_OPENCODE_EXECUTABLE`,
`ACS_TEST_HERMES_EXECUTABLE`, `ACS_TEST_OPENCLAW_EXECUTABLE`) and skip
automatically when the client is not installed on the machine running the
tests.

## Run the composed local runtime

For a local gateway, scheduler, worker, actor discovery, and reconciliation
process, use the canonical `acs serve` entrypoint instead of manually keeping
separate long-running commands aligned:

```sh
cp acs.config.example.yaml acs.config.yaml
npm run build
npm run acs -- serve
```

The config supports loopback gateway address/port and runtime cadence only.
Authorization, policy, approvals, and adapter credentials remain under their
existing configuration contracts. Check composed runtime state with:

```sh
curl -fsS http://127.0.0.1:3001/readyz
curl -fsS http://127.0.0.1:3001/status
```

## ChatGPT App UI

Build the self-contained React widget with `npm run build:chatgpt-widget`.
The read-only `open_acs_dashboard` MCP tool attaches `ui://acs/dashboard-v1`;
the widget uses the MCP Apps bridge for tool results, execution-detail reads,
and follow-up messages. Its CSP has empty `connectDomains` and
`resourceDomains` because it fetches no external resources.

For ChatGPT developer mode, expose the existing authenticated `/mcp` endpoint
through the ACS Secure MCP Tunnel (or another authenticated public HTTPS
forwarder), add the full HTTPS `/mcp` URL in ChatGPT Plugins, refresh metadata,
then verify both the inline UI and its structured tool result. Do not expose the
loopback gateway directly or add mutating dashboard controls.

## Run Worker Once

```sh
ACS_DB_PATH=storage/local.db npm run start:worker
```

The worker simulates one approved read-only work item and records start/completion events with `execution_mode: "dry_run"`. Approved writes, shell commands, and other non-read-only actions are recorded as blocked until the authoritative attempt/workspace execution path is enabled.
