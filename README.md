# Agent Control Stack

Agent Control Stack (ACS) is a local-first TypeScript/Node control plane for policy-gated agent work. It sits between untrusted agent requests and privileged local-machine actions, turning proposed work into durable work items, applying policy, requiring exact-action approvals, recording a tamper-evident audit trail, and letting a local worker claim approved work.

This repository is currently a **v0.1.0-alpha dry-run control-plane release**. It proves the control-plane loop, not production command execution. The worker records `execution_mode: "dry_run"`; it does **not** run real shell commands or provide hardened OS sandbox isolation yet.

## Table of contents

- [What this repository does](#what-this-repository-does)
- [What this alpha does not do](#what-this-alpha-does-not-do)
- [Architecture](#architecture)
- [Architectural invariants](#architectural-invariants)
- [Repository layout](#repository-layout)
- [Runtime flow](#runtime-flow)
- [Security model](#security-model)
- [Requirements](#requirements)
- [Install](#install)
- [Configuration](#configuration)
- [Run locally](#run-locally)
- [Use the HTTP gateway](#use-the-http-gateway)
- [Use the MCP endpoint](#use-the-mcp-endpoint)
- [Run the worker](#run-the-worker)
- [Deploy](#deploy)
- [Operations](#operations)
- [Validation](#validation)
- [Known limitations](#known-limitations)
- [Related docs](#related-docs)

## What this repository does

ACS provides a local control plane for agent-requested work:

1. Accepts work-item requests through the HTTP gateway or MCP endpoint.
2. Validates incoming data with Zod schemas.
3. Evaluates each requested action with the policy gate.
4. Stores work items and audit events in SQLite.
5. Requires human approval for risky actions.
6. Binds approvals to exact canonical action hashes.
7. Lets a local worker claim only approved work items.
8. Requires authenticated, lease-bound, worker-identity-bound result submission.
9. Persists immutable execution results with durable idempotency and audit evidence.
10. Creates immutable retry and clone work items with fresh identities and action hashes.
11. Records redacted, OpenTelemetry-shaped audit events.
12. Verifies audit-chain and persisted liveness health through the store and `/health` endpoint.

The core point: agents can ask; ACS decides whether the request is allowed, denied, or approval-gated. Trust is expensive. ACS tries not to hand it out like Halloween candy.

## What this alpha does not do

Do **not** claim this alpha provides:

- real command execution
- hardened sandbox isolation
- production-safe machine mutation
- production-ready remote connector operation
- kernel-level containment
- a multi-user enterprise authorization model

The current `packages/sandbox` implementation is intentionally dry-run only. Real execution should be added behind that package after isolation, environment allowlisting, path containment, output caps, and network controls pass their own release gate.

This dry-run scope applies to the `apps/worker` / `packages/sandbox` work-item execution pipeline described below. It does **not** describe `packages/machine-controller` (used by the standalone `apps/mcp` stdio server): that component really does spawn read-only diagnostic commands (`git`, `npm`, `node`, etc., per `config.example.yml`'s `allow_readonly` list) with a real subprocess. It is deny-by-default and not wired into the work-item/policy-gate/audit lifecycle above — see `packages/machine-controller/src/command.ts`.

**Known unpatched gap:** `isKnownReadonly()` (`command.ts:186-196`) only checks the _first_ argument (the subcommand) against its allowlist — e.g. `git` + `diff`/`log`/`show`/`status` — and passes every argument after that straight through to the real spawned process unvalidated. Git accepts flags like `--output=<path>` on `diff`/`log`/`show` that write to an arbitrary filesystem path, so `{ command: "git", args: ["diff", "--output=/some/path"] }` is classified `read_only` and actually executes, writing outside `cwd`. An open, unmerged PR (#26) has a reviewed fix (per-subcommand flag allowlists, an isolated environment for the subprocess, and forced `--no-ext-diff --no-textconv`); until it merges, do not describe this path as hardened.

Wave 2 models completion without claiming execution: result submission accepts only authenticated worker principals with an active matching lease, action hash, and dry-run metadata. Accepted results are immutable. Retry and clone create new work items; they never reopen or edit historical items. External connector proof remains separate from this local lifecycle proof.

## Architecture

```text
MCP / HTTP / dashboard client
  |
  | untrusted intent
  v
apps/gateway
  |
  | Zod validation + auth + request routing
  v
packages/policy-gate
  |
  | allow / deny / require_approval by exact action hash
  v
packages/work-items
  |
  | SQLite work_items + leases + execution_results + audit_events
  v
apps/worker
  |
  | claim approved work with a lease
  v
packages/sandbox
  |
  | dry-run execution simulation in v0.1.0-alpha
  v
immutable result + audit evidence
```

### Main components

| Component                     | Purpose                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/gateway`                | Fastify HTTP gateway, dashboard host, MCP-over-HTTP endpoint, auth handling, SSE events, ChatGPT control-center widget host.                                  |
| `apps/control-ui`             | Server-rendered mission-control dashboard HTML.                                                                                                               |
| `apps/mcp`                    | stdio MCP server backed by the machine-controller package.                                                                                                    |
| `apps/worker`                 | One-shot local worker that claims the next approved work item and records a dry-run result.                                                                   |
| `apps/chatgpt-widget`         | React source for the ChatGPT control-center widget; built by `npm run build:chatgpt-widget` into a generated file `apps/gateway` serves. Not run standalone.  |
| `packages/work-items`         | Work-item state machine, SQLite store, approvals, leases, immutable results, retry/clone lineage, audit events, registry, audit-chain health.                 |
| `packages/policy-gate`        | Policy evaluation, action fingerprinting, approval gating, worker-claim gating.                                                                               |
| `packages/sandbox`            | Execution boundary. Currently dry-run only.                                                                                                                   |
| `packages/shared`             | Shared IDs, stable hashing, errors, redaction, schemas, migration helpers.                                                                                    |
| `packages/machine-controller` | Local machine-controller config and direct agent/tool boundary. Runs real read-only diagnostic commands; has a known unpatched arg-injection gap (see above). |
| `packages/acp-adapter`        | Read-only ACP stdio adapter for registering agent status/capabilities.                                                                                        |
| `packages/moa-orchestrator`   | Multi-model/model-routing orchestration support.                                                                                                              |
| `packages/eval-harness`       | Replay and policy validation harness.                                                                                                                         |
| `packages/temporal-memory`    | Source-backed memory events/projections.                                                                                                                      |
| `packages/agentos-contracts`  | Shared contract types for AgentOS-facing integrations. Not yet consumed by any app path.                                                                      |
| `packages/engine-adapter`     | Codex engine adapter and command-broker binding to persisted attempt/lease/workspace authority. Not yet consumed by any app path.                             |
| `packages/secret-broker`      | Credential-leasing primitive that binds leases to a principal with use accounting. Not yet consumed by any app path.                                          |
| `packages/verification`       | Independent implementer/verifier identity separation and exact-criteria-coverage checking. Not yet wired into the result-submission write path.               |
| `packages/workspace-manager`  | Git worktree-backed workspace allocation, tied to `work-items`' persisted `WorkspaceAllocation` records. Not yet consumed by any app path.                    |

## Architectural invariants

A handful of structural properties are load-bearing and easy to accidentally break during a refactor: fencing-epoch compare-and-swap on lease claims, the audit-chain write barrier, exact action-hash approval binding, migration checksum enforcement, and the sandbox's single egress chokepoint. Read [`docs/architecture-invariants.md`](docs/architecture-invariants.md) before assuming a simplification near any of those is safe.

## Repository layout

```text
apps/
  chatgpt-widget/   React source for the ChatGPT control-center widget (build-only, see below)
  control-ui/       Server-rendered dashboard UI
  gateway/          Fastify HTTP/SSE/MCP gateway
  mcp/              stdio MCP server entrypoint
  worker/           One-shot local worker
packages/
  acp-adapter/      Read-only ACP process adapter
  agentos-contracts/ Shared AgentOS-facing contract types (not yet consumed)
  engine-adapter/   Codex engine adapter and command-broker binding (not yet consumed)
  eval-harness/     Replay/evaluation harness
  machine-controller/ Local machine-controller config and direct-agent boundary
  moa-orchestrator/ Model/orchestration support
  policy-gate/      Policy decisions and approval gates
  sandbox/          Dry-run sandbox boundary
  secret-broker/    Credential-leasing primitive (not yet consumed)
  shared/           Shared schemas, errors, hashing, redaction
  temporal-memory/  Memory event/projection package
  verification/     Independent implementer/verifier separation (not yet wired in)
  work-items/       SQLite store, state machine, approvals, audit chain
  workspace-manager/ Git worktree-backed workspace allocation (not yet consumed)
storage/
  migrations/       SQLite migrations
docs/
  architecture.md
  architecture-invariants.md
  oauth-authentication.md
  threat-model.md
  runbooks/local-dev.md
config.example.yml  Example machine-controller policy config
.env.example        Environment variable template
```

### The ChatGPT control-center widget build

This is a ChatGPT-facing MCP resource, not part of the local HTTP dashboard. `apps/gateway/src/mcp.ts`'s `resources/read` handler (`mcp.ts:451-462`) serves a small React widget as an `mcp-app`-profile HTML resource for ChatGPT-hosted app surfaces; the `/` HTTP dashboard is rendered separately by `@agent-control-stack/control-ui` and does not use this widget at all. Its source lives in `apps/chatgpt-widget/`, but `apps/gateway` never imports that package directly. Instead:

1. `npm run build` first runs `npm run build:chatgpt-widget`, which runs `scripts/build-chatgpt-widget.mjs`.
2. That script bundles `apps/chatgpt-widget/src/main.tsx` with esbuild into a single inline HTML/CSS/JS string.
3. It writes that string as a **generated, checked-in** TypeScript module: `apps/gateway/src/chatgpt-dashboard-widget.generated.ts`.
4. `tsc -b` then compiles the gateway (and everything else) against that generated file.

If you change `apps/chatgpt-widget/src/`, you must re-run `npm run build:chatgpt-widget` (or `npm run build`) before the gateway picks up the change — editing the `.generated.ts` file directly will be silently overwritten on the next build. There is currently no drift test asserting the generated file matches its source; treat a diff in the generated file as a signal to check that it was produced by the build script, not hand-edited.

## Runtime flow

### 1. Work item creation

A caller submits a work item with intent, target, requested actions, and risk. ACS stores it, evaluates policy, and transitions it to one of:

- `approved`
- `needs_approval`
- `blocked`

### 2. Policy evaluation

Policy evaluation is action-based. Each action is canonicalized and fingerprinted. Mutating or risky actions require approval; unsafe actions are denied.

Examples of guarded surfaces:

- filesystem writes
- package installs
- service restarts
- destructive operations
- credential-path reads
- high-risk self-approval
- unapproved network access
- path escapes

### 3. Approval

Approval is not a vague thumbs-up. ACS stores approvals by:

- `work_item_id`
- exact `action_hash`
- `request_hash`
- approver
- reason
- expiry / consumed state

If the action changes after policy evaluation, the hash changes and the approval no longer applies. Annoying, yes. Correct, also yes.

### 4. Worker claim

The local worker claims only approved work items. Claiming uses a status compare-and-swap and short lease. Before claim completion, ACS re-checks policy and required approvals.

### 5. Result submission

Worker results are submitted to `POST /work-items/:id/results`. The route requires a configured bearer/session credential bound to the `agent` role and worker ID. The store then requires the matching work item, lease ID, worker ID, action hash, unexpired active lease, bounded canonical payload, and durable idempotency key before accepting a terminal result. The transaction inserts the immutable result, transitions the work item, consumes the lease, and appends audit evidence together.

The first accepted submission returns `201`; an exact replay returns the original result with `200`; conflicting payloads fail closed with `409`. Results cannot reopen terminal history. `POST /work-items/:id/retry` and `/clone` create fresh linked work items that return to normal policy and approval flow.

In this alpha, the sandbox and worker return only simulated results and persist `executionMode: "dry_run"`. This proves the local lifecycle, not a real command execution or a ChatGPT-originated connector action.

## Security model

ACS assumes:

- LLM output is untrusted.
- Tool descriptions are hints, not authority.
- Tunnel authentication proves reachability, not user intent.
- Privileged paths must route through policy + approval + audit.
- Audit write failure must block mutation.
- Secrets must be redacted before returning to clients or persisting audit data.

Implemented controls include:

- fail-closed policy decisions
- Zod request validation
- exact-action-hash approvals
- approval consumption
- worker leases
- append-only SQLite audit events
- audit hash chaining
- redaction in shared boundaries
- loopback-first local deployment posture
- bearer/OAuth/tunnel-session auth options for MCP/gateway exposure

Read the full threat model in [`docs/threat-model.md`](docs/threat-model.md).

## Requirements

- Node.js `>=24.16.0`
- npm `>=11` recommended; the repo declares `npm@11.17.0`
- SQLite-compatible local filesystem storage
- Git

Check versions:

```sh
node --version
npm --version
git --version
```

## Install

Clone the repository:

```sh
git clone https://github.com/jnibarger01/agent-control-stack.git
cd agent-control-stack
```

Install workspace dependencies:

```sh
npm ci
```

If you are doing iterative local development and intentionally want npm to update the lockfile, use:

```sh
npm install
```

Build all apps and packages:

```sh
npm run build
```

Run the test suite:

```sh
npm test
```

Run the combined local gate:

```sh
npm run check
```

`npm run check` runs TypeScript project builds and the Vitest suite.

## Configuration

Copy the environment template if you want dotenv-style local notes:

```sh
cp .env.example .env
```

Do not commit `.env` or real secrets.

### Core environment variables

| Variable                        | Purpose                                                                            | Local example                     |
| ------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------- |
| `NODE_ENV`                      | Runtime mode. Production disables local bearer MCP fallback.                       | `development`                     |
| `HOST`                          | Gateway bind host if supported by runtime wrapper. Prefer loopback locally.        | `127.0.0.1`                       |
| `PORT`                          | Gateway port.                                                                      | `3000`                            |
| `ACS_DB_PATH`                   | SQLite database path.                                                              | `storage/local.db`                |
| `ACS_GATEWAY_TOKEN`             | Dashboard/API bearer token. Required for HTTP mutations.                           | generate a secret                 |
| `ACS_GATEWAY_ACTOR`             | Requester/actor label for gateway-authenticated mutations.                         | `user`                            |
| `ACS_GATEWAY_ACTOR_ID`          | Registry actor id bound to gateway mutations that require actor registry identity. | optional locally                  |
| `ACS_MCP_BEARER_TOKEN`          | Local development bearer token for `/mcp`. Ignored in production.                  | generate a local token            |
| `ACS_MCP_RESOURCE_METADATA_URL` | Override OAuth protected-resource metadata URL.                                    | optional                          |
| `ACS_OAUTH_ISSUER`              | OAuth issuer for production MCP auth.                                              | provider URL                      |
| `ACS_OAUTH_AUDIENCE`            | OAuth audience/resource, usually public `/mcp` URL.                                | `https://gateway.example.com/mcp` |
| `ACS_OAUTH_JWKS_URI`            | JWKS URI for JWT verification.                                                     | provider JWKS URL                 |
| `ACS_AUTH_MODE`                 | Set to `tunnel_id` for trusted signed tunnel-session mode.                         | optional                          |
| `ACS_TRUSTED_TUNNEL_PROXY`      | Local proxy IP allowed to assert tunnel sessions.                                  | `127.0.0.1`                       |
| `ACS_ALLOWED_TUNNEL_IDS`        | Legacy dev tunnel allowlist. Prefer persistent connector records.                  | optional                          |
| `ACS_TUNNEL_SCOPES`             | Comma-separated MCP scopes for tunnel mode.                                        | `acs:work:create,acs:work:read`   |
| `ACS_MCP_CONFIG`                | Config path for stdio MCP machine controller.                                      | `config.example.yml`              |
| `ACS_MACHINE_CONTROLLER_CONFIG` | Config path used by the gateway direct-agent controller.                           | optional                          |
| `ACS_ACP_AGENT_COMMAND`         | Read-only ACP agent command to spawn.                                              | optional                          |
| `ACS_ACP_AGENT_ARGS_JSON`       | JSON array of ACP command args.                                                    | `[]`                              |
| `ACS_ACP_AGENT_CWD`             | ACP process working directory.                                                     | optional                          |
| `ACS_ACP_AGENT_ID`              | Registry id for ACP agent.                                                         | required with command             |
| `ACS_ACP_ACTOR_ID`              | Actor id for ACP adapter registration.                                             | required with command             |
| `ACS_MOA_CONFIG`                | MoA/model routing config path.                                                     | optional                          |
| `ACS_MOA_AUDIT_LOG`             | MoA audit log path.                                                                | `storage/moa-audit.jsonl`         |
| `ACS_OPENROUTER_API_KEY`        | Optional model provider key for MoA routes.                                        | secret                            |
| `ACS_OPENAI_API_KEY`            | Optional OpenAI/Codex provider key for MoA routes.                                 | secret                            |
| `ACS_OLLAMA_BASE_URL`           | Local Ollama endpoint.                                                             | `http://127.0.0.1:11434`          |

### Machine-controller config

`config.example.yml` defines a deny-by-default local machine-controller policy:

```yaml
security:
  default_policy: deny
  require_approval_for_mutations: true
  redact_secrets: true
  max_output_bytes: 200000
  command_timeout_ms: 120000
  command_termination_grace_ms: 1000
paths:
  allow:
    - /home/jacen/projects
    - /home/jacen/agent-control-stack
  deny:
    - /home/jacen/.ssh
    - /home/jacen/.gnupg
    - /home/jacen/.config
    - /etc
    - /var
commands:
  allow_readonly:
    - git
    - npm
    - node
    - pnpm
    - bun
    - python3
    - docker
    - df
    - free
  deny:
    - rm
    - shred
    - mkfs
    - dd
    - chmod
    - chown
    - sudo
```

The paths above (`/home/jacen/...`) are one maintainer's real local paths, checked in as an example. Replace them with your own before use.

For another machine, copy this file and adjust allowlisted paths. Keep denylisted credential/system paths tighter than your optimism.

Timed-out read-only commands run in an isolated process group on POSIX. ACS sends the whole group `SIGTERM`, waits `command_termination_grace_ms`, then sends `SIGKILL` if the process group remains. Windows does not provide equivalent process-group signaling through Node.js, so ACS terminates only the direct child there; Windows command execution is not a process-tree containment boundary.

## Run locally

Build first:

```sh
npm run build
```

Start the gateway on the default local database:

```sh
ACS_DB_PATH=storage/local.db \
ACS_GATEWAY_TOKEN=change-me-local-dev \
ACS_GATEWAY_ACTOR=user \
npm run start:gateway
```

Open the dashboard:

```text
http://127.0.0.1:3000/
```

Health check:

```sh
curl -fsS http://127.0.0.1:3000/health
```

The gateway also serves an SSE audit stream at:

```text
/events
```

## Use the HTTP gateway

HTTP mutation routes require `ACS_GATEWAY_TOKEN`. Read routes require auth when gateway auth is configured.

Create a work item:

```sh
curl -fsS -X POST http://127.0.0.1:3000/work-items \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer change-me-local-dev' \
  --data '{
    "title": "Inspect repository status",
    "intent": "Check git status without changing files",
    "target": { "cwd": "/home/jacen/agent-control-stack", "files": [] },
    "requestedActions": [
      {
        "kind": "cmd.preview",
        "description": "Run git status read-only",
        "params": {
          "cwd": "/home/jacen/agent-control-stack",
          "command": ["git", "status", "--short"],
          "write": false,
          "network": false,
          "destructive": false
        }
      }
    ],
    "risk": "low"
  }'
```

List work items:

```sh
curl -fsS http://127.0.0.1:3000/work-items \
  -H 'authorization: Bearer change-me-local-dev'
```

Read one work item:

```sh
curl -fsS http://127.0.0.1:3000/work-items/<work_item_id> \
  -H 'authorization: Bearer change-me-local-dev'
```

Approve a work item that is in `needs_approval`:

```sh
curl -fsS -X POST http://127.0.0.1:3000/work-items/<work_item_id>/approve \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer change-me-local-dev' \
  --data '{
    "reason": "Reviewed exact action and approved for local dry-run",
    "actionHash": "<action_hash_from_policy_output_or_dashboard>"
  }'
```

Cancel a work item:

```sh
curl -fsS -X POST http://127.0.0.1:3000/work-items/<work_item_id>/cancel \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer change-me-local-dev' \
  --data '{"reason":"No longer needed"}'
```

`POST /work-items/:id/results` is implemented: it requires a bearer/session credential bound to the `agent` role and a matching worker identity, validates the payload against `submitWorkResultSchema`, and rejects ACS-derived outcomes (`blocked`, `lease_expired`) as not worker-submittable. See [Result submission](#5-result-submission) above for the full acceptance path.

## Use the MCP endpoint

Start the gateway with local MCP bearer auth:

```sh
ACS_DB_PATH=storage/local.db \
ACS_MCP_BEARER_TOKEN=local-dev-token \
ACS_GATEWAY_TOKEN=change-me-local-dev \
npm run start:gateway
```

Initialize MCP over HTTP:

```sh
curl -fsS -X POST http://127.0.0.1:3000/mcp \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer local-dev-token' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

List MCP tools:

```sh
curl -fsS -X POST http://127.0.0.1:3000/mcp \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer local-dev-token' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

Current public MCP work-item tools:

- `create_work_item`
- `get_work_item`
- `list_work_items`
- `approve_work_item`
- `unblock_work_item`
- `reject_work_item`
- `cancel_work_item`

Worker claim/result tools exist only in the local worker/store path. They are not exposed through the public MCP gateway in this alpha.

For stdio MCP machine-controller mode:

```sh
ACS_MCP_CONFIG=config.example.yml npm run start:mcp
```

## Run the worker

The worker is one-shot. It claims at most one approved item, records a dry-run result, and exits.

```sh
ACS_DB_PATH=storage/local.db npm run start:worker
```

Expected no-work output looks like:

```json
{ "executed": false, "reason": "no approved work item" }
```

When it claims work, the result includes the work item id and `executionMode: "dry_run"`.

## Deploy

ACS can be deployed as a local loopback service or behind an authenticated HTTPS reverse proxy. The current alpha should remain local-first unless you have reviewed the threat model and configured production MCP auth.

### Option A: local loopback service

Use this for personal/local operation.

1. Install dependencies and build:

   ```sh
   cd /opt/agent-control-stack
   npm ci --omit=dev=false
   npm run build
   ```

2. Create persistent state directory:

   ```sh
   mkdir -p /var/lib/agent-control-stack
   ```

3. Start gateway bound to loopback through your service manager:

   ```sh
   NODE_ENV=production \
   ACS_DB_PATH=/var/lib/agent-control-stack/control.db \
   ACS_GATEWAY_TOKEN=<secret> \
   ACS_GATEWAY_ACTOR=user \
   npm run start:gateway
   ```

4. Put your local MCP/plugin config at the loopback endpoint:

   ```json
   {
     "mcpServers": {
       "acs": {
         "transport": "http",
         "url": "http://127.0.0.1:3000/mcp"
       }
     }
   }
   ```

### Option B: container deployment

The supported repeatable artifact is the non-root container in `Dockerfile`; `compose.production.yml` provides a loopback-published production template. Follow [`docs/runbooks/production.md`](docs/runbooks/production.md) for build, backup, deploy, smoke, rollback, and recovery.

### Option C: systemd service example

`/etc/agent-control-stack/gateway.env`:

```sh
NODE_ENV=production
ACS_DB_PATH=/var/lib/agent-control-stack/control.db
ACS_GATEWAY_TOKEN=<secret>
ACS_GATEWAY_ACTOR=user
ACS_OAUTH_ISSUER=<issuer>
ACS_OAUTH_AUDIENCE=https://gateway.example.com/mcp
ACS_OAUTH_JWKS_URI=<jwks-uri>
```

`/etc/systemd/system/agent-control-stack-gateway.service`:

```ini
[Unit]
Description=Agent Control Stack Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/agent-control-stack
EnvironmentFile=/etc/agent-control-stack/gateway.env
ExecStart=/usr/bin/npm run start:gateway
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/var/lib/agent-control-stack

[Install]
WantedBy=multi-user.target
```

Enable and start:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now agent-control-stack-gateway
sudo systemctl status agent-control-stack-gateway
```

Adjust paths for your host. Do not blindly paste privileged service files into production. Computers are literal and systemd is especially literal.

### Option D: authenticated HTTPS reverse proxy

For Claude/ChatGPT custom connectors or remote MCP clients, expose only HTTPS and configure OAuth or signed tunnel-session auth.

Production OAuth environment:

```sh
NODE_ENV=production \
ACS_DB_PATH=/var/lib/agent-control-stack/control.db \
ACS_OAUTH_ISSUER=<OAuth issuer> \
ACS_OAUTH_AUDIENCE=https://gateway.example.com/mcp \
ACS_OAUTH_JWKS_URI=<OAuth JWKS URI> \
npm run start:gateway
```

Protected resource metadata is served at:

```text
/.well-known/oauth-protected-resource
/.well-known/oauth-protected-resource/mcp
```

The public MCP endpoint is:

```text
https://gateway.example.com/mcp
```

Do not expose `/mcp` publicly without OAuth/JWKS or signed tunnel-session auth. Local bearer auth is a development fallback and is ignored in `NODE_ENV=production`.

### Option E: signed tunnel-session mode

Use this when a trusted local proxy authenticates the tunnel and injects signed ACS headers.

Gateway environment:

```sh
NODE_ENV=production
ACS_AUTH_MODE=tunnel_id
ACS_TRUSTED_TUNNEL_PROXY=127.0.0.1
ACS_DB_PATH=/var/lib/agent-control-stack/control.db
```

The proxy must provide signed headers such as:

```http
X-ACS-Connector-ID: chatgpt-prod
X-ACS-Tunnel-ID: tunnel_abc123
X-ACS-Session-ID: session_789
X-ACS-Issued-At: 2026-07-05T21:10:00.000Z
X-ACS-Signature: ed25519=<base64url signature>
```

Register connectors and sessions through the authenticated gateway routes before relying on this mode. See [`docs/oauth-authentication.md`](docs/oauth-authentication.md).

## Operations

### Health checks

```sh
curl -fsS http://127.0.0.1:3000/health
```

Use `/livez` for process liveness and `/readyz` for traffic readiness. `/health` remains a compatibility alias for readiness. A ready response means the SQLite store can read/write health probes, migration checksums match, the audit chain has not failed closed, and stale active tunnel sessions or available agent states have been reconciled using the shared 15-minute heartbeat TTL. Reconciliation persists terminal/offline state and appends an audit event; it does not delete history.

`GET /mcp/tools` is an authenticated capability-inventory route and requires the MCP `acs:work:read` scope. Anonymous, invalid, and insufficient-scope requests do not receive the tool inventory.

### Logs

- Gateway logs go to stdout/stderr by default.
- systemd deployments should use `journalctl -u agent-control-stack-gateway`.
- MoA audit defaults to `storage/moa-audit.jsonl` when enabled.
- Work-item audit data is stored in SQLite `audit_events`.

### Database

Default local database:

```text
storage/local.db
```

Recommended production path:

```text
/var/lib/agent-control-stack/control.db
```

Migrations live in:

```text
storage/migrations/
```

Current storage includes:

- `work_items`
- `approval_records`
- `audit_events`
- `connector_records`
- `tunnel_sessions`
- agent registry tables
- event indexes

Back up the SQLite database before upgrades:

```sh
npm run db:ops -- backup /var/lib/agent-control-stack/control.db /secure-backups/control.db.bak
```

### Upgrades

```sh
cd /opt/agent-control-stack
git fetch --all --prune
git checkout main
git pull --ff-only
npm ci
npm run build
npm test
sudo systemctl restart agent-control-stack-gateway
```

If `npm test` fails, do not restart the service and call it a deployment. That is not deployment; that is hope with a prompt.

### Rollback

1. Stop the gateway.
2. Restore the prior git revision.
3. Restore the SQLite backup if the migration/data shape changed.
4. Run `npm ci`, `npm run build`, and `npm test`.
5. Start the gateway.

## Validation

Local validation gate:

```sh
npm ci
npm run check
```

Focused commands:

```sh
npm run build
npm test
```

Gateway smoke after build:

```sh
ACS_DB_PATH=storage/local.db \
ACS_GATEWAY_TOKEN=local-dev-token \
npm run start:gateway
```

Then in another shell:

```sh
curl -fsS http://127.0.0.1:3000/health
```

MCP smoke:

```sh
curl -fsS -X POST http://127.0.0.1:3000/mcp \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer local-dev-token' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

## Known limitations

- Worker execution is dry-run only (`packages/machine-controller`'s standalone read-only command execution is real; see [What this alpha does not do](#what-this-alpha-does-not-do)).
- No real OS sandbox is wired in yet.
- `packages/verification`'s independent verifier check is not yet called from the result-submission write path.
- `packages/secret-broker`, `packages/engine-adapter`, and `packages/workspace-manager` are implemented but not yet consumed by any app path.
- Production remote connector mode requires OAuth or signed tunnel-session deployment and TLS termination.
- Docker and Compose artifacts are provided; Kubernetes and a checked-in systemd unit are not.
- Dashboard approval rendering is intentionally minimal.
- Error envelopes are not uniform across every route.
- Release hardening is still in progress.

## Related docs

- [`docs/architecture.md`](docs/architecture.md)
- [`docs/architecture-invariants.md`](docs/architecture-invariants.md)
- [`docs/threat-model.md`](docs/threat-model.md)
- [`docs/oauth-authentication.md`](docs/oauth-authentication.md)
- [`docs/runbooks/local-dev.md`](docs/runbooks/local-dev.md)
- [`docs/runbooks/production.md`](docs/runbooks/production.md)
- [`docs/releases/v0.1.0-alpha.md`](docs/releases/v0.1.0-alpha.md)

## License

No license file is currently declared in this repository. Add one before publishing binaries or accepting outside contributions.
