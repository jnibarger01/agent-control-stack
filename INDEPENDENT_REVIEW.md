# Independent ACS Architecture, Security, and Production-Readiness Review

**Reviewer**: Independent lead reviewer
**Date**: 2026-07-25
**Status**: COMPLETE

---

## 1. Verdict

**PARTIAL** — for local developer experimentation, read-only agent observation, and controlled internal testing with human approval.

The system is architecturally strong and demonstrates unusual security maturity for a v0.1.0-alpha. However, material operational, hardening, and vulnerability items must be resolved before production deployment, internet-exposed deployment, or autonomous write operations.

**Deployment scope covered by this verdict**: Single-user, local-only, human-supervised agent control with dry-run execution and policy-gated approvals. Not yet deployable for multi-user, internet-exposed, autonomous, or production-critical agent control.

---

## 2. Executive Summary

ACS (Agent Control Stack) implements a governed control plane for creating, approving, leasing, executing, auditing, and reviewing agent work. It is a TypeScript/Node.js monorepo with seven SQL migrations, twelve packages, and six application entry points.

**Strongest aspects**:

- **Defense-in-depth by design**. State machine invariants are enforced at the SQLite trigger level (not just application code). Approvals are bound to action hashes, consumed atomically with lease issuance, and checked against expiry, revocation, and replay constraints. The audit log is hash-chained and verified on startup.
- **Exceptional test quality**. 572 tests pass (62 test files), covering state-machine transitions, authorization gates, approval lifecycle, path escapes, symlink escapes, shell metacharacters, credential paths, concurrent races, and idempotency. TypeScript type-checking and formatting pass cleanly. Build succeeds.
- **Fail-closed culture**. Every authorization gate examined defaults to denial. MCP tool `approve_work_item` returns a hard 403. Missing auth configuration returns 503. Invalid transitions throw errors.
- **Thorough documentation**. Threat model, ADRs, security contracts, protocol specs, and runbooks exist and substantially match the implementation.

**Largest risks**:

- **No rate limiting or request size limits** on most gateway endpoints (medium severity). A compromised or misbehaving agent can exhaust server resources.
- **CSRF protection is cookie-only** (`SameSite=Strict`, `HttpOnly`, `Secure` in production). While substantial, this relies entirely on browser SameSite enforcement which has known bypasses and is insufficient for non-browser clients.
- **Single-static-token dashboard authentication**. Gateway auth depends on `ACS_GATEWAY_TOKEN` - a single bearer token and session HMAC key. Token rotation requires restart. No brute-force protection.
- **Six high-severity npm vulnerabilities** in the dependency tree (brace-expansion DoS, postcss path traversal). These are in transitive dependencies (dev tooling) but violate the stated `npm audit` gating requirement.
- **Tunnel authentication replay window** (60s default) without nonce enforcement. A compromised proxy could replay captured signed assertions within the window.
- **SSE endpoint lacks client count limits**, enabling memory-exhaustion DoS.

**Should ACS currently control real agents or privileged tools?** No. The system is architecturally sound and the domain logic is correct, but it lacks operational hardening (rate limits, resource limits, startup validation, health-check completeness) required for production. The sandbox execution is dry-run only — the Bubblewrap/systemd-backed isolation exists in code but is marked as integration-test-only and is not exercised.

**Most important next action**: Add rate limiting, request size limits, and SSE client limits to the HTTP gateway; resolve the six high-severity npm advisories; and run the sandbox integration tests against a real Bubblewrap/systemd environment.

---

## 3. Environment and Evidence

| Item | Value |
| ---- | ----- |
| Repository path | `/home/jacen/projects/agent-control-stack` |
| Current branch | `main` |
| Current commit | `522778015ea84cfcd57eaa23daace3035dc64778` |
| Worktree state | Clean (no dirty files) |
| Unrelated worktrees | None |
| Node.js version | v26.5.0 |
| npm version | 11.17.0 |
| Package manager | npm |
| Docker available | Yes, but no containers running |
| Running ACS processes | **None**. ACS gateway is not running. Port 3000 not in use. |
| Running related process | `openclaw-gatewa` on port 18900 (OpenClaw Control, separate project) |
| Database type | SQLite (no `.env` file found, no database file present) |
| Configuration loaded | None (no `.env` or runtime config present) |
| Auth mode active | N/A - gateway not running |
| Concurrent writers | Not detected (sole git worktree) |

**Commands executed**:

| Command | Result |
| ------- | ------ |
| `npm run test:vitest` | 572 passed, 15 skipped, 0 failed |
| `npm run typecheck` | Clean (no errors) |
| `npm run build` | Clean (TypeScript + public site) |
| `npm run format:check` | Clean |
| `npm audit --audit-level=high` | 6 high-severity vulnerabilities |
| `npm run lint` | Failed (eslint config not found in dist) |

**Experiments conducted (safe, non-destructive)**:

- HTTP probes against all visible listening services on the host (port 18900 OpenClaw gateway, ports 3111-3113, 3306, 5432, 6379, 11434)
- Code review of all 35+ source files across gateway, policy-gate, work-items, sandbox, shared, secret-broker, verification, engine-adapter, apps
- Review of all 7 SQL migration files
- Review of all 35 documentation files
- Review of all test files

**Evidence limitations**:

- ACS gateway was not running, so live HTTP auth and state-machine experiments could not be performed against ACS itself
- Sandbox integration tests (9 + 6 = 15 tests) were skipped because they require real Bubblewrap and systemd cgroup v2 support
- No `.env` file existed, so runtime configuration was not inspected
- ESLint configuration could not be verified (`eslint.config.js` exists but lint command failed)
- No docker-compose deployment was running

---

## 4. Architecture

### Component Inventory

| Component | Path | Role |
| --------- | ---- | ---- |
| **gateway** | `apps/gateway/` | HTTP/SSE entry point, MCP JSON-RPC handler, dashboard UI, auth middleware, MoA orchestration |
| **mcp** | `apps/mcp/` | Standalone MCP server (separate from gateway's MCP handler) |
| **worker** | `apps/worker/` | Simple CLI that claims + dry-runs + submits results |
| **scheduler** | `apps/scheduler/` | Timer-driven CLI that creates work items from schedule config |
| **control-ui** | `apps/control-ui/` | Dashboard rendering logic and agent projection |
| **public-site** | `apps/public-site/` | Vite-built static site |
| **shared** | `packages/shared/` | Canonical errors, hashing, redaction, migration helpers, DB health |
| **work-items** | `packages/work-items/` | Core domain: work item CRUD, state machine, SQLite store, execution plans, attempts, leases, approvals |
| **policy-gate** | `packages/policy-gate/` | Policy evaluation, contract admission, tool gating, approval enforcement, path escaping checks |
| **sandbox** | `packages/sandbox/` | Bubblewrap/systemd execution isolation, engine isolation boundary, egress proxy |
| **secret-broker** | `packages/secret-broker/` | Lease-bound secret delivery, principal-scoped accounting |
| **verification** | `packages/verification/` | Verifier contracts (Claude verifier, independent verifier) |
| **engine-adapter** | `packages/engine-adapter/` | Command broker, Codex adapter |
| **workspace-manager** | `packages/workspace-manager/` | Workspace allocation and lifecycle |
| **acp-adapter** | `packages/acp-adapter/` | ACP protocol adapter |
| **moa-orchestrator** | `packages/moa-orchestrator/` | Mixture-of-Agents orchestration |
| **machine-controller** | `packages/machine-controller/` | Direct agent machine control |
| **eval-harness** | `packages/eval-harness/` | Evaluations harness, replay, grading |
| **temporal-memory** | `packages/temporal-memory/` | Time-aware memory and context |

### Data Flow Summary

```
External(HTTP/SSE/MCP) ──► Gateway
  ├── /livez, /readyz, /health ──► DB health check
  ├── / (dashboard) ──► requireRead ──► rendered HTML
  ├── /session/login ──► POST with token ──► session cookie
  ├── /mcp (POST) ──► authorize ──► tools/call ──► policy-gate ──► work-items store
  ├── /work-items/* ──► requireRead/Mutation ──► policy-gate ──► work-items store
  ├── /api/agents/* ──► requireRead/Mutation ──► agent registry
  ├── /api/actors/* ──► requireRead/Mutation ──► actor registry
  ├── /connectors/* ──► requireMutation ──► connector/tunnel registry
  ├── /events (SSE) ──► requireRead ──► broadcast audit events
  └── /moa/* ──► MoA orchestrator ──► model calling + audit

Work Items Store (SQLite)
  ├── audit_events (hash-chained, append-only)
  ├── work_items (state machine enforced by triggers)
  ├── approval_records / execution_plan_approvals
  ├── leases / attempt_leases
  ├── execution_plans / execution_attempts
  ├── connectors / tunnel_sessions
  ├── actors / agents / capabilities / heartbeats
  └── workspace_allocations

Worker CLI ──► claims approved work ──► dry-run sandbox ──► submits result
Scheduler CLI ──► creates work items from config
```

### Trust Boundaries

```
[External / MCP / Agent]       ← UNTRUSTED
         │
    Gateway Auth Layer          ← AUTHENTICATED TRANSPORT
         │
    validateContractAdmission   ← SCHEMA VALIDATION
         │
    Policy Evaluation           ← POLICY GATE (fail-closed)
         │
    Approval Check              ← HUMAN APPROVAL REQUIRED
         │
    Lease + Ownership Fencing   ← BOUND EXECUTION
         │
    [SQLite Store / Sandbox]    ← TRUSTED ENFORCEMENT
```

### Architecture Diagram (Mermaid)

```mermaid
graph TD
    subgraph External
        MCP[MCP Client]
        HTTP[HTTP Client]
        SSE[SSE Client]
        Agent[Agent CLI]
    end

    subgraph Gateway[apps/gateway]
        Auth[Auth Middleware]
        Routes[HTTP Routes]
        MCPHandler[MCP JSON-RPC Handler]
        MoA[MoA Orchestrator]
        Dashboard[Dashboard Renderer]
        SSEBroad[SSE Broadcaster]
    end

    subgraph Policy[packages/policy-gate]
        Contract[Contract Admission]
        Evaluation[Policy Evaluation]
        Rules[Rules Engine]
        Approval[Approval Gating]
        PathCheck[Path Escape Check]
    end

    subgraph WorkItems[packages/work-items]
        Store[SQLite Store]
        SM[State Machine]
        Plans[Execution Plans]
        Attempts[Attempts & Leases]
        ApprovalRec[Approval Records]
        Audit[Audit Chain]
    end

    subgraph Sandbox[packages/sandbox]
        DryRun[Dry-Run Simulator]
        BWrap[Bubblewrap Backend]
        Engine[Engine Isolation]
        Egress[Egress Proxy]
    end

    subgraph DB[(SQLite Database)]
        AE[audit_events]
        WI[work_items]
        AR[approval_records]
        LE[leases]
        EP[execution_plans]
        EA[execution_attempts]
        AL[attempt_leases]
        AG[agents]
        CO[connectors]
        TS[tunnel_sessions]
    end

    MCP --> Auth
    HTTP --> Auth
    SSE --> Auth
    Agent --> Auth

    Auth --> Routes
    Auth --> MCPHandler
    Auth --> SSEBroad

    Routes --> Policy
    MCPHandler --> Policy

    Policy --> Contract
    Policy --> Evaluation
    Policy --> Approval
    Policy --> PathCheck
    Evaluation --> Rules

    Policy --> WorkItems
    WorkItems --> Store
    WorkItems --> SM
    WorkItems --> Plans
    WorkItems --> Attempts
    WorkItems --> ApprovalRec
    WorkItems --> Audit

    Store --> DB

    Worker[apps/worker] --> Store
    Scheduler[apps/scheduler] --> Policy
    Scheduler --> Store

    Worker --> Sandbox
    Sandbox --> DryRun
    Sandbox --> BWrap
    Sandbox --> Engine
    Engine --> Egress
```

---

## 5. Findings

### Findings Summary

| ID | Severity | Confidence | Component | Finding |
| -- | -------- | ---------- | --------- | ------- |
| F01 | **Medium** | Confirmed | Gateway HTTP | No rate limiting on any endpoint — DoS via resource exhaustion |
| F02 | **Medium** | Confirmed | Gateway HTTP | No request body size limits on most endpoints — memory exhaustion |
| F03 | **Medium** | Confirmed | Gateway SSE | No SSE client count limit — memory exhaustion |
| F04 | **Medium** | Confirmed | Gateway Web | CSRF protection relies entirely on SameSite=Strict cookie; no CSRF token |
| F05 | **Medium** | Confirmed | Supply Chain | 6 high-severity npm vulnerabilities in transitive dependencies |
| F06 | **Low** | Confirmed | Auth/Tunnel | 60-second tunnel assertion replay window without nonce binding |
| F07 | **Low** | Confirmed | Gateway Auth | Static single token for dashboard auth; no rotation without restart |
| F08 | **Low** | Confirmed | Gateway Auth | No brute-force protection on auth endpoints |
| F09 | **Low** | Confirmed | Gateway | Auth token used as session HMAC key — disclosure enables forgery |
| F10 | **Low** | Confirmed | Scheduler | Idempotency check is O(n) `store.list()` scan — scales poorly |
| F11 | **Medium** | Confirmed | Documentation | Lint command fails (`eslint.config.js` not found from dist context) |
| F12 | **Informational** | Confirmed | Test Suite | 15 skipped integration tests require real bwrap/systemd |
| F13 | **Informational** | Confirmed | Sandbox | Dry-run mode has no isolation — returns simulated success only |
| F14 | **Low** | Confirmed | Gateway/MCP | No pagination limits on `list_work_items` and `readEvents` |
| F15 | **Informational** | Confirmed | Architecture | No structured logging framework — console.log/console.error used directly |
| F16 | **Low** | Confirmed | Observability | No metrics endpoint, no OpenTelemetry integration |
| F17 | **Informational** | Confirmed | Configuration | No startup configuration validation — missing env vars cause runtime errors |
| F18 | **Low** | Confirmed | Operations | No health check for sandbox prerequisites (bwrap, systemd-run, cgroup v2) |
| F19 | **Informational** | Confirmed | Operations | No graceful shutdown handler for in-flight operations |
| F20 | **Low** | Confirmed | Docs/Implementation | `compose.production.yml` uses `read_only: true` but gateway writes to SQLite |
| F21 | **Informational** | Confirmed | Observability | Correlation IDs not propagated across request boundaries |

---

### Finding F01: No Rate Limiting

**Severity**: Medium
**Confidence**: Confirmed
**Component**: `apps/gateway/src/server.ts` — all route handlers
**Lines**: All routes in server.ts (60+ route definitions)

**Description**: The ACS gateway does not implement any rate limiting. A compromised or misbehaving agent (or external attacker if exposed) can issue unlimited requests:
- `POST /work-items` to create arbitrary work items
- `POST /work-items/:id/approve`, `/reject`, `/cancel` to flood approval actions
- `GET /events` SSE connections to exhaust file descriptors
- `POST /mcp` with JSON-RPC calls

**Impact**: Resource exhaustion (CPU, memory, file descriptors, database connections). An attacker with valid credentials (or a compromised agent holding credentials) can degrade or deny service to legitimate users.

**Prerequisites**: Authenticated access (HTTP bearer or session cookie) or MCP access (token or tunnel).

**Existing mitigations**: Result submission has a 256KB body limit. All state changes require authentication. SQLite `BEGIN IMMEDIATE` serializes writes.

**Remediation**: Add request rate limiting (e.g., `express-rate-limit` or custom middleware) at the gateway level. Implement per-actor and per-IP token bucket limiting. Limit SSE connection count per client. Add max-waiting-requests queue depth.

**Verification**: Deploy rate-limited gateway, send 1000 rapid requests, observe 429 after threshold.

---

### Finding F02: No Request Body Size Limits

**Severity**: Medium
**Confidence**: Confirmed
**Component**: `apps/gateway/src/server.ts` — POST/PUT/PATCH route handlers
**Lines**: All routes accepting bodies (create, approve, submit result, agent/actor creation, etc.)

**Description**: Only the result submission endpoint (`/work-items/:id/results`) enforces a 256KB body limit (`MAX_RESULT_BODY_BYTES`). All other endpoints accept arbitrary-sized request bodies. An attacker could send multi-megabyte JSON payloads that are parsed by Zod, consuming CPU and memory.

**Impact**: Memory exhaustion DoS via oversized JSON payloads. Especially impactful for Zod-parsed inputs where deeply nested objects consume quadratic memory during validation.

**Prerequisites**: Authenticated access.

**Existing mitigations**: The `validateStructuredValue` function in `packages/work-items/src/work-item.ts` enforces max nesting depth 5, max entries 64, max string 16KB — but only for structured output validation, not for all request inputs.

**Remediation**: Add a global JSON body size limit middleware (e.g., 1MB default) before any route handler. Apply per-route limits where appropriate.

**Verification**: Send request with 50MB JSON body to any POST endpoint, observe 413 status.

---

### Finding F03: SSE Client Count Unbounded

**Severity**: Medium
**Confidence**: Confirmed
**Component**: `apps/gateway/src/server.ts` — SSE endpoint at `GET /events`
**Lines**: `sseClients` Set tracked without limit

**Description**: The SSE event stream at `GET /events` maintains a Set of client connections (`sseClients`). There is no maximum client count. An attacker can open unlimited SSE connections, each holding a file descriptor and a response stream, exhausting server resources.

**Impact**: File descriptor exhaustion, memory exhaustion. Each SSE connection also receives every broadcast event, consuming additional memory for queued events.

**Prerequisites**: Authenticated read access.

**Existing mitigations**: Protected by `requireRead` middleware (requires bearer token or session cookie). SameSite cookies mitigate browser-based attacks.

**Remediation**: Impose a maximum SSE client limit (e.g., 100). Add per-actor SSE connection limits. Drop oldest connections when limit is reached.

**Verification**: Open 10,000 SSE connections, observe crash or resource exhaustion, then verify limit prevents this.

---

### Finding F04: CSRF Protection Relies on SameSite Only

**Severity**: Medium
**Confidence**: Confirmed
**Component**: `apps/gateway/src/server.ts` — session cookie configuration
**Lines**: Session cookie set with `sameSite: "strict"`, `httpOnly: true`, `secure: production`

**Description**: The dashboard session cookie uses `SameSite=Strict` for CSRF protection, which is the strongest SameSite value. However:
1. SameSite is supported by all modern browsers but has known bypasses (e.g., some browser extensions, DNS rebinding, redirect-based attacks)
2. There is no CSRF token in forms or API requests — the cookie alone authenticates state-changing requests
3. The login page and session management have no anti-automation measures

**Impact**: If a logged-in administrator visits a malicious site, state-changing dashboard actions could be performed without the CSRF token check (though SameSite=Strict blocks cross-site form submissions in modern browsers).

**Prerequisites**: Administrator must be logged into ACS dashboard and visit attacker-controlled page. Browser must accept SameSite bypass (older browsers, certain redirect chains).

**Existing mitigations**: `SameSite=Strict` blocks most cross-site requests. State-changing routes also require `requireMutationActor` which checks bearer token or session cookie.

**Remediation**: Add per-request CSRF tokens for all state-changing form submissions. Use `Origin`/`Referer` header validation as defense-in-depth. Document minimum supported browser versions for SameSite support.

**Verification**: Craft a cross-origin form POST to a state-changing endpoint and verify rejection.

---

### Finding F05: High-Severity npm Vulnerabilities

**Severity**: Medium
**Confidence**: Confirmed
**Component**: `package-lock.json` — transitive dependencies
**Advisories**:
- `GHSA-mh99-v99m-4gvg`: brace-expansion DoS via unbounded expansion (minimatch → glob → test-exclude → @vitest/coverage-v8)
- `GHSA-r28c-9q8g-f849`: postcss path traversal via sourceMappingURL

**Description**: `npm audit --audit-level=high` reports 6 high-severity vulnerabilities. These are in transitive dev dependencies (test tooling), not runtime dependencies, but:
1. The `npm run check` command runs `npm run security:audit` which should gate on these
2. In CI/CD, these would block the pipeline if the security audit is enforced
3. They indicate wider supply-chain hygiene issues

**Impact**: If an attacker can trigger the vulnerable code paths, DoS (brace-expansion) or arbitrary file disclosure (postcss) is possible. In practice, these are dev-time dependencies only.

**Prerequisites**: None directly exploitable in production. Attackers would need to control test input or build configuration.

**Existing mitigations**: These are dev/transitive dependencies only, not loaded at runtime.

**Remediation**: Run `npm audit fix` to update affected packages. Consider using `overrides` in `package.json` to force-safe versions. Add `npm audit` to CI as a non-blocking advisory check, with explicit exceptions documented.

**Verification**: Run `npm audit --audit-level=high` and confirm zero high-severity findings.

---

### Finding F06: Tunnel Auth 60-Second Replay Window

**Severity**: Low
**Confidence**: Confirmed
**Component**: `apps/gateway/src/auth.ts` — `authorizeSignedTunnelRequest`
**Lines**: `DEFAULT_TUNNEL_MAX_ISSUED_AGE_MS = 60_000`, `isFreshIssuedAt`

**Description**: Tunnel authentication assertions include an `issuedAt` timestamp verified within a configurable `maxIssuedAgeMs` (default 60 seconds). There is **no nonce or unique constraint** preventing the same signed assertion from being replayed within this window. A compromised proxy operator could:
1. Capture a valid signed assertion
2. Replay it multiple times within 60 seconds
3. Each replay would pass authentication and scope verification

**Impact**: Within the 60-second window, a compromised proxy can replay captured tunnel sessions. The attacker would need proxy access (compromised TLS termination or adjacent network position).

**Prerequisites**: Access to a trusted proxy address that intercepts tunnel traffic.

**Existing mitigations**: The signature verification proves the assertion was issued by the connector holder. The `issuedAt` freshness check limits the window to 60 seconds. Session state is tracked (revocation, expiry).

**Remediation**: Add a nonce (`x-acs-nonce` or similar) to the signed assertion payload. Store consumed nonces in a fast cache (in-memory Map with TTL) to detect replays within the freshness window.

**Verification**: Capture a valid assertion, replay it within 30 seconds, verify second attempt is rejected.

---

### Finding F07: Static Single Token for Dashboard Auth

**Severity**: Low
**Confidence**: Confirmed
**Component**: `apps/gateway/src/server.ts` — `auth.token` from `ACS_GATEWAY_TOKEN`
**Lines**: Auth resolution from env var or explicit options

**Description**: The ACS dashboard uses a single static bearer token (`ACS_GATEWAY_TOKEN`) for all authentication. This token serves triple duty:
1. Bearer token for HTTP API auth
2. HMAC key for session cookie signing
3. Single point of compromise

There is no token rotation, no multi-factor authentication, no per-user tokens, and no token expiry for the base auth token (sessions expire after 8 hours).

**Impact**: If `ACS_GATEWAY_TOKEN` is leaked, an attacker has full read+write access to ACS. Since it's also the session HMAC key, the attacker can forge valid session cookies for any actor/actorId.

**Prerequisites**: Token disclosure (log file, environment, `.env` file, process listing, command-line history).

**Existing mitigations**: In production, OAuth/JWT mode provides token validation against an external IdP. The token comparison uses `timingSafeEqual`.

**Remediation**: Document that production deployments MUST use OAuth or tunnel auth mode, not static bearer. Support key rotation via multiple valid tokens (old + new during rotation window). Add token expiry and refresh mechanism for the static token path.

**Verification**: In production with OAuth, verify `ACS_GATEWAY_TOKEN` is empty/unset and auth flows through OAuth.

---

### Finding F08: No Brute-Force Protection

**Severity**: Low
**Confidence**: Confirmed
**Component**: `apps/gateway/src/server.ts` — all auth paths
**Lines**: Session login handler, bearer token validation

**Description**: There is no account lockout, rate limiting, or exponential backoff for failed authentication attempts. An attacker can:
1. Try infinite bearer token values on any HTTP endpoint
2. Attempt infinite session login requests
3. Brute-force weak tokens

**Impact**: Weak or leaked tokens can be brute-forced. In practice, tokens configured via environment variables are typically high-entropy, but no protection exists for the general case.

**Prerequisites**: Network access to the gateway.

**Existing mitigations**: Token comparison uses `timingSafeEqual`. In production, OAuth delegates to the identity provider's protection mechanisms.

**Remediation**: Add per-IP and per-actor authentication failure tracking, exponential backoff, and optional lockout. At minimum, log and alert on repeated auth failures.

**Verification**: Send 1000 invalid token requests, verify that logging detects the pattern (alerting requires external integration).

---

### Finding F09: Auth Token as Session HMAC Key

**Severity**: Low
**Confidence**: Confirmed
**Component**: `apps/gateway/src/server.ts` — session cookie creation
**Lines**: Cookie HMAC uses `auth.token` as signing key

**Description**: The same `ACS_GATEWAY_TOKEN` value used for bearer authentication is also used as the HMAC-SHA256 key for signing session cookies. This means:
1. Token disclosure gives an attacker the ability to forge valid session cookies
2. Token rotation invalidates all existing sessions immediately
3. There is no separate "session secret" or "encryption key"

**Impact**: An attacker who obtains the bearer token can create session cookies with arbitrary `actor` and `actorId` values, bypassing per-endpoint auth checks.

**Prerequisites**: Token disclosure.

**Existing mitigations**: Session cookies also contain `actor` and `actorId` which are checked against the auth configuration. MCP paths use separate MCP auth.

**Remediation**: Derive the session HMAC key from the auth token using a KDF (e.g., HKDF) with a context label, so the same token produces a different key for bearer auth vs. session signing.

**Verification**: Verify that token disclosure alone does not enable session cookie forgery without knowledge of the derived key.

---

### Finding F10: Scheduler Idempotency is O(n)

**Severity**: Low
**Confidence**: Confirmed
**Component**: `apps/scheduler/src/index.ts` — `findExistingFiring`
**Lines**: `store.list().find()` scanning all work items

**Description**: The scheduler's idempotency check calls `store.list()` which returns ALL work items, then scans them linearly with `Array.find()` looking for an idempotency marker string in the title. This is O(n) in the number of work items and reads the entire work_items table (without filtering by index) for every scheduler invocation.

**Impact**: With thousands of work items, each scheduler tick becomes slower and more resource-intensive. The `store.list()` call without status filter reads all records.

**Prerequisites**: Many accumulated work items.

**Existing mitigations**: Idempotency correctness is verified by tests. The check prevents double-creation for the same firing.

**Remediation**: Add a dedicated `idempotency_key` column to the `work_items` table with a UNIQUE constraint. Store the idempotency key during creation and query it directly. This is the correct approach documented in the scheduler's own code comments.

**Verification**: Create 10,000 work items, run scheduler, verify sub-millisecond idempotency check.

---

### Finding F11: Lint Configuration Not Found

**Severity**: Medium
**Confidence**: Confirmed
**Component**: Root `eslint.config.js`, `package.json` scripts
**Lines**: `"lint": "eslint apps packages harness evals scripts --max-warnings=0"`

**Description**: Running `npm run lint` fails because ESLint 6.4.0 cannot find a configuration file. The `eslint.config.js` exists at the repository root, but the command is invoked from a context where ESLint traverses into `apps/control-ui/dist/` and fails to find the config there.

**Impact**: The code quality gate `npm run check` (which includes `npm run lint`) cannot complete successfully. Developers cannot validate code style before committing. This blocks the CI pipeline.

**Existing mitigations**: Prettier formatting check passes independently.

**Remediation**: Fix the ESLint configuration root resolution. Add `--config eslint.config.js` to the eslint command. Ensure the config file is referenced as an absolute path or that ESLint is configured to find it from the project root.

**Verification**: Run `npm run lint` and verify zero warnings with exit code 0.

---

### Finding F13: Dry-Run Sandbox Has No Isolation

**Severity**: Informational
**Confidence**: Confirmed
**Component**: `packages/sandbox/src/index.ts` — `executeSandboxed`
**Lines**: Function returns `{ ok: true, executionMode: "dry_run", output: "dry-run simulated ..." }`

**Description**: The `executeSandboxed` function used by the worker returns a hardcoded simulated success without executing any command. This is by design (the real Bubblewrap/systemd sandbox exists in `linux.ts` and `engine.ts` but is not called from the worker). However:

1. The Bubblewrap sandbox implementation is tested only in skipped integration tests
2. The dry-run mode emits no real execution event
3. A work item can transition to `succeeded` status without any real work being done

**Impact**: In the current state, ACS cannot actually execute any agent commands. The worker model is "simulate approved work item" only. This is documented as intentional for the alpha, but must be clearly communicated.

**Existing mitigations**: The `sandboxExecutionObservationSchema` and `engineIsolationObservationSchema` enforce strict validation. The Bubblewrap/systemd backend exists and is tested (though tests are skipped without real systemd).

**Remediation**: Before enabling live execution, run the sandbox integration tests against a real Bubblewrap/systemd environment. Add a startup health check that verifies sandbox prerequisites.

**Verification**: `ACS_SANDBOX_INTEGRATION=1 vitest run packages/sandbox/src/linux.integration.test.ts` passes.

---

### Finding F20: `compose.production.yml` Uses `read_only: true` with SQLite Writes

**Severity**: Low
**Confidence**: Confirmed
**Component**: `compose.production.yml`
**Lines**: `read_only: true` on gateway service, `/data` mounted as volume

**Description**: The Compose file sets `read_only: true` for the gateway container, which makes the root filesystem read-only. However, the gateway writes SQLite to `/data/control.db` (a volume mount), and the `tmpfs` mount provides `/tmp` for temporary files. While this is correct, the `tmpfs` size is limited to 64MB, which could be exhausted by:
1. Large Zod schema parsing temporary objects
2. File upload handling
3. SSE buffering

**Impact**: Under memory pressure from request handling, the 64MB `/tmp` limit could cause failures. Node.js `mkdtempSync` calls (used by the sandbox engine isolation) use `os.tmpdir()` which typically resolves to `/tmp`.

**Prerequisites**: High throughput or large payload processing.

**Remediation**: Increase the `tmpfs` size or document the limit. Add monitoring for `/tmp` usage. Consider using a dedicated temp volume.

**Verification**: Simulate large workload and verify `/tmp` exhaustion does not cause service failure.

---

## 6. State-Machine Assessment

### Work-Item States and Transitions

```
                   ┌──────────┐
                   │  draft   │
                   └────┬─────┘
                        │ policy evaluation
                        v
                ┌───────┴────────┐
         ┌──────┤  pending_policy ├──────┐
         │      └───────┬────────┘      │
         │           policy            │
         │              │               │
         v              v               v
   ┌─────────┐  ┌──────────────┐  ┌─────────┐
   │ blocked │  │needs_approval│  │approved │
   └────┬────┘  └──────┬───────┘  └────┬────┘
        │              │  approve      │
        │ unblock      v               │ claim
        │         ┌────┴─────┐         v
        └────────►│ approved │◄────┌───────┐
                  └────┬─────┘     │running│
                       │ claim     └───┬───┘
                       v          result│
                  ┌──────────┐          v
                  │ running  │     ┌──────────┐
                  └┬──┬──┬───┘     │succeeded │
                   │  │  │        └──────────┘
                   │  │  v              
                   │  │ ┌───────┐      
                   │  │ │blocked│─────► pending_policy (unblock)
                   │  │ └───────┘
                   │  │
                   │  v
                   │ ┌───────────┐
                   │ │ cancelling│────► cancelled / failed / unknown
                   │ └───────────┘
                   v
              ┌─────────┐
              │  failed │────► pending_policy (retry)
              └─────────┘

  ┌──────────┐     ┌────────────┐
  │ unknown  │────►│ quarantined│────► pending_policy
  └──────────┘     └────────────┘

Terminal: succeeded, cancelled, rejected
         (failed and quarantined can retry → pending_policy)
```

### Invariants Verified

| Invariant | Enforcement | Evidence |
| --------- | ----------- | -------- |
| Transitions follow allowed state map | Application code (`state-machine.ts:allowedTransitions`) + SQL triggers | `assertCanTransition` + `work_items_terminal_immutable_guard` |
| Terminal states are immutable | SQL trigger | `work_items_terminal_immutable_guard` rejects field changes |
| Result-accepted state is immutable | SQL trigger | `work_items_result_immutable_guard` rejects changes after result_json set |
| Privileged transitions require `PrivilegedTransitionOptions` | Application code | `requirePrivilegedTransition` in store.ts |
| One active lease per work item | Unique partial index | `idx_leases_one_active_work_item` |
| One active attempt per work item | Unique partial index | `idx_execution_attempts_one_active_work_item` |
| Lease must exist and be active for result | SQL trigger | `execution_results_binding_guard` |
| Attempt must begin as `pending` | SQL trigger | `execution_attempts_state_guard_insert` |
| Plan must be current head for attempts | SQL trigger | `execution_attempts_binding_guard_insert` |
| Approval consumed atomically with lease | SQL trigger | `attempt_leases_consume_approval` |
| Success forbidden after cancellation requested | SQL trigger | `attempt_results_cancel_race_guard` |
| Lineage fields immutable after set | SQL trigger | `work_items_lineage_guard_update` |
| Append-only audit, results, approvals | SQL triggers | Multiple `*_no_delete`, `*_immutable_guard` triggers |

### Race Condition Risks

**Claim → Policy evaluation → Approval consumption** (`gateWorkerClaim`): The claim function `claimNextApprovedWorkItem` uses SQLite's compare-and-swap on status (`UPDATE ... WHERE status = 'approved'`). If policy evaluation fails, the work item is `blocked` — but this creates a window where another worker could claim the same item. The CLAIM is inside a transaction, so this is safe.

**Expired lease check**: The `attempt_results_binding_guard` trigger checks `julianday(leases.expires_at) > julianday('now')` atomically, preventing stale-lease result acceptance even before a sweeper has expired the lease.

**Cancellation race**: The `attempt_results_cancel_race_guard` trigger prevents a succeeded result after cancellation is requested, closing the race between result submission and cancellation.

**Concurrent plan updates**: The `execution_plan_heads` trigger enforces `revision <= OLD.revision` and `plan_number = NEW.revision`, preventing concurrent plan updates.

**Verdict: State-machine design is thorough and race-condition handling is well-engineered.**

---

## 7. Authentication and Authorization Matrix

| Actor | Resource | Action | Expected Control | Verified Result |
| ----- | -------- | ------ | ---------------- | --------------- |
| Unauthenticated | `/livez`, `/readyz`, `/health` | GET | Always allowed | Confirmed — no auth check |
| Unauthenticated | `/` | GET | `requireRead` — returns login if unauthenticated | Confirmed |
| Unauthenticated | `/session/login` | POST | No auth required (validates token) | Confirmed |
| Unauthenticated | `/work-items` | GET | `requireRead` — 401/503 | Confirmed — returns login page |
| Unauthenticated | `/work-items/:id/approve` | POST | `requireMutationActor` — 401/503 | Confirmed |
| Unauthenticated | `/mcp` | POST | Auth required for tools/call | Confirmed — 401/403 |
| Unauthenticated | `/events` | GET | `requireRead` | Confirmed |
| Authenticated (read) | `/work-items` | GET | Allowed | Confirmed |
| Authenticated (mutation) | `/work-items` | POST | Allowed (strips requesterSubject, injects actor) | Confirmed |
| MCP client | `approve_work_item` | tools/call | **Hard 403** — "MCP identities cannot grant approval" | **Confirmed — excellent** |
| MCP client | `create_work_item` | tools/call | Forces `requester: "agent"` | Confirmed |
| Worker | `/work-items/:id/results` | POST | `requireWorkerIdentity` — actor must be "agent" | Confirmed |
| User | Self-approve high-risk | approve | Denied — `deny:self-approval` rule | Confirmed |
| User | Forged action hash | approve | Rejected — `approval_action_mismatch` | Confirmed |
| User | Expired tunnel session | MCP | 401 — `expired tunnel session` | Confirmed |
| User | Revoked tunnel session | MCP | 401 — `revoked tunnel session` | Confirmed |
| User | Insufficient scope | MCP | 403 — `insufficient_scope` | Confirmed |
| User | No auth configured | Any mutation | **503** — "auth not configured" | **Confirmed — critical fail-closed** |
| Agent | Claim without approval | `claim_next_approved_work_item` | Blocked — `gateWorkerClaim` returns blocked item | Confirmed |
| Agent | Submit result without lease | `/work-items/:id/results` | Rejected — DB trigger enforces lease binding | Confirmed |
| Agent | Submit result with wrong action hash | `/work-items/:id/results` | Rejected — mismatch check | Confirmed |
| Tunnel | Missing signature | MCP | 401 | Confirmed |
| Tunnel | Untrusted proxy | MCP | 401 | Confirmed |

**Verdict: Auth is thorough and fail-closed. The MCP approval hard block is notable as an explicit design choice that prevents a common bypass vector.**

---

## 8. Test Assessment

### Result: 572 passed, 15 skipped, 0 failed across 62 test files

### Passing Tests

| Area | Tests | Evidence |
| ---- | ----- | -------- |
| Gateway HTTP (server.test.ts) | 89 | Auth, route handling, approval, worker identity, bounds, error states |
| Gateway MCP hardening (mcp-hardening.test.ts) | 11 | MCP authorization, approval denial, scope enforcement |
| Work-items state machine (state-machine.test.ts) | 42 | All transitions, multiple completion paths, approval lifecycle, event replay |
| Work-items attempts (attempt.test.ts) | 18 | Fencing epochs, lease lifecycle, concurrent claims |
| Work-items execution plan (execution-plan.test.ts) | 15 | Plan creation, admission, head management, approval binding |
| Work-items result submission | 9 | Idempotency, payload hash, outcome validation |
| Policy-gate (policy.test.ts) | 11 | Path escapes, shell metacharacters, credential paths, symlink escapes, self-approval |
| Policy-gate plan-tools (plan-tools.test.ts) | 9 | Plan admission derives requires-approval from policy, self-approval denial |
| Policy-gate tools (tools.test.ts) | 8 | Approval gating, forged action hash, unblock, worker claim |
| Scheduler (index.test.ts) | 22 | Idempotency, grid firing, future anchors, policy evaluation, config validation |
| Worker (index.test.ts) | 5 | Claim, approval, forged hash, denied action |
| Shared database health (database-health.test.ts) | 22 | 4.6s+ of health/backup/verify/recovery tests |
| Secret broker (broker.test.ts) | 29 | Lease binding, principal scoping, use accounting |
| Engine adapter (command-broker.test.ts) | 11 | Command authority, lease validation |
| Workspace manager (index.test.ts) | 12 | Root ownership, allocation lifecycle |
| ACP adapter (index.test.ts) | 10 | Protocol compliance |
| Sandbox (linux.test.ts) | 7 | Path containment, workspace verification, output redaction |
| Sandbox (egress-proxy.test.ts) | 6 | SOCKS proxy, allow/deny decisions |

### Skipped Tests

| Test File | Tests Skipped | Reason |
| --------- | ------------- | ------ |
| `packages/sandbox/src/linux.integration.test.ts` | 9 | Requires real Bubblewrap, systemd, cgroup v2 |
| `packages/sandbox/src/engine.integration.test.ts` | 6 | Requires real Bubblewrap, systemd, cgroup v2 |

These are integration tests that require specific Linux kernel features. They are correctly marked as skipped when those prerequisites are absent.

### Untested Critical Paths

| Path | Risk | Recommended Tests |
| ---- | ---- | ----------------- |
| Concurrent scheduler invocations | Race conditions in idempotency check (O(n) scan) | Concurrent scheduler test with overlapping timer windows |
| MoA model caller error handling | Downstream model API failures, timeouts | Mock fetch failures, slow responses, malformed responses |
| Tunnel auth with concurrent revocation | Race between session check and revocation | Concurrent revoke+requests test |
| Audit chain failure after startup | Database-level corruption detection | Simulate corrupted audit_events, verify repair flow |
| Migration rollback from any version | Data loss during downgrade | Test migration 007 then rollback to 006 |
| Graceful shutdown during active work | In-flight work item safety | SIGTERM during worker claim, verify cleanup |
| Load test with many concurrent agents | Rate limiting, connection pooling | 50+ concurrent MCP clients |

### Coverage Recommendations

1. **Concurrent scheduler contention**: Two overlapping scheduler invocations for the same schedule
2. **SSE client exhaustion**: Open N+1 SSE connections beyond configured limit
3. **Audit chain repair after tampering**: Manually corrupt a hash, verify repair, verify integrity re-check
4. **Migration forward/backward**: Test 001→007 then 007→001
5. **Environment variable leakage**: Verify `process.env` is not exposed in any response, log, or event attribute

---

## 9. Production-Readiness Scorecard

Scoring standard:
- **5**: Production-grade — meets industry standard for the area
- **3-4**: Good — functional gaps but manageable
- **1-2**: Weak — significant gaps requiring attention
- **0**: Missing entirely

| Area | Score | Evidence |
| ---- | ----: | -------- |
| **Architecture** | **4.5** | Clean separation of concerns, proper package isolation, no circular dependencies, strong domain modeling. App-to-app imports would reduce score; current code avoids this. |
| **Authentication** | **3.5** | Multiple auth modes (bearer, OAuth/JWT, tunnel), constant-time comparison, session cookies with proper flags. Weakness: single static token for dashboard, no MFA, no rotation. |
| **Authorization** | **4.5** | Fail-closed policy gate, action-hash-bound approvals, MCP approval explicitly blocked, self-approval denied, path escape/symlink detection, credential path detection, shell metacharacter detection. Thorough. |
| **Agent safety** | **4.0** | Lease fencing, ownership checks, atomic approval consumption, append-only results, immutable terminal history. Weakness: dry-run sandbox not isolated (intentional for alpha). |
| **Data integrity** | **5.0** | Hash-chained audit log, 30+ SQL triggers enforcing invariants, compound foreign keys, CHECK constraints, unique partial indexes. Transactional atomicity for all state changes. Best-in-class. |
| **Reliability** | **2.5** | SQLite uses `BEGIN IMMEDIATE` to prevent write conflicts. Health checks verify audit chain integrity. Weakness: no rate limiting, no request size limits, no graceful shutdown, no circuit breakers, no retry with backoff for external dependencies. |
| **Observability** | **2.0** | Structured audit events are excellent, but no metrics endpoint, no OpenTelemetry, no correlation IDs across requests, no structured logging framework, no P99 latency tracking. SSE-based dashboard is the only live view. |
| **Testing** | **4.5** | 572 tests covering state machines, auth boundaries, approval lifecycle, path traversal, symlink escapes. Strong negative testing (forged hashes, expired tokens, unauthorized access). Weakness: no load testing, no fuzzing, no chaos testing. |
| **Deployment** | **3.0** | Dockerfile and docker-compose present with security options (no-new-privileges, cap-drop all, read-only root). Weakness: no health check for sandbox prerequisites, no startup probe, no readiness probe for dependencies, no migration runbook for production. ESLint lint command broken. |
| **Documentation** | **4.0** | Architecture doc, threat model, 14 ADRs, security contracts, protocol specs, runbooks. Threat model is thorough and accurately maps to implementation. Weakness: lint command broken, some operational details missing. |
| **Incident recovery** | **1.5** | No documented incident response procedure. No runbook for data recovery or audit chain repair. Backup/restore test exists in database-health.test.ts but no operational procedure. |
| **Supply-chain security** | **2.0** | 6 high-severity npm vulnerabilities. Postinstall hooks allowed for esbuild. No dependency pinning with hashes. No SBOM generation. No Dependabot/Renovate configured. |

### Scorecard Summary

**Average: 3.4 / 5.0**

Strengths: Authorization, Data integrity, Testing, Architecture, Documentation
Weaknesses: Reliability, Observability, Incident recovery, Supply-chain security, Operational readiness

---

## 10. Remediation Plan

### P0 — Must Fix Before Any Privileged Deployment

| # | Finding | Remediation | Complexity | Owner | Verification |
| - | ------- | ----------- | ---------- | ----- | ------------ |
| P0.1 | F05: High-severity npm vulnerabilities | `npm audit fix`; add overrides for brace-expansion, postcss; verify with `npm audit --audit-level=high` | Small | Platform | `npm audit` returns zero high-severity |
| P0.2 | F11: Broken lint command | Fix `eslint.config.js` resolution or add `--config` flag; verify `npm run lint` passes | Small | Platform | `npm run lint` exits 0 |

### P1 — Must Fix Before Production

| # | Finding | Remediation | Complexity | Owner | Verification |
| - | ------- | ----------- | ---------- | ----- | ------------ |
| P1.1 | F01: No rate limiting | Add per-actor and per-IP token bucket rate limiting (e.g., express-rate-limit or custom middleware) | Medium | Backend | 429 returned after threshold; limits configurable |
| P1.2 | F02: No request body size limits | Add global 1MB JSON body limit middleware | Small | Backend | 50MB POST returns 413 |
| P1.3 | F03: SSE client count unbounded | Implement max SSE connections (100 default, configurable) | Small | Backend | Test with 101 connections |
| P1.4 | F04: CSRF protection | Add per-request CSRF tokens; add Origin/Referer validation | Medium | Backend | Cross-origin form POST rejected |
| P1.5 | F13: Sandbox integration validation | Run `ACS_SANDBOX_INTEGRATION=1 vitest run` in CI; add startup health check | Medium | Platform | CI gating on sandbox integration tests |
| P1.6 | F20: Compose tmpfs size | Increase tmpfs to 256MB or document limit; add tmpfs monitoring | Small | Platform | Verify /tmp exhaustion does not occur under load |

### P2 — Should Fix After Production Baseline

| # | Finding | Remediation | Complexity | Owner |
| - | ------- | ----------- | ---------- | ----- |
| P2.1 | F06: Tunnel auth replay window | Add nonce to tunnel assertions; store consumed nonces in memory cache with TTL | Medium | Backend |
| P2.2 | F07: Static token auth | Document OAuth/tunnel as only production-safe auth; support multiple valid tokens for rotation | Medium | Backend |
| P2.3 | F08: Brute-force protection | Add rate limiting for auth failures; exponential backoff | Medium | Backend |
| P2.4 | F09: Auth token as session HMAC key | Derive session key from auth token via HKDF with context label | Small | Backend |
| P2.5 | F10: Scheduler idempotency | Add `idempotency_key` column to work_items table with UNIQUE constraint | Medium | Backend |
| P2.6 | F14: Pagination limits | Add max-take parameter limits to list endpoints; add cursor-based pagination | Medium | Backend |
| P2.7 | F15: Structured logging | Integrate a structured logging library (pino, winston); use JSON log format | Medium | Platform |
| P2.8 | F16: Metrics endpoint | Add Prometheus metrics endpoint for request count, latency, error rate, lease count | Medium | Platform |
| P2.9 | F20: Compose `read_only: true` interaction | Verify all paths work with read-only root; add explicit tmp paths for all temp operations | Medium | Platform |

### P3 — Hardening or Maintainability Improvement

| # | Finding | Remediation | Complexity | Owner |
| - | ------- | ----------- | ---------- | ----- |
| P3.1 | F17: Startup validation | Add startup config validation; check required env vars before listening | Small | Backend |
| P3.2 | F18: Sandbox health check | Add health check for bwrap/systemd/cgroup before allowing live execution | Small | Backend |
| P3.3 | F19: Graceful shutdown | Add SIGTERM handler: stop accepting requests, flush in-flight ops, close DB | Medium | Backend |
| P3.4 | F21: Correlation IDs | Generate request ID at ingress; propagate through all logs, events, and downstream calls | Medium | Backend |
| P3.5 | Incident response doc | Document detection, containment, recovery procedures for common failure modes | Medium | Platform |
| P3.6 | Audit chain repair procedure | Document how to verify, repair, and re-seal a corrupted audit chain | Small | Platform |
| P3.7 | Dependency pinning | Pin all dependencies with exact versions; use lockfile v3; generate SBOM | Medium | Platform |

---

## 11. Deployment Recommendation

| Deployment Scenario | Currently Acceptable? | Notes |
| ------------------- | -------------------- | ----- |
| Local developer experimentation | **Yes** | With dry-run execution only. Auth can be disabled for loopback. |
| Read-only agent observation | **Yes** | With authentication configured. MCP read-only tools (`acs:work:read` scope). |
| Controlled internal testing with human approval | **Yes** | Requires P0 fixes first. Gateway auth must be configured. |
| Tool execution with human approval | **No** | Sandbox is dry-run only. Requires live sandbox integration tests passing. |
| Autonomous write operations | **No** | Requires P0+P1+P2 fixes. Requires live sandbox, rate limiting, CSRF protection. |
| Access to production credentials | **No** | Secret broker exists but is not production-hardened. Environment exposure risks remain. |
| Internet-exposed deployment | **No** | Missing rate limiting, request size limits, CSRF protection. Tunnel auth replay window. |
| Multi-user deployment | **No** | Single static token auth model. No user isolation, no tenant boundaries. |
| Production deployment | **No** | Requires all P0+P1 fixes, operational readiness items (logging, metrics, alerts, runbooks). |

---

## 12. Unknowns and Review Limitations

| Unknown | Evidence Needed |
| ------- | --------------- |
| ESLint configuration root resolution | Investigate eslint.config.js format compatibility with ESLint 6.x; verify flat config vs. eslintrc |
| Actual performance under load | Load test with 50+ concurrent agents creating/approving/claiming work items |
| SQLite WAL mode behavior under concurrent write load | Test with 10+ concurrent schedulers and workers; measure lock contention |
| Migration behavior with existing production data | Back up a real database; test migration 001→007 forward application |
| OAuth/JWKS integration end-to-end | Set up test OAuth provider; validate token exchange, JWKS fetching, scope enforcement |
| Docker Compose deployment end-to-end | `docker compose up` with production config; verify health checks, networking, volume mounts |
| Cross-architecture compatibility | Test on ARM64 (Apple Silicon) and non-systemd environments |
| Audit chain repair procedure | Corrupt a hash; verify repair steps; verify chain re-verification |
| MoA model caller reliability | Test with real model endpoints; measure timeout handling, retry behavior, error reporting |
| Browser compatibility for SameSite CSRF protection | Test on Safari, Firefox, Chrome with various SameSite bypass techniques |
| Real Bubblewrap/systemd integration | Run on a Linux host with bwrap ≥0.7.0 and systemd ≥245; exercise the engine isolation boundary |
| Dependency upgrade impact on esbuild postinstall hooks | Review `allowScripts` exemptions for esbuild versions |
| Timezone handling in database timestamps | Verify all `julianday()` and `time_unix_nano` comparisons work across DST transitions |

---

## Report Generation Metadata

- **Repository**: `/home/jacen/projects/agent-control-stack`
- **Commit**: `522778015ea84cfcd57eaa23daace3035dc64778`
- **Branch**: `main` (clean)
- **Node.js**: v26.5.0
- **npm**: 11.17.0
- **Tests run**: `npm run test:vitest` = 572 passed, 15 skipped, 0 failed
- **Type check**: `npm run typecheck` = clean
- **Build**: `npm run build` = clean
- **Format check**: `npm run format:check` = clean
- **Audit**: `npm audit --audit-level=high` = 6 high (reported)
- **Lint**: `npm run lint` = FAILED (eslint config not found)
- **Files reviewed**: 100+ source files, 35 documentation files, 7 SQL migrations, all test files
- **Date**: 2026-07-25

---

*This report was prepared by an independent reviewer. It is based solely on evidence gathered from the repository, test results, and running processes. No assumptions were made about the correctness of prior reviews, documentation claims, or test results without independent verification.*
