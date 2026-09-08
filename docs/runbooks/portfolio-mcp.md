# Portfolio MCP runbook (`ACS_PORTFOLIO_BASE_URL`)

Wire the seven read-only `portfolio.*` MCP tools to a local Visualizer in under
fifteen minutes. ACS never holds GitHub credentials and never calls GitHub for
these tools; it only GETs Visualizer loopback portfolio API.

## Prerequisites

- ACS gateway built and runnable (build then start gateway or acs serve).
- Visualizer serving its portfolio HTTP API on loopback. Contract branch:
  jnibarger01/visualizer -> feat/github-portfolio-intelligence
  (routes under /api/v1/portfolio*; JSON objects only; no credential fields).

## Configure (loopback only)

Set a loopback origin. Do not use a LAN, tunnel, or public URL.

    ACS_PORTFOLIO_BASE_URL=http://127.0.0.1:8787
    ACS_PORTFOLIO_TIMEOUT_MS=5000

`localhost` is also accepted. Any non-loopback value is rejected at config
parse time; the gateway still starts and every `portfolio.*` tool returns
PORTFOLIO_UNAVAILABLE. Leaving the variable unset has the same unavailable
behavior (tools stay listed).

Copy the commented block from `.env.example` into your local `.env` if you use
dotenv-style local config.

Restart the gateway after changing the env so createPortfolioClientFromEnv
rebuilds the client.

## Smoke without a real Visualizer (CI-safe contract)

CI must not depend on Visualizer. Contract coverage lives in:

- apps/gateway/src/portfolio-client.test.ts — loopback URL guard, path map,
  unavailable vs happy-path client behavior (fake Visualizer on 127.0.0.1)
- apps/gateway/src/portfolio-mcp.test.ts — MCP tool listing, unavailable
  error shape, injected happy path

Run just those suites:

    npx vitest run apps/gateway/src/portfolio-client.test.ts apps/gateway/src/portfolio-mcp.test.ts

Or the standalone local smoke (starts an ephemeral fake Visualizer unless you
pass --live):

    node scripts/portfolio-mcp-smoke.mjs
    ACS_PORTFOLIO_BASE_URL=http://127.0.0.1:8787 node scripts/portfolio-mcp-smoke.mjs --live

The smoke hits GET /api/v1/portfolio and GET /api/v1/portfolio/attention
(the portfolio.get_summary / portfolio.list_attention_required client paths).
It is not wired into the default test or check scripts.

## Smoke through MCP (optional)

With gateway + Visualizer running and ACS_MCP_BEARER_TOKEN set, POST tools/call
for portfolio.get_summary to http://127.0.0.1:3000/mcp with Bearer auth.
Expect HTTP 200 with structured portfolio JSON when Visualizer is up, or a
JSON-RPC error whose message contains PORTFOLIO_UNAVAILABLE when it is not.

## Tool to Visualizer route map

| MCP tool                          | Visualizer route                                  |
| --------------------------------- | ------------------------------------------------- |
| portfolio.get_summary             | GET /api/v1/portfolio                             |
| portfolio.list_repositories       | GET /api/v1/portfolio/repositories                |
| portfolio.list_attention_required | GET /api/v1/portfolio/attention                   |
| portfolio.get_repository          | GET /api/v1/portfolio/repositories/{owner}/{repo} |
| portfolio.list_failures           | GET /api/v1/portfolio/failures                    |
| portfolio.list_pending_work       | GET /api/v1/portfolio/pending-work                |
| portfolio.list_recent_progress    | GET /api/v1/portfolio/activity                    |

Filters (status, lifecycle, limit) are applied client-side; do not append
query strings (Visualizer rejects them). Scope: acs:work:read. Annotations:
readOnlyHint true, destructiveHint false, openWorldHint false.

Protocol detail: docs/protocol/mcp-tools.md.

## V2 writes stay denied

GitHub mutations stay out of scope until Visualizer reports
proving.eligibleForV2 === true. Do not point ACS_PORTFOLIO_BASE_URL at a
non-loopback host to enable writes — the client refuses non-loopback URLs.
