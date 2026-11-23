# Slice-by-slice path to production

**Program:** ACS AI Factory
**Start:** F0 in this PR
**Target:** F12 production go/no-go
**Status (2026-11-18):** see [implementation-status.md](implementation-status.md) for per-slice evidence and [go-no-go.md](go-no-go.md) for the F12 decision (currently NO-GO). The MAA planning amendment recorded on PR #460 is reconciled there.
**Rule:** Every slice is a separately reviewable PR on a pinned base, with test logs, artifact hashes, owner, failure handling and rollback. Passing a downstream test cannot waive an upstream authority gate.

## Dependency map

```text
F0 contract + PRD
     |
F1 intake/auth ---- F2 mission admission/idempotency
                            |
                     F3 plan DAG + budgets
                            |
                 F4 ACS swarm transport + sidecar
                            |
                 F5 isolation + credential scopes
                            |
                 F6 lane dispatch + fencing
                            |
                 F7 evidence/independent verification
                            |
                 F8 draft PR publication
                            |
            F9 recovery / crash / cancellation
                            |
              F10 Mission Control + metrics
                            |
                F11 staged pilot / chaos
                            |
                 F12 production certification
```

F4–F7 require **coordinated changes** to `jnibarger01/codex-swarm` and ACS. A green ACS-only PR is insufficient to promote that boundary.

## Slice cards

### F0 — Product definition and non-authoritative proposal contract

**Deliver:** PRD, ADR 0030, architecture, versioned input/proposal parser, exhaustive first-pass unit tests, release plan and operator docs.

**Implementation:** Add `packages/ai-factory`; strict validation of objective/repo/base/path/budget/draft delivery; deterministic digest; no imports from gateway, worker, sandbox, policy, store, or publication. Reference package from root TypeScript project graph.

**Acceptance:** focused Vitest tests; `npm run typecheck`, `npm run lint`, `npm run check` on a clean checkout; no new server endpoints; source scan proves no spawn, network or persistence. Correctly disclose any unavailable gates. **Rollback:** revert package/docs only.

### F1 — Authenticated factory intake, preview only

**Depends:** F0.

**Implement:** ACS gateway authenticated POST preview, strict request bounds and anti-abuse, CSRF/origin handling where relevant. Bind principal from ACS auth, not body. GitHub repo and immutable ref read-only resolution. Return preview hash/constraints and refusal reason. No ACS mission created yet.

**Acceptance:** unauthorized and forged actor denied; malformed/oversized requests denied; moving/ref-drift and missing commits refused; preview and rate-limit audit evidence; 2-user isolation. **Rollback:** route feature flag off, leave existing ingress untouched.

### F2 — Mission admission, atomic idempotency and audit

**Depends:** F1.

**Implement:** Create existing `coding_missions` general or coding profile as appropriate; map intake to ACS mission, store proposal hash in authenticated audit-backed binding, atomically enforce unique (`principal`, `orderId`) semantics, preserve append-only lineage. Define stale/revision conflict behavior. No second `factory_jobs` lease store.

**Acceptance:** concurrent duplicate submissions single-create; changed payload conflict; crash between audit and mission cannot orphan invisible authority; IDOR negative tests; audit hash verifies. **Rollback:** stop admission, preserve audit/history, migrate projection safely without deleting mission records.

### F3 — Dependency planning and budget admission

**Depends:** F2.

**Implement:** Convert bounded plan into typed ACS `work units`, validate DAG acyclicity and max depth, enforce existing mission budget and execution admission on every claim. Planner may suggest decomposition, ACS validates it; cap fan-out against ACS max parallelism. Record immutable plan digest and revision lineage.

**Acceptance:** graph cycle/unknown dependency/depth overflow tests; exact budget boundary tests; deliberate unaccounted spend never read as 0; stale plan hash rejected. **Rollback:** disable planner routing, retain missions in review state.

### F4 — ACS-controlled Codex Swarm transport

**Depends:** F3, ADR 0017 review and cross-repo fixture parity.

**Implement:** Actual `CodexSwarmEngineAdapter` implementing ACS EngineAdapter, per-attempt UDS protocol `/acs/v1/*`, stable kill/reap, readiness probe, envelope hashes/HMAC, exact echo. Codex Swarm `SWARM_CONTROL_PLANE=acs` fork disables standalone operator API, approval DB/promotion and background requeue for ACS-owned work. Preserve standalone behavior separately.

**Acceptance:** UDS fixture parity at pinned ACS/Swarm commits; malformed/MAC/expired/wrong attempt/epoch rejected; no fallback to operator API; exact child-owned process termination. **Rollback:** feature flag off; ACS still runs without Swarm.

### F5 — Host-enforced isolation and scoped credentials

**Depends:** F4.

**Implement:** `EngineIsolationBackend` supports full Codex Swarm process tree, per-lane process containment, read/write mount enforcement, per-worker single credential, restricted network egress, resource quotas. Re-resolve every workspace root and artifact path before use. Never infer safety from cwd/CLI hooks.

**Acceptance:** adversarial escape tests (symlink, proc, inherited FD, mount/path, DNS redirect, env leaks), process-child kill test and no credential exfil in logs. **Rollback:** prevent dispatch; workers fail closed.

### F6 — Bounded lane scheduling and authority-fenced dispatch

**Depends:** F5.

**Implement:** Map one ACS unit/attempt to subordinate lanes. ACS owns cross-attempt scheduling. Within-attempt coordination is subordinate and budget-limited; lane overlap triggers blocked integration. Recheck attempt fence immediately before every mutating lane action. No ungoverned lane-wide approval.

**Acceptance:** 2+ concurrent lanes, overlapping edits, stale lease after renewal/revocation, CPU starvation, stop/resume, deterministic integration order; out-of-scope files refused even if tests pass. **Rollback:** cap lanes to one, disable dispatch until reconciled.

### F7 — Result validation and independent verifier

**Depends:** F6.

**Implement:** Ingest `SwarmExecutionEvidence` as untrusted, validate exact echoes and source Git tree, scan scoped diff, re-run acceptance/validation under ACS, invoke an independent non-Swarm verifier; attach hashes and fresh audit receipts. Outcome Engine verdict remains advisory only.

**Acceptance:** fabricate PASS with wrong tree; malicious success exit 0; corrupted audit hash; zero-test-result; divergent verifier; stale snapshot; all must block. Only trusted evidence can satisfy criteria. **Rollback:** quarantine results, do not publish.

### F8 — Authorized, idempotent draft PR creation

**Depends:** F7.

**Implement:** Existing `packages/publication` opens draft PR against immutable accepted candidate. Bind ACS approval/authorization to repository, target, tree, requested side effect, operator and idempotency marker. Recheck remote head and source tree just before publication. Never auto-merge or deploy.

**Acceptance:** publish replay yields one PR; unauthorized push/merge tests; target advanced or tree changed => conflict; adverse GitHub rate limit leaves recoverable uncertain state; PR body contains attested checks, provenance and rollback. **Rollback:** revoke publication capability; close errant drafts by explicit operator action, do not silently rewrite remote.

### F9 — Durable reconciliation, cancellation, revocation

**Depends:** F8.

**Implement:** Crash windows in every edge (intake, admission, dispatch, evidence, PR side effect). Reconcile attempts on boot; verify pid/start identity before killing. Unknown external effects stay `unknown`; no blind automatic replay. Worker revocation and kill hooks with fake clocks.

**Acceptance:** kill -9 at each checkpoint; restart across process boundary; no duplicate PR; late result fenced; cancellation cannot report rollback of effects it cannot prove. **Rollback:** quarantine affected missions and stop dispatch.

### F10 — Operator Mission Control and metrics

**Depends:** F9.

**Implement:** Factory backlog panel from ACS mission+audit projection, current pinned SHA, stage, budget, failed gate, proposed next action, approval queue and evidence links. Explain recommendation vs authority. Add tracing and Prometheus/OpenTelemetry metrics with redaction.

**Acceptance:** UI never invents status; two concurrent operators see consistent projection; auth/accessibility tests; test that no raw secrets appear in DOM, APIs, traces or exports. **Rollback:** disable view; no effect on ACS jobs.

### F11 — Controlled pilot, load and chaos certification

**Depends:** F10.

**Implement:** Single-host pilot under explicit repository allowlist, 1 concurrent mission then 2–4, fixed budget; fault injection, security review, backups, production config, alerts. Pin image and compatible Swarm SHA. Use representative real PR tasks and review every result manually.

**Acceptance:** sustained clean run plus injected failures and remote drift; 100% security negative cases deny; restore drill; no unaudited terminal states; actual model billing reconciled (or blocked if unknown). **Rollback:** disable intake/dispatch, revoke capabilities, stop owned children, restore pinned image; never reset audit DB.

### F12 — Production launch and release closure

**Depends:** F11 and every P0 item.

**Implement:** Complete go/no-go matrix, release notes, rollback rehearsal, evidence manifest with candidate commit IDs, owner signoff, operational SLO alarms, CI and host-level isolation gates; enable limited live traffic and observe.

**Acceptance:** `npm run check`, integration, policy, host sandbox, cross-repo and failure-injection gates all green on pinned builds; no undocumented skipped/pending tests; audited approval and disaster recovery; operator signs limited rollout. **Rollback:** disable factory feature while retaining ACS and immutable records; restoration process exercised.

## Cross-slice controls (apply to each PR)

- **Provenance:** list exact ACS + Swarm SHAs, schema version and migration sequence.
- **Authority:** draw path from authenticated principal to plan, policy, lease, capability, execution, independent verifier and publication.
- **Reversibility:** feature flag, database migration rollback semantics, preserved audit trail and rollback command.
- **Evidence:** positive + negative tests, executed command output, coverage, CI URLs, model spend receipts and known gaps.
- **Review:** independent reviewer for any expansion of tool/network/credential/publish privileges.

## Prioritization and schedule

This roadmap states order, **not dates**. F0 may merge without live execution; F4–F6 are the critical path and should not be fused into a "big bang" cutover. Each slice should be small enough to prove cleanly even though this foundational documentation PR is intentionally substantial.

