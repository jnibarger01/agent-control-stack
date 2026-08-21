# OpenClaw Agent Orchestrator migration reference

Status: **reference-only migration inventory**

Source repository: `jnibarger01/openclaw-agent-orchestrator`

Source commit reviewed: `450b883650b11a3abe7afc80afe43a97d8bfc745` (`feat: harden orchestrator control plane`)

## Decision

Do not merge the old repository into ACS as a second control plane. ACS remains the sole authority for policy, approvals, work-item lifecycle, leases, result acceptance, retry/clone lineage, actor/agent registry state, and canonical audit.

The old repository is valuable as a source of execution-adapter hardening patterns, orchestration experiments, diagnostics ideas, and UI concepts. Those ideas should be reimplemented against ACS-owned contracts rather than copied with their independent stores and lifecycle.

## Target ownership

```text
Helix / ACS control UI
        |
        v
      ACS
  policy / approvals
  work items / attempts
  leases / audit
  routing / registry
        |
        v
 execution adapters
 ACP / ACPX / provider adapters
        |
        +--> OpenClaw
        +--> Hermes
        +--> Codex
        +--> Claude
        +--> Gemini
        +--> OpenCode / Pi
```

OpenClaw, Hermes, Codex, Claude, Gemini, OpenCode, Pi, ACP and ACPX are execution/model/protocol boundaries. They are not alternate policy or lifecycle authorities.

## Preserve and adapt

### 1. ACPX process-launch hardening

Primary source:

- `api/acpx-mcp/runner.ts`
- `api/acpx-mcp/runner.test.ts`

Useful properties to preserve when ACS adds an ACPX execution adapter:

- use `execFile`/`spawn` with `shell: false`; never interpolate a shell command;
- resolve and realpath both the configured root and requested working directory;
- reject a working directory that escapes the configured project/root boundary, including symlink escapes;
- use an explicit child-environment allowlist rather than inheriting arbitrary provider and credential variables;
- impose a bounded timeout with an absolute maximum;
- impose stdout/stderr output caps;
- redact secrets before returning or persisting output;
- parse structured ACPX/agent output separately from raw stdout;
- make allowed runtime/agent labels explicit;
- default non-interactive permission handling to deny;
- keep read approval distinct from mutation authority.

ACS already has overlapping protections in `packages/acp-adapter` and `packages/sandbox`. Reuse the old runner only as a test and implementation reference. Do not create a parallel launcher that bypasses ACS work items, policy, attempt identity, sandbox selection, or result acceptance.

### 2. Agent-scoped capability boundaries

Primary sources:

- `api/orchestrator/index.ts`
- `api/orchestrator/tool-manifest.ts`
- associated tests

Useful concepts:

- an agent should receive an explicit set of reachable servers/adapters;
- an agent should receive an explicit set of tool capabilities;
- tool aliases can map provider/runtime names to canonical ACS capability names;
- denied tool calls should produce structured audit evidence;
- effective access should be inspectable before execution.

ACS adaptation:

- express these as actor/agent registry capabilities plus policy-gate decisions;
- use ACS canonical action/tool identifiers rather than a second manifest authority;
- surface effective access in Helix/control UI from ACS registry + policy projections.

### 3. Orchestration patterns

Primary sources:

- `api/orchestrator/default-orchestrator.ts`
- `api/orchestrator/index.ts`

The old project demonstrates:

- sequential routing;
- concurrent/fan-out routing;
- approval-gated/governed routing;
- bounded handoff with loop detection;
- aggregation/synthesis after multiple agent outputs.

Important limitation: the default `architect`, `implementer`, `validator`, and `synthesizer` flows are demo/in-memory implementations with deterministic MCP tools. They are reference examples, not production OpenClaw crew routing.

ACS adaptation:

- compare the patterns with `packages/moa-orchestrator` and `docs/orchestration-patterns.md`;
- preserve bounded handoff/loop-detection tests where ACS lacks equivalent coverage;
- keep orchestration subordinate to ACS policy and work-item/attempt lifecycle;
- never let orchestration code self-approve a mutating action.

### 4. Health and operator preflight ideas

Primary sources:

- `api/tool-registry.ts`
- `api/tools/health-deep.ts`
- `api/tools/secret-preflight.ts`
- `api/tools/repo-hygiene.ts`
- service/tunnel status tools under `api/acpx-mcp/tools/`

Useful operator checks:

- gateway/runtime readiness;
- worker readiness;
- policy/audit health;
- local service status;
- tunnel health;
- provider secret *presence* without returning values;
- repository hygiene checks for generated junk;
- git/repository status before mutation.

ACS adaptation:

- implement these as read-only ACS diagnostics;
- expose through the ACS gateway/MCP/control UI as appropriate;
- never let a diagnostic tool become an alternate mutation path;
- preserve secret redaction and presence-only semantics.

### 5. Dashboard concepts

Primary source:

- `src/pages/Orchestrator.tsx`

Potential UX references:

- tool registry with risk/exposure metadata;
- policy simulation before execution;
- environment/readiness probes;
- pending/approved/used/denied/expired approval states;
- live worker and audit updates;
- queue/dead-letter inspection;
- audit-chain verification;
- provider preflight;
- repo hygiene results.

Target: Helix/ACS UI. Do not keep a separate OpenClaw orchestrator dashboard as an independent product surface.

## Reference-only: do not migrate as runtime authority

The following old components overlap directly with ACS and should not be copied as independent implementations:

| Old component | Why not migrate | ACS authority |
| --- | --- | --- |
| `api/approval-store.ts` | creates a second approval source of truth | `packages/work-items` + policy-gate approval records |
| `api/policy-engine.ts` | creates a second policy authority | `packages/policy-gate` |
| `api/request-hash.ts` | risks divergent canonicalization/fingerprints | ACS shared hashing + work-item action hashes |
| `api/audit-log.ts` | creates a second canonical audit chain | SQLite `audit_events` and ADR 0011 |
| `api/worker-leases.ts` | creates a second queue/lease lifecycle in JSONL | ACS work items, attempts and leases |
| `api/tool-registry.ts` as authority | duplicates policy/exposure metadata | ACS registry + policy contracts |
| orchestrator demo registry | hardcoded demo agents are not runtime truth | ACS actor/agent registry |
| React control-plane dashboard | duplicates Helix/ACS UI | Helix / ACS control UI |

The old JSONL worker store is useful for behavior tests (idempotency, claim ownership, heartbeat, expiry, retry/dead-letter semantics), but its persistence model must not survive migration.

## Test cases worth carrying forward

When equivalent ACS tests do not already exist, preserve these behavioral cases:

### Execution adapter

- rejects cwd traversal outside configured root;
- rejects symlink escape after realpath resolution;
- uses no shell interpolation;
- child environment excludes unapproved secrets;
- timeout is bounded and enforced;
- oversized output is truncated/capped;
- stdout/stderr are redacted before persistence/return;
- unknown runtime/agent label is denied;
- non-interactive mutation permission is denied by default.

### Capability/policy boundary

- agent cannot access a server outside its capability set;
- agent cannot call a tool outside its grant;
- policy denial is fail-closed;
- denied calls emit audit evidence;
- approval applies only to the exact canonical action;
- consumed/expired approval cannot be replayed.

### Work execution semantics

Use only as parity checks against ACS-owned lifecycle:

- duplicate enqueue/request idempotency;
- lease ownership required for heartbeat/result submission;
- expired lease is recoverable according to ACS attempt policy;
- retries create fresh attempt/work identities rather than mutating history;
- dead-letter/terminal failure remains inspectable;
- audit-chain tampering is detected.

### Orchestration

- sequential route preserves order;
- concurrent route preserves per-agent results and failure attribution;
- governed route stops before execution without required approval;
- handoff loop is detected;
- maximum handoff count is enforced;
- synthesizer cannot erase failed/unresolved branches without explicit status.

## Migration priority

1. **P0 reference capture:** this document; retain source commit SHA before archive.
2. **P1 ACPX adapter gap analysis:** compare `api/acpx-mcp/runner.ts` against `packages/acp-adapter` and `packages/sandbox`; port only missing safety tests/controls.
3. **P1 diagnostics:** add the useful read-only health/preflight checks to ACS-native surfaces.
4. **P2 capability projection:** expose effective actor/agent capabilities and policy decisions to Helix.
5. **P2 orchestration parity:** import only missing bounded handoff/concurrency tests into ACS orchestration packages.

## Archive criteria for the source repository

The source repository can be archived once this reference is merged because:

- its durable control-plane responsibilities are already owned by ACS;
- its UI responsibility belongs to Helix/ACS control UI;
- the reviewed source commit is recorded here permanently;
- useful implementation and test ideas are enumerated here with source paths;
- future extraction can reference commit `450b883650b11a3abe7afc80afe43a97d8bfc745` without reactivating the repository.

Archiving should preserve the repository read-only; do not delete it.
