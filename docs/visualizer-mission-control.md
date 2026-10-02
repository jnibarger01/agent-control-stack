# Visualizer integration for Mission Control

## Purpose

Mission Control can display the Agent Workflow Visualizer's canonical durable
execution graph without transferring policy, approval, lease, execution, result,
or audit authority away from ACS.

ACS remains the sole control-plane authority. Visualizer remains a read-only
projection and observability subsystem for ACS-originated work.

## Trust boundary

The supported data path is:

```text
Mission Control browser
  -> authenticated ACS GET
  -> ACS gateway
  -> same-UID IPv4 loopback GET
  -> Visualizer 127.0.0.1:4317
```

The browser never connects to Visualizer directly. ACS does not reverse proxy
Visualizer and does not forward browser headers. The gateway opens its own
loopback connection, which Visualizer authenticates through its existing Linux
same-UID TCP-peer boundary.

`ACS_VISUALIZER_URL` accepts only a credential-free
`http://127.0.0.1:<port>` origin. The documented production listener is:

```text
ACS_VISUALIZER_URL=http://127.0.0.1:4317
```

Strict ACS configuration rejects localhost aliases, non-loopback addresses,
HTTPS, paths, query strings, fragments, and embedded credentials.

## Read surfaces

### GET /api/visualizer/status

This is the lightweight operational channel used by Overview and the Visualizer
page. ACS reads only Visualizer `GET /api/v1/system-status` and returns a
narrow DTO containing:

- configured/reachable state;
- healthy, degraded, unhealthy, unavailable, or not-configured state;
- database availability;
- active and queued execution counts;
- pending approval count;
- event-stream client count;
- canonical per-runtime health.

The upstream status read has a ten-second timeout to accommodate Visualizer's
live six-runtime health refresh. Graph reads retain their two-second timeout.

The endpoint is authenticated, rate limited, `Cache-Control: no-store`, and
has no mutation counterpart. ACS independently validates the six canonical
runtime entries, durable-summary/database consistency, and the claimed overall
health state before exposing it to the browser.

### GET /api/visualizer/projection

This is the bounded graph channel used only when the Visualizer view is open.
ACS selects at most the newest 20 work items and performs at most four concurrent
loopback graph reads, each with a two-second timeout.

ACS joins work items to Visualizer through the deterministic identity contract:

```text
stableCanonicalId("acs:execution:" + workItemId)
```

Both repositories pin the same fixture in tests.

ACS keeps only its own redacted work-item display context. Canonical execution
status, runtime attribution, graph revision, nodes, and edges come from
Visualizer. Unknown upstream graph fields are stripped at the ACS boundary and
display text is redacted again with `@agent-control-stack/shared`.

A missing graph is `not_projected`, not an inferred failure. It can mean the
bridge is still synchronizing or runtime attribution is intentionally
unsupported. Transport or validation failure is reported separately as
`unavailable`.

## Mission Control behavior

Overview displays Visualizer health without using the graph fan-out endpoint.

The Visualizer view displays:

- current integration health;
- canonical, active, not-projected, and unavailable counts;
- runtime, projection-state, and text filters;
- branch-safe graph rows based on actual incoming canonical edges;
- graph revision and durable event position.

ACS SSE lifecycle events invalidate the graph cache. The existing Mission Control
30-second reconciliation timer refreshes Visualizer health and, while the
Visualizer page is open, its canonical projection.

No Visualizer UI element can approve, reject, start, retry, cancel, restart, or
otherwise mutate ACS or Visualizer.

## Current verification state

The source implementation and focused regression tests are present.

Command-level verification is still blocked by the managed Desktop Commander
contract mismatch: ACS requires `start_process.cwd`, while the exposed remote
Desktop Commander tool schema does not provide `cwd`. Existing compiled
`dist` artifacts therefore remain stale and no service has been rebuilt or
restarted as part of this work.

Do not describe Phase 3 or Phase 4 as deployed until typecheck/tests/build and a
same-UID loopback smoke test have actually passed.
