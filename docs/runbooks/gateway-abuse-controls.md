# Gateway abuse controls (rate limit + auth lockout + intake ceilings)

Default auth, rate-limit, auth-lockout, and JSON body-size knobs that keep one client from
unbounded-writing work items over HTTP or MCP, and that slow credential stuffing on
dashboard login and device-auth user-code entry. Pair with
[local-dev.md](./local-dev.md) for loopback setup and
[production.md](./production.md) for remote binding.

## What is bounded by default

| Control                    | Default                                | Effect                                                                                                                                                |
| -------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-principal request rate | 120 requests / 60s                     | Sliding window on mutation, MCP, session login, and webhook routes.                                                                                   |
| Auth failure lockout       | 5 failures / 15m                       | After N failed `/session/login` or `/device/verify` attempts, return `429 auth_lockout` and skip credential / user-code checks until the window ends. |
| Pending work-item ceiling  | 1000                                   | Rejects new intake when draft/pending_policy/needs_approval/approved/running count is at the ceiling.                                                 |
| Default JSON body limit    | 256 KiB                                | Global Fastify `bodyLimit` on the gateway; oversize bodies return `413 body_too_large`.                                                               |
| Auth                       | Local bearer / credentials (see below) | Mutations and protected MCP tools require a configured principal.                                                                                     |

A burst from one principal therefore hits either `429 rate_limited` or
`429 work_queue_full` instead of growing the queue without bound. Oversize JSON
payloads are rejected with `413 body_too_large` before work-item storage writes.

## Principal key (rate limit)

The limiter keys on `method + route + principal`:

1. Gateway credential id when `ACS_GATEWAY_CREDENTIALS_JSON` / legacy token matches.
2. Else a short SHA-256 digest of the `Authorization: Bearer` token (MCP local bearer, OAuth bearer, etc.).
3. Else client IP.

Different bearers on the same loopback IP do not share a bucket. Raw tokens are
never stored in the key—only a truncated hash.

## Auth failure lockout

Independent of the request-rate limiter: only **failed** dashboard logins and
device-auth verification attempts are counted.

| Surface               | Principal key                        | Failure                                                             | Success                                  |
| --------------------- | ------------------------------------ | ------------------------------------------------------------------- | ---------------------------------------- |
| `POST /session/login` | Client IP                            | Wrong / unknown token                                               | Valid login clears the IP streak         |
| `POST /device/verify` | Client IP **and** hashed `user_code` | `not_found` / `expired` / conflict after a well-formed approve/deny | Successful approve/deny clears both keys |

After **N** failures in the window, the gateway returns HTTP **429** with
`Retry-After`, body code `auth_lockout`, and **skips** credential / user-code
checks until the window ends. Lockouts increment
`acs_auth_lockout_total{route}` on `/metrics`. Raw tokens and user codes are
never logged or stored in lockout keys—only the IP and a truncated SHA-256 of
the normalized user code.

## Structured 429 responses

| Path                  | Body shape                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| HTTP mutations        | `{ "error": "...", "code": "rate_limited" \| "work_queue_full" \| "auth_lockout", "retry_after_seconds"?: number }` |
| MCP `/mcp` rate limit | JSON-RPC error `-32029` with `data: { code: "rate_limited", retry_after_seconds }`                                  |

HTTP and MCP rate-limit replies also set `Retry-After` and
`x-ratelimit-remaining`. Rejected rate limits increment
`acs_rate_limit_rejected_total{method,route}` on `/metrics` (alongside the
usual `acs_http_requests_total` status series). Auth lockouts increment
`acs_auth_lockout_total{route}`.

## JSON body size limit

The gateway sets a global Fastify `bodyLimit` of **256 KiB**. Oversize bodies
are rejected with HTTP 413 and a stable ACS error code:

```json
{ "error": "request body is too large", "code": "body_too_large" }
```

### Route overrides (explicit limits)

| Route                            | Limit                                                            | Why                                                                 |
| -------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| `POST /work-items/:id/results`   | 256 KiB (`MAX_RESULT_BODY_BYTES`)                                | Worker result payloads; explicit route limit (matches the default). |
| `POST /v1/responses` (inference) | 16 MiB default (up to 64 MiB via `ACS_INFERENCE_MAX_BODY_BYTES`) | OpenAI-compatible proxy; raised only when inference is enabled.     |

Do not raise the global default to accommodate a single route—set a per-route
`bodyLimit` instead.

## Environment knobs

| Variable                                      | Purpose                                                                 | Local default / recommendation                             | Deployed recommendation                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `ACS_RATE_LIMIT_WINDOW_MS`                    | Sliding-window length (ms).                                             | `60000`                                                    | Keep `60000` unless you have a front-door limiter; raise only with evidence.               |
| `ACS_RATE_LIMIT_MAX_REQUESTS`                 | Max requests per principal+route in the window.                         | `120` (comfortable for local dashboards and MCP tools).    | Tighten toward `30`–`60` for internet-facing gateways; keep ≥ worker/operator burst needs. |
| `ACS_AUTH_LOCKOUT_WINDOW_MS`                  | Failed-attempt lockout window (ms) for login + device verify.           | `900000` (15 minutes).                                     | Keep default unless a front-door WAF already locks out; shorten only with evidence.        |
| `ACS_AUTH_LOCKOUT_MAX_FAILURES`               | Failures per principal in the lockout window before `429 auth_lockout`. | `5`.                                                       | Tighten toward `3` for internet-facing gateways; raise only for shared NAT pain.           |
| `ACS_MAX_PENDING_WORK_ITEMS`                  | Cap on non-terminal work items before intake returns `work_queue_full`. | `1000` (or lower, e.g. `50`, for tiny local DBs).          | Size to disk/ops capacity (often `100`–`500` for alpha hosts).                             |
| `ACS_GATEWAY_TOKEN` / `ACS_GATEWAY_ACTOR`     | Legacy local HTTP/dashboard bearer.                                     | Generate a local secret; bind loopback only.               | Do **not** use for remote production binding.                                              |
| `ACS_GATEWAY_CREDENTIALS_JSON`                | Credential-bound actors, roles, scopes.                                 | Optional locally.                                          | **Required** for non-loopback production.                                                  |
| `ACS_MCP_BEARER_TOKEN`                        | Local MCP bearer (ignored when `NODE_ENV=production`).                  | Local-only secret for `/mcp` tools.                        | Prefer OAuth/JWKS or trusted tunnel; never rely on this in production.                     |
| `ACS_OAUTH_*` / `ACS_AUTH_MODE` / tunnel vars | Production MCP auth.                                                    | See [oauth-authentication.md](../oauth-authentication.md). | Required for remote production binding (OAuth **or** trusted tunnel).                      |
| `ACS_MCP_ALLOWED_ORIGINS`                     | Browser origins allowed to call remote MCP.                             | Optional on loopback.                                      | **Required** for remote production binding.                                                |

Related SSE caps (`ACS_MAX_SSE_CLIENTS`, `ACS_MAX_SSE_CLIENTS_PER_PRINCIPAL`) are
documented in the production runbook; they bound event subscribers, not work-item
writes.

## Local vs deployed checklist

**Local (loopback)**

```sh
HOST=127.0.0.1
PORT=3000
ACS_DB_PATH=storage/local.db
ACS_GATEWAY_TOKEN=change-me-local-dev
ACS_GATEWAY_ACTOR=user
ACS_MCP_BEARER_TOKEN=local-dev-token
# defaults are fine; optional tighter local ceiling:
# ACS_RATE_LIMIT_MAX_REQUESTS=60
# ACS_MAX_PENDING_WORK_ITEMS=100
```

**Deployed (non-loopback / production)**

- Require `ACS_GATEWAY_CREDENTIALS_JSON`, `ACS_MCP_ALLOWED_ORIGINS`, and complete
  OAuth **or** trusted tunnel auth (enforced by listen config).
- Do not set `ACS_MCP_BEARER_TOKEN` as the production auth path.
- Set `ACS_MAX_PENDING_WORK_ITEMS` to an operationally safe queue ceiling.
- Prefer a stricter `ACS_RATE_LIMIT_MAX_REQUESTS` behind TLS; scrape `/metrics`
  for `acs_rate_limit_rejected_total` and HTTP 429 rates.
- Put a reverse-proxy / WAF rate limit in front for coarse IP abuse; keep the
  in-process per-principal limiter for credential/bearer isolation.

## Routes covered by the in-process limiter

`POST/PUT/PATCH/DELETE` (non-GET) on:

- `/mcp`
- `/session/login`
- `/oauth/device/code` and `/oauth/token`
- `/work-items` and `/work-items/*`
- `/webhooks/*`

`GET`/`POST` `/device/verify` are rate-limited **in-handler** (same
`SlidingWindowRateLimiter`) so static analysis can see the control on the
authorization surface; they are not double-counted by the global hook.

GET health/metrics/read routes are not rate-limited by this hook.

## Smoke (optional)

```sh
npx vitest run apps/gateway/src/server.test.ts -t 'gateway abuse controls'
npx vitest run apps/gateway/src/server.test.ts -t 'auth lockout'
npx vitest run apps/gateway/src/auth-lockout.test.ts
npx vitest run apps/gateway/src/result-submission.test.ts -t 'HTTP request body limit'
```

## See also

- [local-dev.md](./local-dev.md) — loopback gateway and MCP bearer testing
- [production.md](./production.md) — remote binding prerequisites and metrics
- [oauth-authentication.md](../oauth-authentication.md) — MCP OAuth / tunnel auth
- [threat-model.md](../threat-model.md) — MCP auth expectations
