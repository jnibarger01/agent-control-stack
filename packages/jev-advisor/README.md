# @agent-control-stack/jev-advisor

Advisory Jev classifier client (`jev-routing-v1`), shadow mode only.

**Advisory only, never authoritative.** Output of this package is plain
probability metadata. It MUST NOT influence policy decisions, approval,
routing authority, risk ranking, or any deterministic check. It is attached
to the log/telemetry path only, as non-authoritative `jevAdvisory` data.

## Usage

```ts
import { classifyJev, buildJevTelemetryEvent, formatJevTelemetry } from "@agent-control-stack/jev-advisor";

const result = await classifyJev(stateText, {
  needs_code: "Does fulfilling this request require writing or modifying code?",
  destructive: "Would fulfilling this request be destructive or irreversible?"
});
```

All questions are batched into ONE `POST` per `classifyJev` call. The adapter
**degrades, never fails**: on timeout, connection refusal, non-2xx, invalid
JSON, or a missing/malformed/out-of-range answer, it resolves with
`degraded: true`, empty `signals`, and `model: null`. It never throws to the
caller and never fabricates probabilities.

## Environment variables

| Variable             | Default                              | Meaning                                                                    |
| -------------------- | ------------------------------------ | -------------------------------------------------------------------------- |
| `ACS_JEV_ENABLED`    | unset (off)                          | Feature gate. Adapter is fully inert (no network call) unless exactly `1`. |
| `ACS_JEV_URL`        | `http://127.0.0.1:8017/v1/systemone` | Jev endpoint.                                                              |
| `ACS_JEV_TIMEOUT_MS` | `750`                                | Request timeout (AbortController).                                         |

## Default thresholds

Classification: `p >= high` → `"yes"`; `p <= low` → `"no"`; otherwise
`"unknown"`. Per-signal `[low, high]` defaults:

| Signal           | low  | high |
| ---------------- | ---- | ---- |
| actionable       | 0.15 | 0.85 |
| urgent           | 0.10 | 0.90 |
| needs_code       | 0.15 | 0.85 |
| needs_shell      | 0.10 | 0.90 |
| needs_browser    | 0.15 | 0.85 |
| needs_mobile     | 0.10 | 0.90 |
| needs_desktop    | 0.10 | 0.90 |
| duplicate_like   | 0.05 | 0.95 |
| destructive      | 0.03 | 0.97 |
| auth_sensitive   | 0.03 | 0.97 |
| runtime_mutation | 0.03 | 0.97 |
| approval_likely  | 0.03 | 0.97 |

Thresholds are overridable via `options.thresholds`; overrides must satisfy
`0 <= low < high <= 1` or the call throws (caller input misuse, not a Jev
failure).

## Signal probabilities

Every returned probability is the **probability assigned to the returned no
classification** for that signal. The Jev API's wire representation of that
value is an implementation detail and is not part of this contract; the
p-thresholds, classification, and the p <= 0.05 prefilter skip rule all
refer to this one unambiguous quantity.

## Prefilter semantics (continuous-improvement consumer contract)

Consumers MUST act on the explicit machine-readable `decision` field — never
on prose, thresholds, or telemetry fields. `deriveJevDecision(result)` (and
the `decision` field on CLI output) emits exactly one of:

- `"degraded"` — any Jev failure, disabled adapter, unavailability, timeout,
  or malformed response. Overrides ANY probability: never skip on degraded
  or missing data.
- `"duplicate_check_required"` — status ok AND `duplicate_like` classifies
  `"yes"`. The authoritative GitHub/open-PR duplicate check must run; the
  Jev result alone NEVER discards a candidate, and a failure of that
  follow-up check must also fail open into the existing agent path —
  `duplicate_like` must never become an indirect authority boundary. Takes
  precedence over `"skip"`: Jev must never discard something merely for
  looking duplicate-like without the authoritative repo-scoped duplicate
  check, so when BOTH `actionable` is `"no"` (p <= 0.05) AND
  `duplicate_like` is `"yes"`, the result is `"duplicate_check_required"`
  (never `"skip"`).
- `"skip"` — status ok AND `actionable` classifies `"no"` AND the
  probability assigned to the returned no classification is <= 0.05.
- `"continue"` — everything else (including a missing required signal).

Cron/CI prefilter consumers wired at the cron layer (not part of this
package) must treat `unknown`, timeout, malformed, degraded, disabled, and
CLI failure identically: NO skip, existing path unchanged, fail-open.

## Consumers and status

- **ACS advisory (mission intake)** — implemented, shadow mode only.
  Telemetry emitted at the gateway MCP `create_work_item` boundary.
- **Continuous-improvement prefilter** — contract documented above; wired
  separately at the cron layer, not implemented in this package.
- **Hermes / Telegram pre-routing** — NOT implemented, explicit follow-on.
  Mission Router is retired (see `docs/mission-router-phase0-inventory.md`);
  Hermes core is upstream-managed.

## Telemetry event shape

`buildJevTelemetryEvent` produces exactly:

```json
{
  "classifier": "jev-routing-v1",
  "consumer": "mission-router",
  "latency_ms": 84,
  "signals": { "needs_code": 0.96 },
  "route_before_jev": null,
  "route_selected": null,
  "actual_outcome": null
}
```

Degraded events add `"degraded": true` and carry an empty `signals` map.
Events contain probabilities only — state text and secrets are never included.
`formatJevTelemetry` renders the event as a JSON one-liner for the log path.

## Shadow wiring (implemented)

`packages/policy-gate/src/jev-shadow.ts` (`maybeRunJevShadowAdvisory`) emits
two batched calls (6 routing signals, then 4 risk signals) and writes
telemetry lines to stderr. It is wired fire-and-forget at the gateway MCP
`create_work_item` boundary in `apps/gateway/src/mcp.ts`. It is **not**
wired into `classifyMissionIntake`, policy evaluation, or any approval path,
and produces no authoritative fields. Planned (not implemented): consumption
of the advisory data by any decision path — none will be added without a
spec change.

## CLI

```
acs-jev classify --state-file <state.txt> \
  --signal actionable="Does this request require an action?" \
  --signal needs_code="Does this need code?" [--json] [--strict]
```

Prints the `JevResult` JSON. Exit code is 0 even when Jev fails (degraded
output); `--strict` exits 2 on degradation and exists for testing only.
