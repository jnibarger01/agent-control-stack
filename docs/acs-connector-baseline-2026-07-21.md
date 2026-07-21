# ACS Connector Baseline — 2026-07-21

## Repository

- Branch: `repair/acs-production-readiness`
- Commit: `648946225bbfcc68d75c0fbd47055d218de692f9`
- Working tree before implementation: clean
- Repository: `/home/jacen/agent-control-stack`

## Runtime

- `acs-gateway.service`: enabled and active under the user systemd manager.
- `acs-tunnel.service`: enabled and active under the user systemd manager; requires the gateway.
- No ACS worker service is installed or active.
- No ACS machine-controller MCP service is installed or active.
- Listeners observed: gateway `127.0.0.1:3000`; unrelated Hermes listener `127.0.0.1:8642`.
- Gateway health: passed `read`, `write`, `integrity`, `foreignKeys`, `migrations`, `auditChain`, and `liveness`.
- Tunnel health: local tunnel-client `/healthz` and `/readyz` both passed; tunnel process was running.
- Configured public MCP hostname: unresolved from this host during the baseline probe.

## Service and environment sources

- Gateway unit: `/home/jacen/.config/systemd/user/acs-gateway.service`.
- Tunnel unit: `/home/jacen/.config/systemd/user/acs-tunnel.service`.
- Gateway secret source: `/home/jacen/.agent-control-stack/secrets/local-gateway.env`; variable names present were `ACS_GATEWAY_TOKEN`, `ACS_MCP_BEARER_TOKEN`, and `ACS_OPENAI_API_KEY`. Values are intentionally not recorded.
- Tunnel wrapper: `/home/jacen/.agent-control-stack/bin/acs-tunnel-run`.
- Tunnel profile: `/home/jacen/.config/tunnel-client/agent-control-stack.yaml`; it points at tunnel `tunnel_6a4b1ed328e88191a9906d346ba899ae` and local MCP `http://127.0.0.1:3000/mcp`.
- Tunnel wrapper expects `CONTROL_PLANE_API_KEY` from `/home/jacen/notimportant.txt`; that source was unreadable during baseline collection. The already-running tunnel process had `CONTROL_PLANE_API_KEY` and `ACS_MCP_AUTH_HEADER` in its environment. Values are intentionally not recorded.
- Current shell: `ACS_MCP_BEARER_TOKEN` set; `ACS_MCP_CONFIG`, `ACS_AGENT_EXECUTION_MODE`, `ACS_CODEX_PATH`, `ACS_NODE_PATH`, and `CONTROL_PLANE_API_KEY` unset. Current-shell values are not used as proof of service-manager configuration.

## Current MCP surfaces

Gateway MCP discovery returned these six tools:

1. `create_work_item`
2. `get_work_item`
3. `list_work_items`
4. `unblock_work_item`
5. `reject_work_item`
6. `cancel_work_item`

The gateway deliberately does not publish approval, worker-claim, or worker-result tools to remote MCP callers. The authenticated `/mcp/tools` inventory route still lists the internal seven-name work-item inventory, including `approve_work_item`; direct MCP approval is rejected.

The standalone machine-controller MCP source publishes:

- `system.status`
- `fs.list`
- `fs.stat`
- `fs.read`
- `fs.search_name`
- `cmd.preview`
- `cmd.run`

That surface requires `ACS_MCP_CONFIG` or `--config`; no running process or active configuration was found.

## Existing execution and control paths

- Policy recognizes filesystem reads/writes, command preview/run, `agent.prompt`, `service.restart`, and `shell` action kinds.
- Machine-controller command execution is read-only and allowlisted; non-read-only commands are refused.
- Worker leases are compare-and-swap claims with lease-bound result submission.
- Default worker execution is `dry_run`.
- Optional Codex execution is Bubblewrap-based, read-only, no-network, Codex-only, and disabled unless `ACS_AGENT_EXECUTION_MODE=codex-bubblewrap`.
- Work-item results and redacted execution evidence are persisted in SQLite and exposed through work-item retrieval, `/api/events`, and `/events`.
- No live host mutation executor is bound to the worker.

## Baseline validation

- `npm test`: passed — 43 Vitest files / 358 tests, 48 AgentOS tests, and public-site safety verification passed.
- `npm run build`: passed.
- Live gateway `/health`: passed.
- Live loopback MCP `tools/list`: passed and returned the six tools above.
- `tunnel-client health --url-file ... --pid ... --json`: passed locally.
- Public configured MCP hostname probe: failed DNS resolution (`curl` exit 6).
- `tunnel-client doctor` from the current shell: failed because `CONTROL_PLANE_API_KEY` was not present in that shell; this does not contradict the already-running process environment finding.

## Implementation gaps against the connector brief

1. No central registered-action/command/service/configuration target registry.
2. No gateway MCP tools for command, filesystem, agent, result, evidence, restart-request, or config-preview/request operations.
3. No worker service deployment or authenticated worker gateway loop.
4. No governed live read-only command/filesystem execution path through the worker.
5. Codex execution evidence lacks several brief-required provenance fields and has no gateway-dispatch tool.
6. No evidence metadata/list/get contract.
7. No registered ACS-owned service restart request or safe configuration preview/write target.
8. No deployment configuration for worker or machine-controller execution boundaries.
9. Public tunnel restart is not reproducible from its currently configured credential source.
