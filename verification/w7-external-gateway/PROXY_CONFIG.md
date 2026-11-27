# Proxy/harness configuration used

## 1) External gateway boundary harness (HTTPS reverse-proxy chain)

Used for `/jc/mcp` boundary auth verification over a reproducible external-like route:

Client (HTTPS, canonical origin) -> **External TLS reverse proxy (simulated termination, Node https)** -> **Public JC ingress** (`apps/dc-mcp-gateway/public-edge-proxy.js`, allowlist) -> **dc-mcp-gateway** (`apps/dc-mcp-gateway/server.js`, loopback) -> stub JC/DC/ACS upstreams.

- Canonical external origin: `https://127.0.0.1:<tlsPort>` (self-signed cert, generated per run)
- JC resource: `https://127.0.0.1:<tlsPort>/jc/mcp`
- TLS termination: Node `https.createServer` forwarding to ingress `127.0.0.1:<ingressPort>`
- Public ingress: `createPublicIngress({ upstreamPort: <gwPort>, jcResource })`
- Gateway: `PUBLIC_ORIGIN` set to canonical https origin, `DPOP_NONCE_REQUIRED=1`, `EDGE_TEST_MODE=1`

Harness: `verification/w7-external-gateway/external-gateway-harness.mjs`  
Evidence: `verification/w7-external-gateway/evidence/evidence.json`, `evidence/results.json`, `evidence/gateway.log`

## 2) Managed Jace Commander end-to-end harness (real components)

Used for managed auth path (capability issuance, live-authority checks, git ops) in isolated environment:

Real ACS gateway (`apps/gateway/src/server.ts` via vitest/tsx, real SQLite, `acs.jc.v1` signing, operator/bridge/authority credentials) + real OAuth/managed edge (`apps/dc-mcp-gateway/server.js`, `JC_ENABLED=1`, `ACS_MANAGED_MODE=1`) + real jc bridge (`apps/dc-mcp-gateway/bridge.js`, `BRIDGE_PROFILE=jace-commander`) + real `jace-commander serve` (`apps/jace-commander/dist/cli.js`, copied from protected `agent-control-stack` build for execution) + disposable git repo/bare remote. Tests executed: `tests/e2e/acs-jc-mcp/jc-operations.test.ts`, `tests/e2e/acs-jc-mcp/jc-native-authority.test.ts` with `ACS_DC_E2E=1`.

This harness is loopback/internal (no external DNS/cert/routing changes). It exercises authenticated/authorized managed flows, not an actual external staging network route.

## Intended production-shaped boundary (reference, not modified)

`ops/jc-hardening/README.md` and `ops/jc-hardening/acs-jc-public-ingress.service`: public proxy/Funnel -> `127.0.0.1:8011` ingress -> edge `127.0.0.1:8010`. No production routing/DNS/certificates/services/auth config changed.
