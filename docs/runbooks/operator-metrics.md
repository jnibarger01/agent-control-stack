# Operator metrics (leases, approvals, 429s)

Gateway metrics already exist in process memory and are exposed on an
authenticated Prometheus-compatible scrape endpoint. This runbook lists the
current names and how to scrape them locally. Mission Control also shows a
derived **Operator metrics** panel (lease age, approval wait) from live store
state; rate-limit / 429 counters come from `/metrics`.

## Local scrape

With the gateway on loopback (see [local-dev.md](./local-dev.md)):

```sh
# Session cookie (dashboard login) or bearer credential with acs:read
curl -fsS -H "Authorization: Bearer $ACS_GATEWAY_TOKEN" \
  http://127.0.0.1:3000/metrics
```

Notes:

- `GET /metrics` requires read auth (`requireRead`), same as the dashboard.
- Response `Content-Type` is `text/plain; version=0.0.4` (Prometheus text).
- Counters are process-local: they reset on gateway restart. There is no remote
  metrics backend in-repo; scrape from your host or sidecar.
- Health/read routes are not rate-limited; see
  [gateway-abuse-controls.md](./gateway-abuse-controls.md).

## Metric inventory

| Name                                      | Type    | Labels                      | Meaning                                                                                         |
| ----------------------------------------- | ------- | --------------------------- | ----------------------------------------------------------------------------------------------- |
| `acs_sqlite_ready`                        | gauge   | —                           | `1` when the latest SQLite health check passed, else `0` (refreshed on each `/metrics` scrape). |
| `acs_http_requests_total`                 | counter | `method`, `route`, `status` | Completed HTTP requests, including `status="429"`.                                              |
| `acs_http_request_duration_seconds_count` | counter | `method`, `route`           | Request count for latency sum pairing.                                                          |
| `acs_http_request_duration_seconds_sum`   | counter | `method`, `route`           | Cumulative request duration in seconds.                                                         |
| `acs_rate_limit_rejected_total`           | counter | `method`, `route`           | In-process limiter rejections (**HTTP 429** / MCP `-32029`). From abuse controls (#88).         |
| `acs_audit_events_total`                  | counter | `event_name`                | Appended audit events (work-item, approval, lease, agent lifecycle, etc.).                      |
| `acs_sse_clients_dropped_total`           | counter | `reason`                    | Live event clients dropped (e.g. `backpressure`).                                               |
| `acs_sse_connections_rejected_total`      | counter | `reason`                    | New SSE subscriptions refused (`global`, `per_principal`).                                      |

### Leases and approvals via audit counters

There are no dedicated Prometheus gauges for lease age or approval wait yet.
Use:

- **Leases** — `acs_audit_events_total{event_name="attempt_lease.renewed"}`,
  `attempt_lease.expired`, `attempt_lease.stolen`, plus Mission Control’s
  Operator metrics panel (active lease count / oldest age from store leases).
- **Approvals** — `acs_audit_events_total{event_name="work_item.needs_approval"}`,
  `approval.granted`, `approval.consumed`, plus the panel’s pending count /
  oldest wait (`needs_approval` work-item age).
- **429s** — `acs_rate_limit_rejected_total` and
  `acs_http_requests_total{...,status="429"}`.

## Useful local greps

```sh
curl -fsS -H "Authorization: Bearer $ACS_GATEWAY_TOKEN" \
  http://127.0.0.1:3000/metrics | grep -E 'acs_rate_limit_rejected_total|status="429"'

curl -fsS -H "Authorization: Bearer $ACS_GATEWAY_TOKEN" \
  http://127.0.0.1:3000/metrics | grep 'acs_audit_events_total{event_name="approval'
```

## Related

- Mission Control dashboard (`GET /`) — Operator metrics panel
- [gateway-abuse-controls.md](./gateway-abuse-controls.md) — rate-limit knobs
- [production.md](./production.md) — production scrape / alert expectations
- Implementation: `apps/gateway/src/metrics.ts`, scrape route in
  `apps/gateway/src/server.ts`
