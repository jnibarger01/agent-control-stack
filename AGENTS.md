# AGENTS.md

## Purpose

This repository implements the Agent Control Stack, a governed control plane for creating, approving, leasing, executing, auditing, and reviewing agent work.

Changes must preserve:

- explicit human authority for sensitive actions;
- fail-closed authorization and approval behavior;
- deterministic, auditable state transitions;
- lease and ownership fencing for concurrent workers;
- separation between control-plane policy and execution;
- redaction of secrets and sensitive data;
- reproducible tests and generated artifacts.

Do not weaken these properties to make an implementation simpler or a test pass.

## Repository Scope

These instructions apply to the entire repository unless a more specific `AGENTS.md` exists in a subdirectory.

Before editing:

1. Read this file.
2. Read relevant architecture, protocol, security, and runbook documentation.
3. Inspect the current implementation and tests.
4. Check the live Git status and current branch.
5. Identify unrelated or concurrent work before writing.

Documentation is not automatically authoritative when it conflicts with executable behavior. Resolve discrepancies explicitly rather than silently choosing one source.

## Repository Structure

This is a TypeScript and Node.js monorepo.

- `apps/gateway/`: HTTP, SSE, dashboard, and external control-plane entry points.
- `apps/control-ui/`: operator-facing control and work-item views.
- `apps/worker/`: bounded worker execution entry points.
- `packages/shared/`: shared schemas, identifiers, errors, redaction, audit-chain primitives, and common contracts.
- `packages/work-items/`: work-item lifecycle, persistence, and canonical audit-chain storage behavior.
- `packages/policy-gate/`: authorization, policy evaluation, and approval enforcement.
- `packages/eval-harness/`: controlled evaluation and test-agent execution.
- `packages/temporal-memory/`: time-aware memory and retained execution context.
- `packages/sandbox/`: execution isolation and process-environment controls.
- `storage/migrations/`: SQLite migrations and persistence schema.
- `docs/architecture.md`: system design and trust boundaries.
- `docs/protocol/`: API, MCP, lifecycle, and approval contracts.
- `docs/runbooks/`: operational procedures and failure recovery.
- `docs/security-contracts.md`: security invariants and enforcement requirements.

Keep applications thin. Domain rules belong in packages.

Packages must not depend on applications.

## Authority and Trust Boundaries

Treat every external input as untrusted, including:

- HTTP and SSE requests;
- MCP tool calls;
- worker results;
- approval tokens;
- caller identity fields;
- persisted state loaded during resume;
- environment variables;
- artifact paths;
- generated or model-produced content.

Validate untrusted data at the boundary with the repository’s canonical schemas.

Do not trust caller-supplied identity, authority, ownership, approval, lease, or policy fields when those values should be injected or derived by the control plane.

Sensitive operations must require the documented approval and authorization checks. Do not add bypasses, permissive fallbacks, development exceptions, or default-allow behavior unless the security contract explicitly requires them.

## Approval Rules

Approval is a security boundary, not a user-interface state.

Any code that consumes an approval must verify all required binding data, including the fields defined by the current approval contract. This may include:

- approval identifier;
- work-item or action identifier;
- action hash or equivalent immutable request fingerprint;
- caller or principal identity;
- scope;
- expiration;
- revocation state;
- one-time-use or replay constraints.

Verification and state mutation must be transactionally consistent where required.

Do not infer that an operation is approved merely because an approval record exists.

Expired, revoked, mismatched, reused, malformed, or unverifiable approvals must fail closed.

## Lease and Ownership Rules

Every run-scoped mutation must be fenced by the current scheduler or worker ownership token.

Where the storage contract requires it, verify inside the same database transaction:

- run identifier;
- owner identifier;
- lease epoch or generation;
- unexpired lease;
- expected work-item or action binding.

Only perform the mutation after all ownership conditions pass.

Do not separate ownership verification from mutation in a way that creates a time-of-check/time-of-use race.

A stale worker must not be able to:

- append attempts;
- update run state;
- publish results;
- consume approvals;
- write artifacts;
- complete or fail a run;
- overwrite a newer owner’s state.

## Resume and Integrity Rules

Persisted execution state is untrusted when a run is resumed.

Before continuing execution or returning a resumed summary, verify the integrity fields required by the persistence contract.

Where hashes are stored, recompute them from the canonical representation and fail closed on mismatch.

Integrity checks should cover at least:

- persisted successful outputs;
- attempt inputs;
- action or request fingerprints;
- approval bindings;
- artifact metadata where applicable.

Do not continue from partially verified state.

## Worker Result Rules

Worker output must remain bound to the work that authorized it.

Validate worker results against the current run, attempt, lease, action hash, schema, and ownership requirements before accepting them.

Do not allow a worker to submit arbitrary final state, approval state, caller identity, policy decisions, or audit authority.

The control plane owns authoritative lifecycle transitions.

## Sandbox and Process Execution

All process execution must pass through the repository’s sandbox or execution boundary.

Do not spawn commands directly from gateway, protocol, or policy code when an execution abstraction exists.

Environment forwarding must use an explicit allowlist.

Preserve required connectivity variables only when they are intentionally supported, such as approved proxy or certificate variables. Never forward the entire parent environment by default.

Do not expose:

- access tokens;
- API keys;
- cookies;
- credential files;
- SSH material;
- cloud credentials;
- unrelated service configuration;
- internal control-plane secrets.

Treat dry-run behavior, command validation, filesystem restrictions, timeout handling, output limits, and termination behavior as security-relevant.

Do not describe the sandbox as providing stronger isolation than the implementation actually enforces.

## Audit Requirements

Security-relevant decisions and lifecycle transitions must produce structured audit events.

Audit events should follow the repository’s canonical event shape and include enough context to reconstruct:

- who or what initiated the action;
- what resource was affected;
- which policy or approval was evaluated;
- the resulting decision;
- relevant run, work-item, attempt, lease, and action identifiers;
- failure codes without leaking secrets.

Audit records must not contain raw credentials, tokens, secret environment values, or unrestricted command output.

Changes to audit schemas require corresponding replay, migration, and compatibility tests.

## Error Behavior

Use canonical repository error types and codes.

Errors exposed across trust boundaries must be:

- stable;
- structured;
- non-secret;
- actionable;
- consistent with documented failure behavior.

Do not document error codes that cannot actually be produced through the described path.

Do not collapse distinct authorization, approval, lease, integrity, validation, and storage failures into a generic success or retry response.

## Coding Standards

Use strict TypeScript and ESM.

Prefer:

- small named exports;
- explicit types at trust boundaries;
- exhaustive handling of state machines and discriminated unions;
- canonical schemas rather than duplicated validation;
- dependency injection for clocks, identifiers, storage, and external execution;
- immutable request fingerprints;
- narrow interfaces between packages.

Avoid:

- `any` without a documented reason;
- unchecked type assertions;
- duplicated schema definitions;
- hidden global state;
- application-to-application imports;
- package-to-application imports;
- business logic in route handlers;
- security decisions based only on UI state;
- silent fallback behavior.

Use two-space indentation for JSON and follow the repository formatter for source files.

Package names use the `@agent-control-stack/<name>` namespace.

## Testing Requirements

Use Vitest for behavior and regression tests.

Place tests beside the relevant code as `*.test.ts` unless the existing package uses a more specific established structure.

Security-sensitive changes require negative tests, not only success-path tests.

Test relevant cases such as:

- unauthorized access;
- missing, expired, revoked, reused, or mismatched approvals;
- stale lease holders;
- concurrent mutation attempts;
- replayed worker results;
- action-hash mismatch;
- caller-identity spoofing;
- input and output tampering;
- transaction rollback;
- database restart and resume;
- environment-variable leakage;
- redaction failures;
- generated-schema drift;
- unreachable or incorrect documented errors.

SQLite tests must use isolated temporary databases and clean them up.

A test that intermittently fails must be investigated. Do not dismiss a failure as a flake without reproducing the affected test independently and confirming that the change did not cause it.

## Generated Files

Do not manually edit generated files.

Change the source contract or generator, regenerate the artifact, and run the synchronization or drift test.

Generated schemas, fingerprints, protocol examples, and documentation samples must match the real runtime representation.

## Validation

Use the scripts currently defined in the root and affected workspace `package.json` files.

At minimum, run the narrowest relevant tests while developing and the repository’s authoritative full validation command before declaring completion:

```bash
npm run check
```

Also run any affected package-specific tests, schema synchronization checks, linting, formatting, or typechecking not already included by the authoritative command.

Do not claim a command passed unless its exit status was observed.

Report:

- commands run;
- tests passed and failed;
- any non-reproducible failures;
- files not tested;
- limitations of the environment.

## Git Custody and Concurrent Work

Assume another process or agent may be using the repository.

Before any write:

```bash
git status --short --branch
git rev-parse HEAD
```

Record the initial branch, HEAD, and worktree state.

Do not modify, stage, discard, reset, stash, commit, or move unrelated work.

Stop before Git writes when:

- unexpected files change;
- HEAD moves unexpectedly;
- another writer appears active;
- the worktree differs materially from the reported custody state;
- the intended ownership of existing changes is unclear.

Read-only inspection may continue to determine whether the discrepancy is benign.

Prefer an isolated worktree for implementation, repair, review fixes, cherry-picks, or work that may overlap with another session.

Before committing, verify exactly which paths are staged.

Never use broad staging commands such as:

```bash
git add .
git add -A
```

when unrelated work may exist.

Use path-scoped staging.

## Commit and Pull Request Rules

Use concise imperative commit subjects.

Each commit should represent one coherent change and include only authorized paths.

Do not commit, push, merge, rebase, cherry-pick, create or delete branches, resolve remote review threads, deploy, restart services, or mutate production state without explicit authorization.

Pull requests should include:

- purpose and security impact;
- changed paths;
- architecture or protocol implications;
- validation commands and results;
- migration or compatibility notes;
- linked issues or review findings;
- screenshots only when visible UI behavior changed;
- known limitations or deferred work.

Do not mark a review finding resolved unless the underlying issue is actually fixed or the resolution rationale is recorded.

## Documentation Rules

Update documentation when behavior, authority, protocol, configuration, failure handling, or operational procedures change.

Search for contradictory documentation across the repository rather than updating only the nearest file.

Examples and tables must reflect reachable runtime behavior.

Clearly distinguish:

- implemented behavior;
- planned behavior;
- optional hardening;
- unsupported behavior.

Do not present future isolation, authentication, approval, or policy work as already enforced.

## Configuration and Secrets

Never commit secrets or real credentials.

Configuration examples must use non-sensitive placeholders.

Local development services should bind to loopback unless remote exposure is explicitly required and secured.

Do not weaken file permissions, authentication, token validation, redaction, or network binding for convenience.

When changing configuration shape:

- update the canonical schema;
- add migration or compatibility behavior if required;
- update examples;
- update tests;
- document defaults;
- verify secret fields remain redacted.

## Database Changes

SQLite migrations must be:

- ordered;
- deterministic;
- forward-safe;
- tested from a fresh database;
- tested from the previous supported schema where applicable.

Do not edit an already-released migration to change historical behavior. Add a new migration.

State transitions that depend on authorization, approval, leases, or integrity checks should be atomic.

## Completion Standard

A task is complete only when:

1. The requested behavior is implemented.
2. Security invariants remain intact.
3. Relevant tests cover success and failure paths.
4. Generated artifacts are synchronized.
5. Documentation matches the implementation.
6. Required validation passes.
7. The final Git diff contains only authorized changes.
8. No unresolved custody or concurrency issue remains.

Final reports must use one verdict:

- `PASS`: complete and verified.
- `PARTIAL`: useful work completed, but clearly identified items remain.
- `BLOCK`: work cannot safely proceed because a required condition is unresolved.
- `FAIL`: the requested result was attempted and did not meet its acceptance criteria.
