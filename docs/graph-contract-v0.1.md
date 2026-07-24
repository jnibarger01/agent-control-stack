# ACS Graph Contract v0.1

Status: frozen implementation contract for the static executor foundation.

Normative machine-readable schema: [`../schemas/graph-v0.1.schema.json`](../schemas/graph-v0.1.schema.json).
The runtime boundary is `packages/graph/src/contract.ts`; a test requires the committed JSON Schema artifact to equal the schema generated from that boundary.
The artifact captures the structural Zod shape. Runtime admission additionally
enforces credential-free refinements, bounded JSON payloads, topology, resource
policy, and the supported JSON-Schema subset; the artifact is not a replacement
for `validateGraph`.

## Authority split

| Component    | Authority in v0.1                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| ACS          | Graph admission, validation, scheduling, limits, resource conflicts, state transitions, verdicts, and the durable ledger.               |
| Hermes       | Deferred adapter for bounded model-driven nodes. Hermes will receive a complete node contract and will not own graph state or topology. |
| Fake adapter | The only executable adapter in v0.1; deterministic, declarative, and side-effect free.                                                  |
| AgentMemory  | Historical context only; never execution state or authority.                                                                            |
| OpenClaw     | Excluded.                                                                                                                               |

Hermes core is not modified by this work.

## v0.1 boundary

Included:

- static directed acyclic graphs;
- strict Zod and generated JSON Schema validation;
- typed input and output ports;
- required and optional nodes and dependency edges;
- deterministic dependency scheduling and bounded concurrency;
- conservative resource-conflict serialization;
- SQLite run, node, attempt, and append-only transition records;
- hash-chained transition integrity checks;
- interruption recovery for side-effect-free attempts;
- fail-closed handling for malformed adapter output;
- strict verdict aggregation;
- an inert fake adapter for deterministic tests.

Excluded:

- model-generated or self-modifying graphs;
- cycles and open-ended loops;
- a live Hermes adapter;
- live shell or filesystem mutation;
- automatic retries for write or external nodes;
- remote deployment, push, merge, or external messaging;
- distributed workers;
- UI or visual graph editing;
- OpenClaw integration;
- AgentMemory-backed execution state;
- automatic model routing or majority-vote verification.

## Graph identity and authority envelope

Every graph must first satisfy this public envelope:

```json
{
  "graph_id": "graph_repository_tests",
  "version": "0.1",
  "requested_by": { "actor_id": "hermes-main", "actor_type": "agent" },
  "intent": "Run repository tests",
  "nodes": [],
  "risk": "low",
  "idempotency_key": "submission-repository-tests-1",
  "correlation_id": "corr-repository-tests-1"
}
```

`graph_id`, `version`, `requested_by`, `intent`, `risk`, `idempotency_key`, and `correlation_id` are mandatory admission fields. `graph_id` must use the `graph_` namespace. `requested_by` is descriptive identity, not execution authority: Graph v0.1 still admits only the built-in fake adapter and never grants a worker a privileged capability.

The detailed static-DAG fields (`schemaVersion`, `graphId`, `objective`, `edges`, `limits`, and `verdictPolicy`) are accepted as the normalized implementation representation. `schemaVersion`, `graphId`, and `objective` are derived from the public envelope when omitted; conflicting explicit aliases are rejected. The detailed `timeoutMs`/`retry` aliases must also agree with their required `timeout`/`retry_policy` fields; an alias cannot widen an admitted bound. ACS normalizes the graph before computing its SHA-256 `graphHash`. The hash binds the redacted durable graph projection, so a stored graph whose content no longer matches its admitted hash cannot resume. A deduplicated nonterminal submission resumes the already admitted durable graph projection; a new raw payload cannot replace it.

## Nodes

Each node defines one bounded job. The public node contract requires or resolves:

- stable `id` and `function_id`;
- `dependencies` as stable node IDs;
- typed `input_schema` and expected `output_schema`;
- `timeout`;
- `retry_policy.max_attempts` and `retry_policy.backoff_ms`;
- `risk` and boolean `approval_required`;
- a node `idempotency_key`.

The normalized implementation also retains:

- `description` and `adapter`;
- `required`: whether the node contributes to required coverage and the final verdict;
- `inputs` and `outputs`: named typed ports;
- `parameters`: node-local JSON data;
- `evidenceRequirements`: evidence kinds required for success;
- `resources`: declared resource scopes;
- `timeoutMs` and `retry.maxAttempts`;
- `budget.maxTokens`, `budget.maxCostUsd`, and `budget.apiSlots`;
- `sideEffect`: `NONE`, `READ_ONLY`, `WRITE`, or `EXTERNAL`;
- `approval`: `NONE` or `HUMAN`.

Authority identifiers, run and scheduler-owner identifiers, idempotency/correlation keys, evidence kinds, resource
identifiers, schema property names, schema `$id`/`$schema` references, and
schema patterns must not contain credential-like material. ACS rejects those
structural values at admission because replacing them after admission would
change identity or validation semantics.

A successful adapter result must provide every declared output port, no undeclared output ports, and every required evidence kind. Schema-valid but contract-incomplete results fail the node.

When a node has no dependencies, `input_schema` validates its optional node `input` value (or the empty assembled input map when `input` is omitted). The scheduler passes that root value separately as `NodeAdapterContext.input`, including scalar and array values, and binds it into the admitted input hash. For dependency-driven nodes, `input_schema` validates the deterministic assembled input-port map; node-local `parameters` remain separately available to the adapter and are included in the admitted input hash.

### Node states

```text
PENDING
READY
RUNNING
SUCCEEDED
FAILED
BLOCKED
SKIPPED
CANCELLED
```

Normal v0.1 flow is:

```text
PENDING -> READY -> RUNNING -> READY (bounded retry) -> SUCCEEDED | FAILED | BLOCKED | CANCELLED
```

A pending node may become `BLOCKED` when a required dependency fails or when `approval_required` is true. Approval-required nodes are represented and recorded but never invoked because v0.1 has no approval execution path. A retryable failed attempt transitions its node to `READY` only while `attempt_number < retry_policy.max_attempts`; non-retryable and exhausted failures are terminal. On restart, an interrupted `NONE` or `READ_ONLY` attempt may transition `RUNNING -> READY` when retry budget remains. `WRITE` and `EXTERNAL` nodes are rejected at admission in v0.1, so write-capable interruption reconciliation is defensive ledger behavior rather than an admitted runtime path.

`SKIPPED` is reserved in the state vocabulary but the static v0.1 scheduler does not currently emit it.
`CANCELLED` is used only for an interrupted side-effect-free node attempt; the public run state machine has no
cancellation path in v0.1, so cancellation cannot bypass attempt cleanup or budget settlement.

## Edges and typed data

An edge contains:

- stable `id`;
- source node and output port;
- target node and input port;
- `required`: whether source non-success blocks the target.

Port type identifiers must match exactly. `ONE` input ports accept one incoming edge; `MANY` ports support deterministic fan-in. Every required input port must have at least one edge before execution begins.

Edges represent data dependencies, not chronology. The scheduler starts a node only after all incoming dependencies are terminal. Values from successful sources are assembled in graph-edge order, preserving deterministic fan-in even when workers finish in a different order.

The v0.1 runtime validator enforces the supported JSON-Schema subset: `type`, `const`, `enum`, `required`, `properties`, boolean or schema-valued `additionalProperties`, `items`, `allOf`, `anyOf`, `oneOf`, `not`, array and object size bounds, string length and `pattern`, and numeric bounds. Annotation keywords such as `title` and `description` are accepted; unsupported validation keywords are rejected at graph admission rather than silently ignored.

## Evidence and adapter result

Every adapter result is strict and contains all fields:

```yaml
status: SUCCEEDED | FAILED | BLOCKED
output: {}
evidence:
  - kind: fixture
    uri: fixture://example
    sha256: <64 lowercase hexadecimal characters>
assumptions: []
confidence: 0.0
unresolved: []
retryable: false
usage:
  inputTokens: 0
  outputTokens: 0
  costUsd: 0
  durationMs: 0
```

Confidence is evidence, not authority. It is never averaged into PASS.

Each attempt stores its node ID, attempt number, input hash, output hash, structured result or failure, timestamps, and terminal state. A contract-valid non-success result is stored as `FAILED` or `BLOCKED` with its structured result and output hash. A `null` result means no contract-valid result was accepted and is accompanied by a structured failure record.

### Fake adapter boundary

`FakeNodeAdapter` accepts only structured-cloneable declarative data. It can deterministically return success or failure, delay until the scheduler timeout, emit a retryable failure sequence, and return the same result for a duplicate delivery. It exposes per-node invocation counts and observed concurrency. It never spawns a process, opens a socket, reads a file, writes a file, or calls a remote service. The scheduler snapshots the adapter registry and binds the validated fake method before execution; later caller mutation of the registry or method cannot replace the admitted dispatch target. The scheduler admits no other adapter implementation in v0.1.

## Resources

Nodes declare:

- filesystem scopes with `READ` or `WRITE` access;
- Git worktrees;
- ports;
- browser profiles;
- services;
- external targets.

Two ready nodes may run concurrently when both only read the same filesystem scope. Matching exclusive resource identifiers conflict. Filesystem scopes use conservative hierarchy comparison; for example `repo://acs/**` overlaps `repo://acs/src/**`, but all admitted v0.1 scopes are read-only.

The fake adapter is explicitly inert. v0.1 rejects every `WRITE` or `EXTERNAL` node and every write-access filesystem resource at graph admission, before run creation or adapter execution.

## Side effects, approval, and retry

`WRITE` and `EXTERNAL` nodes are categorically disabled in v0.1 even if they declare `HUMAN` approval, one attempt, and matching resources. A read-only node with `approval_required: true` is admitted for policy/scheduler testing but is durably `BLOCKED` before adapter invocation. The ledger also rejects direct `PENDING -> READY` mutations unless dependencies, required inputs, and approval policy are satisfied; `RUNNING` requires the atomic attempt-reservation path. No live side-effect adapter exists in this slice. A future controlled-write phase must define and test request-specific approval binding before changing this admission rule.

## Limits

Every normalized graph declares:

- `maxWorkers`;
- `maxDepth`;
- `wallClockMs`;
- `tokenCeiling`;
- `dollarCeilingUsd`;
- `apiConcurrency`.

The public detailed limits are optional aliases in the v0.1 input. When omitted,
ACS applies bounded defaults (`maxWorkers: 1`, `maxDepth: 128`,
`wallClockMs: 86400000`, zero token and dollar ceilings, and
`apiConcurrency: 1`) before hashing and admission.

The current static foundation enforces graph depth, worker concurrency, node timeouts, graph wall-clock checks, retry bounds, resource conflicts, and atomic token, dollar, and API-slot reservation. Starting an attempt reserves its declared maximums in the same SQLite transaction as the attempt and node-state mutation. A result within its admitted reservation atomically settles usage; an over-budget report fails closed without an accepted result, releases its reservation, and cannot move run usage beyond either graph ceiling. Interruption reconciliation also releases reservations. The fake adapter normally reports zero provider usage and performs no API calls, while tests exercise reservation and settlement boundaries directly.

## Acceptance tests and verdicts

Acceptance tests name the node results required to satisfy a graph-level criterion. Required acceptance tests cannot pass unless every referenced node succeeds.

Aggregation order is strict:

1. Any required node `BLOCKED` -> `BLOCK`.
2. Any required node `FAILED` -> `FAIL` or `PARTIAL`, according to `verdictPolicy.requiredFailure`.
3. Any incomplete required node, required coverage below threshold, or failed required acceptance test -> `PARTIAL`.
4. Optional node failure -> `PARTIAL` only when configured; otherwise it remains visible without changing PASS.
5. Only complete required coverage with all required acceptance tests satisfied can produce `PASS`.

Run state and objective verdict remain separate records. The current mapping is:

- `PASS` -> run `SUCCEEDED`;
- `BLOCK` -> run `BLOCKED`;
- `FAIL` or `PARTIAL` -> run `FAILED`.

A verifier is authoritative only because graph policy marks it required or places it in a required acceptance test. Maker confidence cannot bypass it.

## SQLite durability and recovery

The ledger stores:

- admitted graph definition and hash;
- requester identity, intent, risk, idempotency key, and correlation ID;
- current run and node states;
- every node attempt;
- input/output hashes and structured evidence;
- every run and node transition;
- final verdict and aggregation summary.

Untrusted graph data, adapter results, structured errors, transition reasons, and verdict summaries are passed through the repository redaction helper before SQLite persistence. Graph v0.1 additionally redacts credential-bearing URI query and fragment parameters, including percent-encoded forms, in arbitrary JSON payload strings. Output hashes and the admitted graph hash bind the redacted durable projection. Resume-time schema checks allow the explicit `[redacted]` marker only while validating that persisted projection; new submissions still validate their original values normally. Raw secret values are therefore not returned by ledger reads or retained in the Graph ledger.

Data-bearing schema values and annotations, request payloads, parameters, and
result payloads may be redacted into the durable projection. Redacted values do
not participate in `oneOf`/`not` decisions during resume validation because
their original content is intentionally unavailable; structural object, array,
required-field, and type checks still apply. Credential-like structural
identifiers are rejected instead of being rewritten.

Each submission also records an idempotency decision (`ADMITTED`, `DEDUPLICATED`, or `REJECTED_CONFLICT`). Reusing an idempotency key with the same graph returns the original run without invoking another node when it is terminal. A nonterminal duplicate resumes the original admitted durable graph, never the replacement raw payload. Reusing it with a different graph is rejected.

Transitions are inserted in the same SQLite transaction as their corresponding state mutation and form a SHA-256 chain. A broken transition chain blocks new starts and resumes.

Every run-scoped mutation after admission carries a scheduler lease token containing the run ID, owner ID, and lease epoch. The ledger verifies that token and lease expiry inside the same `BEGIN IMMEDIATE` SQLite transaction before changing run state, node state, attempts, results, reservations, usage, verdicts, or interruption reconciliation. Lease release is also epoch- and expiry-fenced. Recovery increments the epoch, so late results from an earlier owner cannot persist output or settle its reservation.

On resume:

1. verify the transition chain;
2. revalidate the stored graph against current policy;
3. verify the admitted graph hash;
4. reconstruct every admitted attempt input and verify its persisted input hash;
5. verify every persisted successful node and attempt result shape and output hash;
6. return a terminal summary only after those integrity checks pass;
7. acquire or recover scheduler ownership for a nonterminal run;
8. reconcile interrupted attempts, requeuing only side-effect-free work and releasing its reservation;
9. continue unresolved dependencies without rerunning completed nodes.

The transition chain, server-derived admitted-input hashes, and result-output hashes are tamper-evident within their documented fields. Structured result fields other than `output` do not have a separate result hash in v0.1. This is not a claim that arbitrary SQLite rows are immutable, that the database is tamper-proof, or that the ledger is a complete event store. Direct database modification outside the documented transition, admitted-input, and result-output checks is outside the v0.1 guarantee.

## Admission failures

No node executes when validation finds any of the following:

- malformed or unknown schema version;
- malformed requester identity, risk, approval, timeout, retry, or idempotency fields;
- duplicate node, edge, port, or acceptance-test identifier;
- duplicate, missing, or self-dependency;
- unknown node or port reference;
- mismatched port types or input cardinality;
- missing required input edge;
- cycle;
- graph depth beyond policy;
- unsupported adapter;
- unsafe write/external declaration;
- unknown acceptance-test node;
- invalid supported input or output JSON-Schema contract.

## Initial acceptance matrix

| Case                                       | Required result                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Valid diamond                              | Fan-out runs concurrently and fan-in executes once after both dependencies.              |
| Missing required dependency                | Rejected before run creation or adapter execution.                                       |
| Required node failure                      | Required downstream nodes become visibly `BLOCKED`.                                      |
| Optional node failure                      | Independent and optional-edge downstream work continues; degradation remains visible.    |
| Process interruption                       | Completed nodes remain complete; only eligible side-effect-free attempts resume.         |
| Overlapping read scopes                    | Ready nodes may run concurrently under the enforced read-only policy.                    |
| Malformed worker output                    | Attempt and node fail closed with no accepted result.                                    |
| Incomplete required coverage               | Verdict cannot be PASS.                                                                  |
| Transition tampering                       | Integrity verification fails closed.                                                     |
| Terminal output or attempt-input tampering | Resume fails before summary return, execution, or mutation.                              |
| Concurrent budget reservations             | Atomic admission prevents oversubscription.                                              |
| Over-budget adapter usage                  | The attempt fails closed, its reservation is released, and graph ceilings remain intact. |
| Retryable failure                          | A retryable fake failure requeues only within the declared attempt bound.                |
| Approval-required node                     | The node is durably blocked and the adapter invocation count remains zero.               |
| Duplicate submission                       | The second submission is recorded as `DEDUPLICATED` and produces no duplicate effects.   |
| Ledger write failure                       | The transaction rolls back and the adapter is not invoked.                               |
| Expired scheduler ownership                | A new owner recovers at a higher epoch; stale mutations and late results fail.           |

## Next boundary

The next implementation phase may add deterministic and Hermes adapters only after this static foundation remains predictable under repeated interruption, timeout, and worker-failure tests. Dynamic graph proposals remain inert until separately designed policy validation proves topology, limits, resources, verifier placement, approvals, and termination.
