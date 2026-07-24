# Threat Model

## Scope

Agent Control Stack is a local control plane for ChatGPT/MCP clients and autonomous agents that request privileged local-machine actions.

In scope:

- MCP tool calls.
- Local filesystem access.
- Future command execution.
- Service and process control.
- Work-item creation and dry-run worker simulation.
- Policy decisions.
- Human approvals.
- Audit and event logging.
- Remote HTTPS connector exposure through a tunnel or gateway front end.
- Local worker leases and result submission.

Out of scope for MVP:

- Full remote desktop control.
- Keystroke or mouse automation.
- Browser session takeover.
- Multi-user enterprise authorization.
- Cloud-hosted execution.
- Kernel sandbox guarantees.

## Assets

| Asset                       | Why it matters                                                                   |
| --------------------------- | -------------------------------------------------------------------------------- |
| User filesystem             | Contains code, credentials, configs, documents, and private data.                |
| Shell and process execution | Can mutate system state, exfiltrate data, install malware, or break services.    |
| Secrets                     | API keys, SSH keys, tokens, and browser/session material have high blast radius. |
| Audit log                   | Source of truth for what happened and why.                                       |
| Approval store              | Grants authority for risky actions.                                              |
| Policy config               | Defines what is allowed, denied, or approval-gated.                              |
| Worker leases               | Prevent unauthorized result submission and work stealing.                        |
| Connector identity          | Links remote requests to authenticated clients.                                  |
| Tunnel or HTTPS endpoint    | External exposure surface.                                                       |

## Trust Boundaries

```text
ChatGPT / LLM context
  | untrusted request
  v
MCP transport / connector ingress
  | authenticated transport, untrusted intent
  v
Local control plane
  | trusted enforcement boundary
  v
Policy + approval + audit
  | constrained execution
  v
Filesystem / shell / services / workers
```

Trust assumptions:

- LLM output is untrusted.
- Tool descriptions are untrusted hints.
- Tunnel authentication does not validate user intent.
- Local policy is trusted only if every privileged path routes through it.
- Human approval is trusted only when it is out-of-band and request-bound.
- Audit logs are trusted for incident evidence only if mutations fail closed on audit-write failure; tamper evidence requires hash chaining.
- Only the hash-chained SQLite `audit_events` store is authoritative for Engine
  Harness decisions and replay; JSONL and process logs are telemetry
  ([ADR 0011](adr/0011-canonical-audit-sink.md)).
- A live command is authorized only through the ACS authority path
  ([ADR 0009](adr/0009-engine-harness-authority-and-dependencies.md)) and must
  fail closed when the Linux sandbox contract cannot be proven
  ([ADR 0010](adr/0010-fail-closed-linux-sandbox.md)).

## Current Boundaries

- HTTP requests enter through `apps/gateway`.
- Durable state is SQLite in `storage/local.db` by default.
- Gateway HTTP mutations require configured bearer auth; if mutation auth is not configured, they fail closed with `503`.
- MCP `tools/call` requests require bearer authorization or a signed tunnel-session assertion from a configured trusted local proxy. A local `ACS_MCP_BEARER_TOKEN` can satisfy this outside production; production uses OAuth/JWKS validation or `ACS_AUTH_MODE=tunnel_id` with persistent connector/session records. `initialize`, `ping`, `notifications/*`, and `tools/list` are unauthenticated only for loopback local development when MCP auth is not configured.
- Worker simulation must only consume approved work-item events.
- Sandbox execution is currently dry-run only.
- Result submission uses an authenticated public HTTP route and remains lease-bound in the work-item store. The credential must be bound to the worker role and worker ID; ACS also checks the lease, action hash, expiry, state, payload bounds, and durable idempotency key.
- Accepted execution results are append-only and transactionally coupled to the terminal work-item transition, lease closure, and audit events. Retry and clone create new linked work items; they do not reopen historical items.
- Approval and registry mutation identity is resolved to a canonical registry actor id where authenticated mutation paths are implemented.
- Audit entries are transactional, append-only in SQLite, hash-chained, and locally verifiable. They are not OS-protected against local tampering.

## Actors

| Actor                                | Capability                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| Prompt-injection attacker            | Influences model context through webpages, files, logs, issues, PRs, docs, or tool output. |
| Malicious MCP caller                 | Sends crafted tool calls to an exposed endpoint.                                           |
| Compromised tunnel credential holder | Reaches connector ingress.                                                                 |
| Buggy agent                          | Requests wrong or overbroad actions without malicious intent.                              |
| Local malware                        | Tampers with local files, logs, config, or approval store.                                 |
| Curious model                        | Chains safe-looking calls toward unsafe outcomes.                                          |
| Human operator mistake               | Approves a bad request when context is unclear.                                            |

## Attack Surfaces

- MCP request parsing.
- Tool schema validation.
- Future command execution.
- Filesystem path handling.
- Symlinks and path traversal.
- Secret-bearing file reads.
- Output redaction.
- Approval grants and request-hash storage.
- Audit-log integrity.
- Worker lease lifecycle.
- HTTPS or tunnel ingress.
- Service restart and control.
- Dependency install, build, and test commands.
- Environment variables passed to subprocesses.

## Implemented Controls

- Zod validates public request bodies and event shapes.
- Sensitive keys such as tokens, passwords, API keys, secrets, and authorization headers are redacted before audit events are created.
- The policy gate fails closed for requested actions.
- The policy gate denies unknown action kinds, sudo, destructive root removal, credential-file reads, unapproved network, path-escape writes, and high-risk self-approval.
- Tunnel connector records persist Ed25519 public keys and allowed MCP scopes in SQLite.
- Tunnel session records persist connector id, tunnel id, session id, expiry, heartbeat, and revocation state.
- Signed tunnel assertions are accepted only from allowlisted local proxy addresses and only while the connector and session are active and unexpired.
- File writes, package installs, service restarts, git commits, system mutations, high-risk work, and long-running commands require approval.
- The worker only starts rows that are already `approved`; the sandbox only accepts `running` work items.
- Work-item state changes and audit events are written in one SQLite transaction.
- Policy decisions are audited as `policy.decided`.
- Approvals are stored by work item and exact action hash, with request hashes, expiry, and consumed status. The dormant `approval_token_hash` column remains for compatibility but is not an authorization artifact — this is the intentional, documented design (see amended [ADR 0004](adr/0004-request-bound-approval-tokens.md)), not a gap awaiting a token implementation.
- Audit rows store previous and current event hashes so tampering is detectable by verification; detected invalid chains disable future store writes until repaired out of band.
- Running work has a worker lease; startup reaps expired leases as failed.
- Result submission requires an authenticated worker principal plus matching work item ID, lease ID, worker ID, action hash, active unexpired lease, canonical bounded payload, and durable idempotency key. Raw lease tokens are never persisted.
- Exact result replays return the original accepted result; conflicting idempotency or work-item submissions fail closed. Results, terminal work-item history, and audit evidence cannot be edited in place.
- The eval harness checks for `work_item.running` events that appear before approval.

## Threats And Mitigations

| ID  | Threat                                       | Impact                                     | Mitigation                                                                                                                                                            |
| --- | -------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T01 | Prompt injection requests destructive action | File loss or system compromise             | Treat LLM output as untrusted, policy-gate every action, approval-gate mutation.                                                                                      |
| T02 | MCP caller bypasses approval                 | Unauthorized mutation                      | Deny MCP self-approval, require request-bound approvals, route tools through policy-gated work items.                                                                 |
| T03 | Approval replay                              | Repeated mutation                          | Store approval status, expiry, request hash, and consumed state; consume approvals during worker claim.                                                               |
| T04 | Argument swap after approval                 | Different action executes                  | Bind approvals to the policy-evaluated action hash.                                                                                                                   |
| T05 | Path traversal                               | Read/write outside allowed roots           | Resolve path containment in policy and deny path escapes.                                                                                                             |
| T06 | Symlink escape                               | Access outside intended root through links | Add realpath and symlink escape checks before live filesystem execution.                                                                                              |
| T07 | Sensitive file read                          | Secret leakage                             | Deny credential-path reads and redact secret-looking values before audit persistence.                                                                                 |
| T08 | Command injection                            | Arbitrary shell execution                  | Use command arrays behind sandbox execution; add shell-metacharacter tests before live command mode.                                                                  |
| T09 | Dangerous command execution                  | System damage                              | Deny destructive commands; approval-gate package installs, system mutations, service restarts, and long commands.                                                     |
| T10 | Environment secret leakage                   | Token exposure to subprocess               | Add subprocess environment allowlists before live command mode; redact output.                                                                                        |
| T11 | Audit tampering                              | Loss of incident evidence                  | Hash-chain audit rows and verify the chain before trusting incident evidence.                                                                                         |
| T12 | Audit write failure ignored                  | Mutation without evidence                  | Keep work-item state changes and audit events in the same transaction.                                                                                                |
| T13 | Worker result forgery                        | Fake completion or data injection          | Require authenticated worker role, credential-bound worker ID, valid lease, matching action hash, bounded schema, and atomic result acceptance.                       |
| T14 | Worker lease replay                          | Unauthorized result reuse                  | Store only lease-token hashes, bind leases to worker/item/action, expire or consume leases, allow one active lease per running item, and persist idempotency records. |
| T15 | Exposed unauthenticated endpoint             | Remote unauthorized control                | Require bearer/OAuth authorization or signed tunnel-session assertions for exposed `/mcp`; require gateway bearer auth for HTTP mutations.                            |
| T16 | Output flooding                              | Memory exhaustion or prompt flooding       | Add output byte caps and truncation flags before live command mode.                                                                                                   |
| T17 | Long-running process abuse                   | Resource exhaustion                        | Require approval for long-running commands; add process-group termination before live command mode.                                                                   |
| T18 | Policy config tampering                      | Wider authority                            | Add config digesting and ownership checks before externalized policy config.                                                                                          |
| T19 | Dependency lifecycle command abuse           | Supply-chain modification                  | Approval-gate package install commands and audit the decision.                                                                                                        |
| T20 | Service restart abuse                        | Availability loss                          | Approval-gate service restarts and audit results.                                                                                                                     |
| T21 | Tool implementation bypasses central policy  | Silent privilege escalation                | Keep privileged tools behind `createWorkItemTools`; add bypass tests for new privileged paths.                                                                        |

## Security Invariants

These must remain true across releases:

- No mutating operation executes without a policy decision.
- No approval-gated action executes without request-bound approval.
- Approval is bound to exact canonical action content.
- Approval grants are exact-action and request-hash bound, expiring, and consumed once.
- Denylisted paths override allowlisted paths.
- Symlink escapes are blocked before live filesystem execution.
- Secret-looking data is redacted before returning to MCP and before audit persistence.
- Audit write failure blocks mutation.
- Worker result submission requires worker identity and a valid lease token.
- Worker result submission requires authenticated worker authority, an active matching lease, action hash, bounded dry-run payload, and durable idempotency.
- Accepted results and terminal history are immutable; retry and clone create new linked work items.
- Tunnel connector identity requires trusted local proxy source, valid signature, active connector, active unexpired session, and matching tool scope.
- Remote connector exposure never grants more authority than local policy permits.

## Validation Plan

Minimum test groups:

- Path traversal and symlink escape tests.
- Sensitive file read tests.
- Command classifier tests.
- Shell metacharacter tests.
- Approval lifecycle tests.
- Approval replay and argument-swap tests.
- Audit hash-chain verification tests.
- Audit write failure tests.
- Worker lease, result-submission, idempotency, retry, clone, and concurrent-conflict tests.
- HTTPS authentication smoke tests.
- Signed tunnel-session auth tests for signature failure, expiry, revocation, heartbeat, and per-connector scopes.
- Redaction tests using fake canary secrets.

## Deferred Hardening

Approval grants are bound to exact plan/action content via `plan_hash`/`action_hash`/`request_hash` and are single-use and expiry-checked atomically at consumption (see [ADR 0004](adr/0004-request-bound-approval-tokens.md), [ADR 0012](adr/0012-retire-ed25519-approval-artifact-reference.md), `storage/migrations/006_execution_plans_and_attempts.sql`). No signed approval-grant artifact is planned or required. Real plugin or command execution also needs process isolation before enablement: firejail, nsjail, bubblewrap, Docker, or equivalent — this is now built behind `packages/sandbox` (see [ADR 0010](adr/0010-fail-closed-linux-sandbox.md)).

Layer 2 should also move risk-based approval routing into `packages/policy-gate`, add lease renewal before live long-running execution, add a true cross-process claim contention check, and treat `draft` as a reserved ingestion state until a draft creation endpoint exists.

## Residual Risks

- A human can still approve a harmful action.
- Local malware can tamper with local config or logs unless OS-level controls are added.
- Redaction patterns will never catch every possible secret format.
- Allowlisted commands can still have risky behavior through flags or plugins.
- Remote exposure increases attack surface even with authentication.

## MVP Security Bar

Before remote ChatGPT connector mode is considered usable:

- Local read-only tools pass.
- Command preview and classifier pass.
- Mutations require out-of-band approval.
- Audit log is hash-chained and verifiable.
- Secret redaction tests pass.
- Worker leases are enforced.
- HTTPS or tunneled `/mcp` endpoint requires auth.
- A live smoke test proves unauthenticated mutation fails.
