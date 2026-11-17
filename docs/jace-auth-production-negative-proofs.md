# Jace Auth production-issuer negative proofs

Date: **2026-11-17**
ACS branch: `chore/jace-auth-prod-issuer-preset`
Gateway: `apps/gateway/src/index.ts` (tsx) on `127.0.0.1:3010`, `NODE_ENV=production`, strict config

Configuration used (the frozen production preset from
[`oauth-authentication.md`](oauth-authentication.md) and
`compose.production.env.example`):

```sh
ACS_OAUTH_ISSUER=https://jace-auth.vercel.app
ACS_OAUTH_AUDIENCE=https://jace-auth.vercel.app/resources/agent-control-stack
ACS_OAUTH_JWKS_URI=https://jace-auth.vercel.app/jwks
```

## Negative proofs (no operator credentials required)

| # | Request | Result |
| --- | --- | --- |
| N1 | MCP `initialize` with **no bearer** | HTTP 401, `authError=missing_token`, `WWW-Authenticate` `resource_metadata` advertised under `https://jace-auth.vercel.app` — the gateway presents jace-auth as its authorization server |
| N2 | MCP `initialize` with a **forged RS256 token** — correct `iss`/`aud`/`exp`/`scope` claims, signed by an attacker-generated key | HTTP 401, `authError=invalid_token` — the gateway fetched the production JWKS and rejected the signature |

N2 is the meaningful one: the token is indistinguishable from a legitimate
jace-auth token by shape and claims; only the signature differs, so the 401
proves the gateway verified against the **production** JWKS, not a cached or
local key.

## Positive proof status

A positive proof (real jace-auth-issued token → MCP `initialize` → 200) was
completed against the local issuer on 2026-08-24
([`jace-auth-e2e-verification.md`](jace-auth-e2e-verification.md)). The
production-issuer positive proof requires one production-issued token
(`service-smoke` client-credentials secret or a browser authorization-code
flow) and is tracked in jace-auth `docs/PROOF_LOG.md` as the remaining
credential-gated step.

## Reproduce

```sh
NODE_ENV=production ACS_STRICT_CONFIG=1 HOST=127.0.0.1 PORT=3010 \
  ACS_DB_PATH=/tmp/acs-drill/control.db \
  ACS_GATEWAY_CREDENTIALS_JSON='[{"id":"drill-1","token":"<32+ chars>","actor":"operator","actorId":"drill-1","roles":["operator"],"scopes":["acs:read"]}]' \
  ACS_OAUTH_ISSUER=https://jace-auth.vercel.app \
  ACS_OAUTH_AUDIENCE=https://jace-auth.vercel.app/resources/agent-control-stack \
  ACS_OAUTH_JWKS_URI=https://jace-auth.vercel.app/jwks \
  ./node_modules/.bin/tsx apps/gateway/src/index.ts
```

Then POST an MCP `initialize` to `/mcp` with no bearer (N1) and with a
self-signed RS256 JWT carrying jace-auth `iss`/`aud` claims (N2).
