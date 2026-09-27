# Jev Advisor — Shadow-Mode Advisory Classification

Status: implemented (shadow mode only). Jev is a local yes/no probability
engine served at `http://127.0.0.1:8017/v1/systemone` (model `jev-latest`).
The adapter lives in `packages/jev-advisor` (`@agent-control-stack/jev-advisor`).

## Advisory only, never authoritative

Jev output is advisory metadata. It MUST NOT influence classifier evidence,
risk ranking, policy decisions, approvals, routing authority, or any
deterministic check. A differential test
(`packages/policy-gate/src/jev-shadow.test.ts`) proves
`classifyMissionIntake` evidence is identical with and without the advisor
enabled. The evidence schema carries no Jev fields.

## Implemented behavior

- Feature gate `ACS_JEV_ENABLED`: off (inert, no network call) unless `1`.
- `classifyJev(state, questions, options?)` batches ALL questions into one
  POST; endpoint `ACS_JEV_URL` (default above), timeout `ACS_JEV_TIMEOUT_MS`
  (default 750ms, AbortController).
- Degrade-never-fail: timeout, connection refusal, non-2xx, invalid JSON,
  or missing/malformed/out-of-range answers resolve with `degraded: true`,
  empty signals, `model: null` — never a rejection, never fabricated
  probabilities.
- Telemetry (`buildJevTelemetryEvent` / `formatJevTelemetry`):
  `{"classifier":"jev-routing-v1","consumer":"mission-router","latency_ms":84,"signals":{"needs_code":0.96},"route_before_jev":null,"route_selected":null,"actual_outcome":null}`
  (degraded events add `"degraded": true` and omit probabilities). No state
  text or secrets in events.
- Shadow wiring: `packages/policy-gate/src/jev-shadow.ts` emits TWO batched
  calls (6 routing signals, then 4 risk signals) as stderr telemetry lines,
  fired-and-forgotten at the gateway MCP `create_work_item` boundary
  (`apps/gateway/src/mcp.ts`) — only after the policy-gated tool call
  succeeds, so rejected intakes never reach the advisory engine. Not wired
  into `classifyMissionIntake`, policy, approval, or routing paths.
- CLI: `acs-jev classify --state-file <path> --signal name="..." ... [--json] [--strict]`
  prints the JevResult JSON plus an explicit machine-readable `decision`
  field (`"skip" | "continue" | "duplicate_check_required" | "degraded"`;
  see the consumer contract below) and exits 0 even on degradation
  (`--strict` exits 2, for tests only).

## Consumer contract and status

Consumers MUST act on the explicit machine-readable `decision` field emitted
by `deriveJevDecision` / the CLI — never on prose or telemetry fields:

- `"degraded"`: any Jev failure, disabled adapter, unavailability, timeout,
  or malformed response; overrides any probability (never skip on degraded
  data).
- `"duplicate_check_required"`: status ok AND `duplicate_like` classifies
  `"yes"`; the authoritative GitHub/open-PR duplicate check must run, the
  Jev result alone NEVER discards, and a failure of that follow-up check
  must also fail open into the existing agent path. Takes precedence over
  `"skip"` (Jev must never discard something merely for looking
  duplicate-like without the authoritative repo-scoped duplicate check).
- `"skip"`: status ok AND `actionable` classifies `"no"` AND the probability
  assigned to the returned no classification is <= 0.05.
- `"continue"`: everything else (including a missing required signal).

Cron/CI prefilter consumers (wired separately at the cron layer, not in this
repo path) treat unknown, timeout, malformed, degraded, disabled, and CLI
failure identically: NO skip, existing path unchanged, fail-open.

Status:

- ACS advisory (mission intake): implemented, shadow mode only.
- Continuous-improvement prefilter: contract documented; wired separately
  at the cron layer (not implemented here).
- Hermes / Telegram pre-routing: NOT implemented, explicit follow-on
  (Mission Router is retired per `docs/mission-router-phase0-inventory.md`;
  Hermes core is upstream-managed).

## Planned (not implemented)

- Any consumption of advisory probabilities by decision paths.
- Cross-batch result correlation or persistence of telemetry beyond stderr.

See `packages/jev-advisor/README.md` for the threshold table and API details.
Every probability in the contract is the probability assigned to the
returned no classification; the Jev wire representation is an internal
detail of the adapter and never appears in contract text or telemetry.
