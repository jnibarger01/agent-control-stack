# Threat Model

## Scope

Agent Control Stack is a local control plane for ChatGPT/MCP clients and autonomous agents that request privileged local-machine actions.

In scope:

- MCP tool calls.
- Local filesystem access.
- Command execution.
- Service and process control.
- Work-item creation and execution.
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

| Asset | Why it matters |
| --- | --- |
| User filesystem | Contains code, credentials, configs, documents, and private data. |
| Shell and process execution | Can mutate system state, exfiltrate data, install malware, or break services. |
| Secrets | API keys, SSH keys, tokens, and browser/session material have high blast radius. |
| Audit log | Source of truth for what happened and why. |
| Approval store | Grants authority for risky actions. |
| Policy config | Defines what is allowed, denied, or approval-gated. |
| Worker leases | Prevent unauthorized result submission and work stealing. |
| Connector identity | Links remote requests to authenticated clients. |
| Tunnel or HTTPS endpoint | External exposure surface. |

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

## Current Boundaries

- HTTP requests enter through `apps/gateway`.
- Durable state is SQLite in `storage/local.db` by default.
- Gateway HTTP mutations require configured bearer auth; if mutation auth is not configured, they fail closed with `503`.
- MCP `tools/call` requests require bearer authorization. A local bearer token or OAuth/JWKS config can satisfy this; `initialize` and `tools/list` remain discovery methods.
- Worker execution must only consume approved work-item events.
- Sandbox execution is currently dry-run only.
- Result submission is lease-bound in the work-item store; the public HTTP result route is not implemented.
- Approval identity is currently an application-level actor string, not a fully bound user identity.
- Audit entries are transactional, append-only in SQLite, hash-chained, and locally verifiable. They are not OS-protected against local tampering.

## Actors

| Actor | Capability |
| --- | --- |
| Prompt-injection attacker | Influences model context through webpages, files, logs, issues, PRs, docs, or tool output. |
| Malicious MCP caller | Sends crafted tool calls to an exposed endpoint. |
| Compromised tunnel credential holder | Reaches connector ingress. |
| Buggy agent | Requests wrong or overbroad actions without malicious intent. |
| Local malware | Tampers with local files, logs, config, or approval store. |
| Curious model | Chains safe-looking calls toward unsafe outcomes. |
| Human operator mistake | Approves a bad request when context is unclear. |

## Attack Surfaces

- MCP request parsing.
- Tool schema validation.
- Command execution.
- Filesystem path handling.
- Symlinks and path traversal.
- Secret-bearing file reads.
- Output redaction.
- Approval grants and token storage.
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
- File writes, package installs, service restarts, git commits, system mutations, high-risk work, and long-running commands require approval.
- The worker only starts rows that are already `approved`; the sandbox only accepts `running` work items.
- Work-item state changes and audit events are written in one SQLite transaction.
- Policy decisions are audited as `policy.decided`.
- Approvals are stored by work item and exact action hash, with request hashes, token hashes, expiry, and consumed status.
- Audit rows store previous and current event hashes so tampering is detectable by verification.
- Running work has a worker lease; startup reaps expired leases as failed.
- Result submission requires matching work item id, worker id, lease token, and an unexpired lease.
- The eval harness checks for `work_item.running` events that appear before approval.

## Threats And Mitigations

| ID | Threat | Impact | Mitigation |
| --- | --- | --- | --- |
| T01 | Prompt injection requests destructive action | File loss or system compromise | Treat LLM output as untrusted, policy-gate every action, approval-gate mutation. |
| T02 | MCP caller bypasses approval | Unauthorized mutation | Deny MCP self-approval, require request-bound approvals, route tools through policy-gated work items. |
| T03 | Approval replay | Repeated mutation | Store approval status, expiry, request hash, and consumed state; consume approvals during worker claim. |
| T04 | Argument swap after approval | Different action executes | Bind approvals to the policy-evaluated action hash. |
| T05 | Path traversal | Read/write outside allowed roots | Resolve path containment in policy and deny path escapes. |
| T06 | Symlink escape | Access outside intended root through links | Add realpath and symlink escape checks before live filesystem execution. |
| T07 | Sensitive file read | Secret leakage | Deny credential-path reads and redact secret-looking values before audit persistence. |
| T08 | Command injection | Arbitrary shell execution | Use command arrays behind sandbox execution; add shell-metacharacter tests before live command mode. |
| T09 | Dangerous command execution | System damage | Deny destructive commands; approval-gate package installs, system mutations, service restarts, and long commands. |
| T10 | Environment secret leakage | Token exposure to subprocess | Add subprocess environment allowlists before live command mode; redact output. |
| T11 | Audit tampering | Loss of incident evidence | Hash-chain audit rows and verify the chain before trusting incident evidence. |
| T12 | Audit write failure ignored | Mutation without evidence | Keep work-item state changes and audit events in the same transaction. |
| T13 | Worker result forgery | Fake completion or data injection | Require worker id and valid lease token for result submission. |
| T14 | Worker lease replay | Unauthorized result reuse | Store lease token hashes, expire leases, and allow one active lease per running item. |
| T15 | Exposed unauthenticated endpoint | Remote unauthorized control | Require bearer/OAuth authorization for MCP `tools/call`; require gateway bearer auth for HTTP mutations. |
| T16 | Output flooding | Memory exhaustion or prompt flooding | Add output byte caps and truncation flags before live command mode. |
| T17 | Long-running process abuse | Resource exhaustion | Require approval for long-running commands; add process-group termination before live command mode. |
| T18 | Policy config tampering | Wider authority | Add config digesting and ownership checks before externalized policy config. |
| T19 | Dependency lifecycle command abuse | Supply-chain modification | Approval-gate package install commands and audit the decision. |
| T20 | Service restart abuse | Availability loss | Approval-gate service restarts and audit results. |
| T21 | Tool implementation bypasses central policy | Silent privilege escalation | Keep privileged tools behind `createWorkItemTools`; add bypass tests for new privileged paths. |

## Security Invariants

These must remain true across releases:

- No mutating operation executes without a policy decision.
- No approval-gated action executes without request-bound approval.
- Approval is bound to exact canonical action content.
- Approval tokens are one-time use and expiring.
- Denylisted paths override allowlisted paths.
- Symlink escapes are blocked before live filesystem execution.
- Secret-looking data is redacted before returning to MCP and before audit persistence.
- Audit write failure blocks mutation.
- Worker result submission requires worker identity and a valid lease token.
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
- Worker lease tests.
- HTTPS authentication smoke tests.
- Redaction tests using fake canary secrets.

## Deferred Hardening

Layer 2 must bind approvals to authenticated approvers and bind remote result submission to worker identity. Real plugin or command execution also needs process isolation before enablement: firejail, nsjail, bubblewrap, Docker, or equivalent. Add that behind `packages/sandbox` instead of teaching callers about the runtime.

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
- HTTPS endpoint requires auth.
- A live smoke test proves unauthenticated mutation fails.
