# Vercel MCP Ingress Implementation Plan

## Goal

Replace the hosted Desktop Commander remote MCP dependency with a Vercel-hosted public MCP transport while preserving ACS as the sole execution authority.

## Invariants

- Vercel handles public ingress, first-pass authentication, and durable delivery.
- ACS remains authoritative for MCP tools, scopes, policy, approvals, leases, audit, and execution.
- Desktop Commander remains local and receives only ACS-issued capabilities.
- Ubuntu initiates outbound network traffic only; ACS and Desktop Commander stay loopback-bound.
- Plaintext client bearer credentials never enter Vercel Queue payloads or the replay database.
- Queue redelivery cannot execute the same request twice.
- A request is never executed after the public caller's deadline.

## Transport

1. Client sends MCP JSON-RPC to public `POST /mcp`.
2. Vercel validates request bounds and authenticates the caller.
3. Static-bearer mode queues no caller credential; Ubuntu uses a signed ACS tunnel session.
4. OAuth mode verifies the JWT at Vercel, encrypts the Authorization header to Ubuntu's X25519 public key, and queues ciphertext only.
5. Ubuntu polls `acs-mcp-requests-v1` using short-lived Vercel project OIDC.
6. The queue delivery remains leased while Ubuntu calls loopback ACS `/mcp`.
7. OAuth mode decrypts the bearer token only on Ubuntu and lets ACS verify it again.
8. Tunnel mode creates a fresh local Ed25519 tunnel assertion for each ACS request.
9. The bridge persists the ACS result before publishing it.
10. Vercel returns the original ACS status/body and allowed authentication challenge.

## Authentication

- ChatGPT/plugin path: `ACS_VERCEL_PUBLIC_AUTH_MODE=oauth`.
- Direct MCP/Agents/Codex path may use `static_bearer`.
- OAuth ingress validates issuer, audience, signature, and temporal JWT claims with `jose`.
- OAuth bearer tokens are sealed with ephemeral X25519 + HKDF-SHA256 + AES-256-GCM.
- Ciphertext is bound to request id, result topic, and expiry with AEAD additional data.
- Only Ubuntu stores the X25519 private key.
- ACS performs the authoritative second OAuth verification and per-tool scope check.
- Tunnel private keys and gateway service bearer tokens stay only on Ubuntu.
- Queue access uses project OIDC minted from a local Vercel access token through the Vercel REST API.

## Components

- `packages/vercel-bridge-contract`: strict envelopes and authorization encryption.
- `apps/vercel-mcp-ingress`: Vercel HTTP/OAuth/queue ingress.
- `apps/vercel-bridge-worker`: outbound poller, local ACS forwarder, replay ledger, OIDC refresh.
- `deploy/systemd/acs-vercel-bridge.service`: hardened local daemon unit.
- `docs/runbooks/vercel-mcp-ingress.md`: deployment and recovery procedure.

## Existing authority reused

- `apps/gateway/src/mcp.ts`: MCP schemas, tool metadata, OAuth scope requirements.
- `apps/gateway/src/auth.ts`: OAuth and signed-tunnel verification.
- `apps/gateway/src/server.ts`: loopback `/mcp` and tunnel-session lifecycle.
- `apps/worker` + `packages/desktop-commander-adapter`: machine execution authority.

## Acceptance gates

1. Strict bounded schemas reject malformed/oversized/credential-injection envelopes.
2. OAuth ciphertext cannot be opened with altered request correlation data.
3. Public auth fails closed before queue send.
4. Plaintext bearer tokens never enter queues or replay storage.
5. Results preserve ACS status, JSON-RPC body, and only `WWW-Authenticate`.
6. Replay returns a completed result without re-executing ACS.
7. Publish failure causes redelivery without duplicate execution.
8. Expired queued requests never execute.
9. Off-platform queue clients are explicitly unpinned from Vercel deployments.
10. Tunnel mode keeps ACS session heartbeat below its liveness TTL.
11. OAuth mode has no tunnel-session or gateway-token dependency.
12. Clean-output TypeScript build, focused tests, lint, security audit, and ACS auth regressions pass.

## Deployment boundary

Production deployment, secret creation, ACS session registration, and branch merge happen only after all local verification and review gates pass.
