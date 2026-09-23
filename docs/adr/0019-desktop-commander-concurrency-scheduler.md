# ADR 0019: Centralize Desktop Commander concurrency scheduling in ACS

## Status

Accepted

## Context

Multiple LLM clients may request managed Desktop Commander operations at the same time. The managed bridge is a shared machine-execution boundary, so independent callers must not decide concurrency locally. Two individually authorized operations can still conflict when they observe or mutate the same file, repository, package state, service, or host resource concurrently.

ACS already owns policy, approval, attempt leases, capability issuance, and the canonical audit trail. Desktop Commander remains a capability consumer and executor. Adding independent per-model Desktop Commander processes or a second authorization service would split authority.

The managed bridge obtains an `acs.dc.v1` capability through `POST /dc/capability/issue`. That route is therefore the convergence point for managed callers and the correct place to apply one process-wide concurrency decision before a capability is minted.

## Decision

ACS owns one in-memory Desktop Commander execution scheduler per gateway process.

Managed ordering:

```text
authenticate
-> normalize and contain arguments
-> evaluate policy
-> obtain approval when required
-> scheduler queue/admission
-> claim attempt + lease
-> re-authorize exact invocation
-> mint and record short-lived capability
-> Desktop Commander execution
-> accepted terminal result
-> scheduler release
```
Scheduling and authorization remain separate concerns:

- policy and approval answer whether an action may execute;
- the scheduler answers when an already-approved action may enter the execution lane;
- the `acs.dc.v1` verifier still enforces that the delivered tool call exactly matches the ACS capability.

The scheduler does not mint capabilities, approve work, widen scopes, create leases, or bypass containment.

### Capability compatibility

`acs.dc.v1` has an exact signed payload schema. Scheduler metadata is therefore not added to the signed capability payload. An internal `sched_<uuid>` admission identifier is retained in scheduler state and audit evidence. Capability preparation/signing happens only after admission.

### Execution intents

Each normalized Desktop Commander invocation is classified into an execution intent containing:

- requester/agent and session identity;
- lane: `read`, `search`, `process`, or `mutation`;
- effect: `read_only`, `workspace_mutation`, or `host_mutation`;
- shared/exclusive resource claims;
- coarse CPU/memory/I/O cost;
- priority: `interactive`, `normal`, or `background`.

Unknown Desktop Commander tools still fail at the existing allowlist boundary before classification. Unknown process commands still fail at the existing command-validation boundary before classification.
### Resource model

Resource claims use reader/writer semantics. Shared/shared is compatible. Exclusive conflicts with any other holder of the same key.

Current keys include:

```text
repo:<git-root>
file:<canonical-path>
dir:<canonical-path>
git:<git-root>
package-manager:<git-root>
workspace-run:<git-root>
service:<name>
process:<pid>
host:desktop-commander
```

Filesystem operations discover the nearest `.git` ancestor and take a shared repository fence in addition to their file/directory claim. This lets unrelated files mutate concurrently while repository-wide operations such as checkout or package installation take an exclusive repository fence and serialize against ordinary reads/writes in that repository.

Multi-resource acquisition is all-or-nothing. The scheduler never holds resource A while waiting for resource B.

### Lanes and fairness

Default lane limits are:

| Lane | Limit |
|---|---:|
| read | 8 |
| search | 3 |
| process | 3 |
| mutation | 8 |

Mutation concurrency is not globally one. Resource locks decide whether mutations conflict. The `search` lane is defined now and classifies Desktop Commander search operations when those tools are allowlisted; the current baseline policy still denies unknown search tools until the separate tool-policy expansion lands.

The scheduler keeps per-agent queues, prioritizes within an agent, and rotates eligible admissions across agents. A later shared request cannot bypass an earlier conflicting exclusive waiter.

Backpressure defaults:

- global queued requests: 200;
- queued per agent: 25;
- queued per session: 50;
- total outstanding per agent: 16;
- active process calls per agent: 2;
- exclusive repo mutations per agent/repo: 1.

Queue overload returns a structured, retryable scheduler error rather than accepting unbounded work.

### Timeout and cancellation

Queue timeout, lock timeout, and execution timeout are distinct.

A queue timeout bounds total pre-admission waiting. A lock timeout bounds continuous waiting on conflicting resource ownership and returns `scheduler_lock_timeout` before the broader queue timeout when configured lower. An admitted request is different: a timeout or operator cancellation does not prove the underlying machine action has stopped, so ACS does not automatically release its resource locks. Active locks are released only after an accepted terminal result or later explicit reconciliation that proves execution stopped.

This intentionally prefers temporary blocking over overlapping a possibly still-running mutation.

### Approval behavior

Approval never holds scheduler resources. Requests enter the scheduler only after the work item is approved. Attempt/lease claim occurs only after scheduler admission, so waiting in the scheduler does not burn an execution lease or move the work item to `running`.

After admission, ACS re-reads canonical state, claims the attempt/lease, and runs `authorizeDesktopCommanderExecution` before capability issuance.
### Crash behavior

Scheduler queues and locks are ephemeral gateway-process state. They are not persisted as authority. A process restart clears them.

If the gateway starts with a previously active managed-runtime registration or any active attempt lease, capability issuance fails closed with `scheduler_runtime_reconciliation_required`. Scheduling resumes only after the configured managed runtime completes a fresh bootstrap challenge/identity proof **and** the active-attempt lease count reaches zero. A pre-restart Desktop Commander execution may submit its canonical terminal result after re-attestation; draining the last active lease completes reconciliation. This still does not prove intentionally detached child processes have exited, so a future process-registry slice must reconcile those PIDs before their resources can be safely re-admitted.

### Observability

ACS exposes a read-only scheduler snapshot at `GET /api/dc/scheduler`.

Metrics include:

- `scheduler_queue_depth`
- `scheduler_active_requests`
- `scheduler_completed_total`
- `scheduler_failed_total`
- `scheduler_cancelled_total`
- `scheduler_timeout_total{phase}`
- `scheduler_lock_contention_total`
- `scheduler_lock_wait_ms{resource_type,quantile}`
- `scheduler_overload_rejected_total`
- `scheduler_lane_active{lane}`
- `scheduler_lane_limit{lane}`
- `scheduler_agent_active{agent}`
- `scheduler_agent_queued{agent}`
- `scheduler_queue_wait_ms{quantile}`

Audit evidence records queue, admission, denial, cancel-request, and release transitions without persisting raw tool arguments.
### Configuration

The defaults may be overridden with positive integer environment values using the prefix `ACS_DESKTOP_COMMANDER_SCHEDULER_`:

- `MAX_QUEUED`
- `MAX_QUEUED_PER_AGENT`
- `MAX_QUEUED_PER_SESSION`
- `MAX_OUTSTANDING_PER_AGENT`
- `MAX_ACTIVE_PROCESSES_PER_AGENT`
- `MAX_MUTATIONS_PER_REPO_PER_AGENT`
- `QUEUE_TIMEOUT_MS`
- `LOCK_TIMEOUT_MS`
- `RETRY_AFTER_MS`
- `READ_CONCURRENCY`
- `SEARCH_CONCURRENCY`
- `PROCESS_CONCURRENCY`
- `MUTATION_CONCURRENCY`

Invalid scheduler configuration fails gateway construction rather than silently falling back.

## Consequences

- Managed callers share one ACS scheduling decision instead of racing independent Desktop Commander execution paths.
- Non-conflicting file operations can run concurrently.
- Git/package/service mutations serialize against resources they can invalidate.
- Capability TTL begins after scheduler wait, not before.
- Scheduler state is visible to Mission Control/API consumers without becoming an authorization source.
- The existing scheduled-job application at `apps/scheduler` remains unrelated; this subsystem lives under the Desktop Commander adapter to avoid conflating time scheduling with execution concurrency.
## Known limitation

`start_process` can spawn a child that outlives the MCP tool call. The admission currently governs the `start_process` invocation through its accepted terminal tool result; a future process-registry slice must transfer any long-lived resource ownership to the returned PID before releasing the spawn admission. Until that exists, callers should not treat scheduler release as proof that an intentionally detached child has exited.

This limitation does not permit automatic unlock on timeout.

## Rejected alternatives

### One Desktop Commander instance per LLM

Rejected. Independent executors would have independent machine-state views and no common lock authority.

### One global mutex

Rejected. It is safe but unnecessarily serializes unrelated repositories and files.

### Capability issued before queueing

Rejected. Queue delay would consume the short `acs.dc.v1` lifetime and create stale-capability pressure.

### Persist scheduler locks as authority

Rejected. Attempt leases and capability issuance remain the durable execution authority. Scheduler locks are transient coordination state, not a second source of truth.

## Required tests

- concurrent shared reads admit;
- conflicting exclusive mutation waits for readers;
- multi-resource acquisition is atomic;
- earlier exclusive waiter cannot be starved by later shared readers;
- agent fairness rotates eligible work;
- lane/backpressure limits fail closed;
- queue timeout does not disturb active holders;
- execution timeout does not auto-release active locks;
- file operations and repository-wide mutations share the same git-root fence;
- gateway capacity is held from capability issuance through accepted terminal result;
- a queued timeout occurs before attempt/lease claim.
