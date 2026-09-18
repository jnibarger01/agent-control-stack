# Vercel MCP Ingress Runbook

## Topology

Public MCP clients call Vercel at `/mcp`. Vercel authenticates and publishes a bounded request envelope to Vercel Queues. The Ubuntu bridge polls outbound, calls loopback ACS, publishes the result, and only then allows the request delivery to ACK.

ACS remains the policy and execution authority. Desktop Commander is never exposed publicly.

## Modes

Use `oauth` for ChatGPT/plugin clients. Use `static_bearer` + local tunnel mode only for direct MCP clients that can supply a shared bearer token.

OAuth mode requires the same issuer, audience, and JWKS settings on Vercel and ACS. ACS performs a second JWT verification and its normal per-tool scope checks.

## Generate the OAuth bridge key

On Ubuntu:

```sh
sudo install -d -m 0700 /etc/agent-control-stack
sudo openssl genpkey -algorithm X25519 \
  -out /etc/agent-control-stack/vercel-bridge-auth-x25519.key
sudo chmod 0600 /etc/agent-control-stack/vercel-bridge-auth-x25519.key
sudo openssl pkey \
  -in /etc/agent-control-stack/vercel-bridge-auth-x25519.key \
  -pubout
```

Store only the printed public key in Vercel as `ACS_VERCEL_BRIDGE_AUTH_PUBLIC_KEY_PEM`. The private key never leaves Ubuntu.

## Configure Vercel OAuth ingress

Configure the Vercel project root as `apps/vercel-mcp-ingress`. Set:

```text
ACS_VERCEL_PUBLIC_AUTH_MODE=oauth
ACS_VERCEL_QUEUE_REGION=iad1
ACS_VERCEL_MCP_TIMEOUT_MS=85000
ACS_VERCEL_PUBLIC_RESOURCE_URL=https://<host>/mcp
ACS_VERCEL_RESOURCE_METADATA_URL=https://<host>/.well-known/oauth-protected-resource/mcp
ACS_VERCEL_OAUTH_ISSUER=https://<issuer>
ACS_VERCEL_OAUTH_AUDIENCE=https://<host>/mcp
ACS_VERCEL_OAUTH_JWKS_URI=https://<issuer>/<jwks-path>
ACS_VERCEL_OAUTH_AUTHORIZATION_SERVER=https://<issuer>
ACS_VERCEL_OAUTH_SCOPES=acs:work:read,acs:work:create
ACS_VERCEL_BRIDGE_AUTH_PUBLIC_KEY_PEM=<X25519 public PEM>
```

Set ACS to the same OAuth issuer/audience/JWKS values. Do not configure a public ACS listener; the bridge calls the loopback gateway.

## Configure the local bridge

Create an owner-only Vercel access-token file with permission to mint a project OIDC token:

```sh
sudo install -m 0600 /dev/null /etc/agent-control-stack/vercel-access-token
sudoedit /etc/agent-control-stack/vercel-access-token
```

Copy `deploy/systemd/acs-vercel-bridge.env.example` to `/etc/agent-control-stack/vercel-bridge.env`, set project/team values, and keep:

```text
ACS_VERCEL_AUTH_MODE=oauth
ACS_VERCEL_AUTH_PRIVATE_KEY_FILE=/etc/agent-control-stack/vercel-bridge-auth-x25519.key
```

The systemd unit intentionally does not depend on a user's NVM or Homebrew installation. Provision Node.js 24 or newer at `/opt/agent-control-stack/runtime/node/bin/node` and verify it before enabling the service:

```sh
/opt/agent-control-stack/runtime/node/bin/node --version
```

Install the unit after building the repository:

```sh
sudo cp deploy/systemd/acs-vercel-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now acs-vercel-bridge.service
sudo systemctl status acs-vercel-bridge.service
```

The daemon refuses group/world-readable secret files.

## Tunnel mode

For direct static-bearer clients, set Vercel `ACS_VERCEL_PUBLIC_AUTH_MODE=static_bearer` and configure `ACS_VERCEL_MCP_TOKEN`.

Set the local bridge to `ACS_VERCEL_AUTH_MODE=tunnel`, generate an Ed25519 private key, register its public key as an ACS connector, register a tunnel session, and provide the tunnel-mode variables from `deploy/systemd/acs-vercel-bridge.env.example`.

The daemon heartbeats every five minutes by default, below ACS's 15-minute default liveness TTL. Do not grant approval scopes to a public connector unless separately reviewed.

## Key rotation

For OAuth bridge encryption, generate a new X25519 keypair, place the new private key in an owner-only file, update Vercel `ACS_VERCEL_BRIDGE_AUTH_PUBLIC_KEY_PEM` with the matching public key, then atomically update `ACS_VERCEL_AUTH_PRIVATE_KEY_FILE` and restart the bridge. Rotate only when no in-flight queue requests remain, because ciphertext created for the old key cannot be opened by the new key.

For tunnel mode, register the replacement Ed25519 public key and tunnel session in ACS first, update the local private-key/session settings, restart the bridge, verify a heartbeat and a read-only MCP call, then revoke the old tunnel session and connector key.

Rotate the local Vercel access token independently by replacing the owner-only token file and restarting the bridge. Do not place old or new private keys in Vercel, Git, shell history, or queue payloads.

## Verification

Before production:

```sh
npm ci
npm run typecheck
npx vitest run packages/vercel-bridge-contract/src apps/vercel-mcp-ingress/src apps/vercel-bridge-worker/src
npm run lint
npm run security:audit
systemd-analyze verify deploy/systemd/acs-vercel-bridge.service
```

Verify `GET /health`, OAuth protected-resource metadata, an authenticated `initialize`, `tools/list`, and a read-only ACS tool before enabling mutations.

## Failure behavior

- No local bridge: Vercel request times out; the request deadline prevents later mutation execution.
- Queue redelivery: completed requests are replayed from SQLite without another ACS execution.
- Result publish failure: the request is retried, but the persisted result prevents duplicate execution.
- Expired OAuth JWT: Vercel rejects it; ACS independently rejects invalid/expired JWTs after local decryption.
- Invalid tunnel heartbeat: tunnel mode stops pulling new work until heartbeat succeeds.
- Vercel OIDC rejection: the cached queue token is invalidated and reminted.
