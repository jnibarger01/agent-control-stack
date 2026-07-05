# Threat Model: agent-control-stack

## Scope

This threat model covers `agent-control-stack` as a local control plane for ChatGPT/MCP clients and autonomous agents that request privileged local-machine actions.

In scope:

- MCP tool calls
- Local filesystem access
- Command execution
- Service/process control
- Work-item creation and execution
- Policy decisions
- Human approvals
- Audit/event logging
- Remote HTTPS connector exposure
- Local worker leases and result submission

Out of scope for MVP:

- Full remote desktop control
- Keystroke/mouse automation
- Browser session takeover
- Multi-user enterprise authorization
- Cloud-hosted execution
- Kernel sandbox guarantees

## Current known boundaries

The existing repository already identifies important Layer 1 boundaries:

- HTTP requests enter through `apps/gateway`.
- Durable state is SQLite audit state in `storage/local.db` by default.
- Worker execution should consume only approved work-item events.
- Sandbox execution is currently dry-run only.
- Layer 1 does not yet have full HTTP authentication or real bound approver/worker identity.

Layer 2 hardening must bind approvals to authenticated approvers, bind result submission to worker identity, and add real process isolation before enabling real plugin or command execution.

## Assets

| Asset | Why it matters |
|---|---|
| User filesystem | Contains code, credentials, configs, documents, private data. |
| Shell/process execution | Can mutate system state, exfiltrate data, install malware, break services. |
| Secrets | API keys, SSH keys, tokens, browser/session material. Tiny strings, enormous blast radius. Classic human engineering. |
| Audit log | Source of truth for what happened and why. |
| Approval store | Grants authority for risky actions. |
| Policy config | Defines what is allowed or denied. |
| Worker leases | Prevent unauthorized result submission or work stealing. |
| Connector identity | Links remote requests to authenticated clients. |
| Tunnel/HTTPS endpoint | External exposure surface. |

## Trust boundaries

```text
ChatGPT / LLM context
  | untrusted request
  v
MCP transport / connector ingress
  | authenticated but not trusted for intent
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

1. LLM output is untrusted.
2. Tool descriptions are untrusted hints.
3. The tunnel authenticates transport but does not validate intent.
4. The local policy gate is trusted only if every privileged path routes through it.
5. Human approval is trusted only when out-of-band and request-bound.
6. Audit logs are trusted only if append-only and hash-chained.

## Threat actors

| Actor | Capability |
|---|---|
| Prompt-injection attacker | Can influence model context through webpages, files, logs, issues, PRs, docs, or tool output. |
| Malicious MCP caller | Can send crafted tool calls to exposed endpoint. |
| Compromised tunnel credential holder | Can reach connector ingress. |
| Buggy agent | Can request wrong or overbroad actions without malicious intent. Still breaks things. |
| Local malware | Can tamper with local files, logs, config, or approval store. |
| Curious model | Can chain safe-looking calls toward unsafe outcomes. |
| Human operator mistake | Can approve a bad request if context is unclear. Humanity's oldest API. |

## Attack surfaces

- MCP request parsing
- Tool schema validation
- Command execution
- Filesystem path handling
- Symlinks and path traversal
- Secret-bearing file reads
- Output redaction
- Approval grant and token storage
- Audit-log integrity
- Worker lease lifecycle
- HTTPS/tunnel ingress
- Service restart/control
- Dependency install/build/test commands
- Environment variables passed to subprocesses

## Threats and mitigations

| ID | Threat | Impact | Mitigation |
|---|---|---|---|
| T01 | Prompt injection requests destructive action | File loss or system compromise | Treat LLM as untrusted, policy gate every action, approval-gate mutation. |
| T02 | MCP caller bypasses approval | Unauthorized mutation | Out-of-band approval, request-bound one-time tokens, deny MCP self-approval. |
| T03 | Approval replay | Repeated mutation | Consume approval tokens once, expire tokens, bind to request hash. |
| T04 | Argument swap after approval | Different action executes | Canonical request hash includes exact tool args, cwd, policy version, actor. |
| T05 | Path traversal | Read/write outside allowed roots | Realpath containment, denylist precedence, symlink escape checks. |
| T06 | Sensitive file read | Secret leakage | Restricted filename patterns, secret redaction, explicit policy for secrets. |
| T07 | Command injection | Arbitrary shell execution | Spawn arg arrays, no shell by default, shell metacharacter detection, command classifier. |
| T08 | Dangerous command execution | System damage | Forbidden command list, subcommand classifier, approval gate, sandbox limits. |
| T09 | Environment secret leakage | Token exposure to subprocess | Environment allowlist and output redaction. |
| T10 | Audit tampering | Loss of incident evidence | Hash-chained append-only log, verification command, pre/post event separation. |
| T11 | Audit write failure ignored | Mutation without evidence | Mutating operations fail closed if audit write fails. |
| T12 | Worker result forgery | Fake completion or data injection | Worker ID + lease token required for result submission. |
| T13 | Worker lease replay | Unauthorized result reuse | Expiring lease tokens, hash storage, one active lease rules. |
| T14 | Exposed unauthenticated endpoint | Remote unauthorized control | HTTPS auth, bearer/client identity binding, rate limits, deny unauthenticated mutation. |
| T15 | Output flooding | Memory exhaustion or prompt flooding | Output byte caps, truncation flags, timeouts. |
| T16 | Long-running process abuse | Resource exhaustion | Command timeouts, process group termination, bounded concurrency. |
| T17 | Policy config tampering | Wider authority | Config file ownership checks, audit config digest, manual review for policy changes. |
| T18 | Dependency lifecycle command abuse | Supply-chain modification | `npm install`, `curl | sh`, package manager mutation require approval or deny. |
| T19 | Service restart abuse | Availability loss | Service allowlist, approval, audit result. |
| T20 | Tool implementation bypasses central policy | Silent privilege escalation | Central execution API requires policy decision object; bypass tests. |

## Security invariants

These must remain true across releases:

1. No mutating operation executes without a policy decision.
2. No approval-gated action executes without out-of-band approval.
3. Approval is bound to exact canonical request content.
4. Approval tokens are one-time use and expiring.
5. Denylisted paths override allowlisted paths.
6. Symlink escapes are blocked.
7. Secret-looking data is redacted before returning to MCP and before audit persistence.
8. Audit write failure blocks mutation.
9. Worker result submission requires worker identity and valid lease token.
10. Remote connector exposure never grants more authority than local policy permits.

## Validation plan

Minimum test groups:

- Path traversal and symlink escape tests
- Sensitive file read tests
- Command classifier tests
- Shell metacharacter tests
- Approval lifecycle tests
- Approval replay and argument-swap tests
- Audit hash-chain verification tests
- Audit write failure tests
- Worker lease tests
- HTTPS authentication smoke tests
- Redaction tests using fake canary secrets

## Residual risks

- A human can still approve a harmful action. The UI must make dangerous intent painfully obvious.
- Local malware can tamper with local config or logs unless OS-level controls are added.
- Redaction patterns will never catch every possible secret format.
- Allowlisted commands can still have risky behavior through flags or plugins.
- Remote exposure increases attack surface even with authentication.

## MVP security bar

Before remote ChatGPT connector mode is considered usable:

1. Local read-only tools pass.
2. Command preview and classifier pass.
3. Mutations require out-of-band approval.
4. Audit log is hash-chained and verifiable.
5. Secret redaction tests pass.
6. Worker leases are enforced.
7. HTTPS endpoint requires auth.
8. Live smoke test proves unauthenticated mutation fails.
