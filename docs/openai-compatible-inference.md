# OpenAI-compatible inference proxy

## Purpose

ACS can optionally expose an OpenAI Responses-compatible inference endpoint on the existing gateway. This lets a client such as Codex send model traffic to ACS first while ACS performs client authentication, model-admission policy, request correlation, audit metadata capture, and gateway telemetry before forwarding the request to OpenAI.

```text
Codex / OpenAI-compatible client
  |
  | Responses API + ACS gateway bearer
  v
ACS gateway :3000
  |
  | auth + model allowlist + audit + metrics
  v
https://api.openai.com/v1
```

The client base URL is:

```text
http://127.0.0.1:3000/v1
```

The implemented inference surface is intentionally narrow:

- `POST /v1/responses`
- `GET /v1/models`

It is not a claim of complete OpenAI REST API compatibility.

## Enable locally

The feature is disabled by default. Configure the existing ACS gateway credential separately from the upstream OpenAI credential:

```sh
ACS_GATEWAY_TOKEN=<local-client-token>
ACS_OPENAI_API_KEY=<upstream-openai-key>
ACS_INFERENCE_ENABLED=true
ACS_INFERENCE_ALLOWED_MODELS=<model-a>,<model-b>
ACS_INFERENCE_AUDIT_LOG=storage/inference-audit.jsonl
ACS_INFERENCE_MAX_BODY_BYTES=16777216
```

`ACS_INFERENCE_ALLOWED_MODELS` is mandatory when the proxy is enabled. `*` explicitly allows any requested model and should be used only when that is the intended policy.

The upstream base URL is fixed to `https://api.openai.com/v1` in this version. This prevents an environment-supplied upstream from accidentally pointing back at ACS or turning the gateway into an arbitrary HTTP proxy.

## Authentication and credential boundary

Clients authenticate to ACS using the existing gateway authentication path. ACS does not forward the incoming `Authorization` header upstream. It replaces it with the ACS-held OpenAI API credential.

Only a small response/request header allowlist crosses the boundary. Cookies, arbitrary client headers, ACS bearer credentials, and other gateway secrets are not forwarded.

## Policy and approval boundary

Inference admission policy currently consists of:

1. valid ACS gateway authentication;
2. an explicit allowed model;
3. a non-recursive proxy hop;
4. boundary validation of the Responses API envelope.

A model request is not treated as a privileged machine mutation and therefore does not create a human-approval work item by itself. Existing ACS approval rules remain authoritative for filesystem, process, service, credential, or other privileged actions only when those actions actually route through ACS.

Pointing Codex model traffic at this endpoint does **not** by itself intercept or govern Codex's local shell or filesystem operations.

## Audit and telemetry

Each inference request receives an ACS-generated `x-acs-request-id`. The inference audit stream records only security and routing metadata such as actor, model, decision, status, duration, and upstream request ID.

Prompts, tool arguments, model output, API keys, bearer tokens, and cookies are intentionally excluded from inference audit events. The inference log is a separate hash-chained JSONL file; it is not a replacement for the canonical work-item/attempt audit authority used by ACS execution lifecycle enforcement.

The gateway's existing Fastify request metrics also cover these routes, providing route/status/latency telemetry without duplicating the metrics subsystem.

## Streaming

For Responses API streaming requests, ACS forwards the upstream body as a byte stream and preserves `text/event-stream` content type plus a small set of OpenAI request/rate-limit response headers.

## Recursion protection

ACS adds `x-acs-inference-hop: 1` to upstream requests. Any inbound inference request already carrying that header is rejected before network egress. This protects against accidental ACS -> ACS inference loops.

## Current integration limitation

The inference routes are registered by the existing MoA gateway registration path. A caller that builds the gateway with `moa: false` also disables this inference surface. Separating those plugin registrations is deferred rather than expanding this first compatibility change into a larger gateway refactor.
