# ADR 0007: HTTPS streaming MCP transport for ChatGPT connector mode

## Status

Proposed

## Context

A local stdio MCP server is useful for local clients. A ChatGPT connector requires an internet-reachable HTTPS endpoint using the supported MCP transport mode. That introduces a new exposure boundary: the local control plane must be reachable without becoming open season on the user's machine.

## Decision

For ChatGPT connector mode, expose the MCP server through an HTTPS streaming HTTP/SSE-compatible endpoint, behind a tunnel or equivalent authenticated ingress.

The transport layer must provide:

- TLS
- Connector authentication
- Request size limits
- Rate limits
- Origin/client identity binding where available
- Health endpoint that does not leak secrets
- No unauthenticated mutation endpoints

The transport layer is not the primary security boundary. It is a locked door in front of the vault, not the vault.

## Consequences

- Local stdio mode and remote HTTPS mode may share tool implementations, but the HTTPS adapter must add authentication and request constraints.
- Connector identity should be attached to audit events.
- Tunnel configuration must be documented as deployment configuration, not hardcoded application behavior.
- Public exposure is blocked until authentication, policy, approval, audit, and command/path containment pass validation.

## Rejected alternatives

### Expose localhost directly with port forwarding

Rejected. It is brittle and usually under-secured.

### Skip authentication because policy exists

Rejected. Defense in depth is not decorative wallpaper.

### Build HTTPS-only first

Rejected for MVP. Local stdio/read-only mode is easier to validate before remote exposure.

## Open questions

- Final ChatGPT connector transport details and deployment shape.
- Whether to support Cloudflare Tunnel, ngrok, Tailscale Funnel, or a dedicated secure MCP tunnel first.
- Exact connector identity fields available to the local control plane.

## Implementation requirements before acceptance

- Document supported ingress mode.
- Add live smoke test against the HTTPS MCP endpoint.
- Bind connector identity into audit events.
- Prove unauthenticated mutation is impossible.
