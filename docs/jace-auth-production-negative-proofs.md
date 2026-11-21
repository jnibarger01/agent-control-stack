# Jace Auth production-issuer negative proofs

Captured: **2026-11-21 01:52:51 to 01:52:53 UTC** (local run; `summary.json` has the timestamps).
Capture script: `scripts/jace-auth-negative-proofs.mjs`
Evidence directory: `docs/evidence/jace-auth-negative-proofs/`

| Item | Value |
| --- | --- |
| ACS branch | `chore/jace-auth-preset-fixes` (based on `chore/jace-auth-preset-on-main`) |
| ACS code commit at capture | `931c499b9c52dd2f93f0ff85087798dbfc7ff3b4` (fixes in `4286cd40`) |
| ACS commit containing this document and evidence | see `git log` on the branch (recorded in the report that accompanies this change) |
| jace-auth commit | `c3d58df9c1a0d07564446f0757d506acca9e2c19`, **working tree dirty** (one uncommitted change, not reviewed here) |
| Production JWKS | `https://jace-auth.vercel.app/jwks`, HTTP 200, body SHA-256 `bdf14d3c381e06a5bf79930c947a0528d9a61c152d1badc12c64b9cb2c124e0f`, one RSA key, `kid` `r2x5WAGgEnlK4DpzofC7qsxxfjajcxm8`, `alg` RS256 |
| Gateway | `apps/gateway/src/index.ts` via tsx, `127.0.0.1:3010`, `NODE_ENV=production`, `ACS_STRICT_CONFIG=1`, temporary database |

This is a local, isolated gateway. Production infrastructure and production credentials were not used or modified. The only production contact is the read-only GET of the public JWKS.

## Configuration used

The frozen production preset from [`oauth-authentication.md`](oauth-authentication.md), plus the gateway-owned metadata URL that the strict config now requires:

```sh
ACS_OAUTH_ISSUER=https://jace-auth.vercel.app
ACS_OAUTH_AUDIENCE=https://jace-auth.vercel.app/resources/agent-control-stack
ACS_OAUTH_JWKS_URI=https://jace-auth.vercel.app/jwks
ACS_MCP_RESOURCE_METADATA_URL=https://gateway.drill.example/.well-known/oauth-protected-resource/mcp
```

`gateway.drill.example` is a reserved placeholder. The validator needs an `https` URL on a non-issuer origin. Nothing resolves that host during the proof.

The gateway was run twice:

- **Run A** uses the documented JWKS URI, so it exercises the configuration exactly as an operator would set it.
- **Run B** is identical except that `ACS_OAUTH_JWKS_URI` points at a logging relay on `127.0.0.1:3011`. The relay forwards `GET /jwks` to production unchanged and records the response. Run B is what makes the gateway's JWKS fetch observable.

## Results

| # | Request | Result | Verdict |
| --- | --- | --- | --- |
| N0 | `GET /.well-known/oauth-protected-resource/mcp` (gateway's own metadata, precondition for N1) | HTTP 200. `resource` is the jace-auth audience, `authorization_servers` is `["https://jace-auth.vercel.app"]`, `resource_name` is `Agent Control Stack MCP Gateway` | **PASS** |
| N1 | MCP `initialize` on `POST /mcp` with **no bearer** | HTTP 401. `WWW-Authenticate: Bearer resource_metadata="https://gateway.drill.example/.well-known/oauth-protected-resource/mcp", error="invalid_token", error_description="missing bearer token"`. Body `authError: missing_token`. | **PASS** |
| N2 | MCP `initialize` with a **forged RS256 JWT** (valid header, `iss`, `aud`, `exp`, `sub`, `client_id`, `scope`; signed by a key that exists only in memory during the run) | Run A: HTTP 401, `authError: invalid_token`. Run B: HTTP 401, `authError: invalid_token`. | **PASS** (see the stage evidence below) |

### N1: what the challenge advertises

The `resource_metadata` parameter in the challenge is the gateway's own metadata URL. It is not derived from the audience, and it does not point at jace-auth. Before this fix, the gateway derived it from the audience, which gave `https://jace-auth.vercel.app/.well-known/oauth-protected-resource/resources/agent-control-stack`. jace-auth does not serve that path.

The authorization server is advertised separately, in the `authorization_servers` field of the metadata document (N0).

### N2: where the rejection happens

N2 is only meaningful if the rejection comes from signature validation against the production key set. Three observations establish that.

1. **The gateway fetched the production key set.** In run B, the relay recorded one fetch: `GET /jwks`, upstream HTTP 200, body SHA-256 `bdf14d3c…`. That hash equals the production JWKS fetched directly. Run A's fetch is not directly observed, but it uses the same URL and returns the same key set.
2. **The forged token passes everything except the signature.** `jose` `jwtVerify`, the library the gateway uses, rejects the token with `ERR_JWS_SIGNATURE_VERIFICATION_FAILED` (`signature verification failed`) when verified against the production JWKS with the expected issuer, audience and algorithms. The `kid` in the header matches the production key, so the production key is what the signature is checked against.
3. **A kid control confirms key selection.** The same claims with a `kid` absent from production fail earlier, with `ERR_JWKS_NO_MATCHING_KEY`. That confirms the forged token's `kid` is what matches the production key, so the signature check is against that key.

The gateway collapses every verification error into `invalid_token`. The stage evidence above comes from the same library call against the same JWKS. It does not come from instrumenting the gateway's internals.

### Forged token (sanitized)

Header: `{"alg":"RS256","typ":"JWT","kid":"r2x5WAGgEnlK4DpzofC7qsxxfjajcxm8"}`

Claims: `iss` `https://jace-auth.vercel.app`, `aud` `https://jace-auth.vercel.app/resources/agent-control-stack`, `sub` `forged-subject-negative-proof`, `client_id` `forged-client-negative-proof`, `scope` `acs:work:read acs:work:create`, `iat` and `exp` five minutes apart.

The signature is not recorded. Its length is. The private key is never serialized.

## Evidence artifacts

| File | Contents |
| --- | --- |
| `docs/evidence/jace-auth-negative-proofs/summary.json` | Provenance, JWKS hash, forged-token header and claims, stage and control results, relay log, both runs' HTTP responses, verdicts |
| `docs/evidence/jace-auth-negative-proofs/jwks-production.public.json` | Public JWKS hash and key metadata. Public key material is not secret. |
| `docs/evidence/jace-auth-negative-proofs/gateway-log-runA-documented-production-jwks-uri.redacted.txt` | Gateway stdout and stderr, redacted |
| `docs/evidence/jace-auth-negative-proofs/gateway-log-runB-relayed-production-jwks.redacted.txt` | Gateway stdout and stderr for run B, redacted |

The disposable credential token is generated per run and redacted from every log. The redaction check found no occurrence of it in the captured logs.

## Positive proof status

A positive proof (real jace-auth-issued token, MCP `initialize` returns 200) was completed against the local issuer on 2026-08-24 ([`jace-auth-e2e-verification.md`](jace-auth-e2e-verification.md)).

The production-issuer positive proof is **not done**. It needs one production-issued token: a `service-smoke` client-credentials secret, or a browser authorization-code flow. Those credentials were not available to this capture, and no production credential was used. The step is tracked in jace-auth `docs/PROOF_LOG.md`.

## Limitations

- Local isolated gateway only. Nothing was deployed, and production credentials were not used.
- The JWKS is read live from production. Run B's relay sees the production content, but the gateway's configured URI in run B is the relay.
- The jace-auth working tree was dirty at capture, with one uncommitted change. That change is not part of these proofs.
- The gateway's own signature stage is not instrumented. The stage evidence is the same library call against the same JWKS.

## Reproduce

```sh
node scripts/jace-auth-negative-proofs.mjs --out docs/evidence/jace-auth-negative-proofs
```

The script needs `node_modules` installed (`npm ci --ignore-scripts` and `npx tsc -b`), and it needs outbound HTTPS to `jace-auth.vercel.app` for the JWKS fetch. It uses only loopback ports 3010 and 3011.
