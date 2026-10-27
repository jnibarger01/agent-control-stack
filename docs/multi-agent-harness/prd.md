# PRD: Multi-Agent Desktop Harness, Slice 1 (ACS contract + Claude Code adapter)

Status: **Proposed. Nothing in this document is implemented.** Date: 2026-10-26.
Companion documents (read together):

- [`acs-integration-contract.md`](acs-integration-contract.md): the normative boundary between the harness and ACS.
- [`claude-code-adapter.md`](claude-code-adapter.md): the first adapter.
- [`implementation-plan.md`](implementation-plan.md): ordered, verifiable tasks.
- [ADR 0029](../adr/0029-desktop-harness-is-an-acs-client.md): the decision this spec depends on.

Evidence tags used throughout: **[V]** verified by reading this checkout; **[P]** proposed, does not exist; **[U]** unverified, must be checked before relying on it.

## 0. Provenance and what this spec does not rest on

This spec turns the "Multi-Agent Desktop Harness: Architecture Review" into a repository-level plan. That review's liveness claims (Jace Commander reachable, Desktop Commander v0.3.0 online, ACS gateway HTTP 200) were **not re-verified** here. In the authoring session the `acs` and `jace-commander` MCP servers failed to connect, and no tests, builds or services were run. Everything marked [V] below comes from reading source and docs in this checkout.

Prior harness work is referenced by [`desktop-harness-slice1-assessment-20261022.md`](../desktop-harness-slice1-assessment-20261022.md) and [`desktop-harness-reconciliation-20261022.md`](../desktop-harness-reconciliation-20261022.md) [V]. Those documents describe a separate worktree (`acs-worktrees/mission-control-harness-20261021`) holding `packages/harness-contracts`, `scripts/harness-*`, four harness ADRs (numbered 0025 to 0028), and `docs/multi-agent-harness-*.md`. **That worktree is not present in this checkout [V], so none of it was read.** Consequences:

1. Claims about it (credential copy into the sandbox, bwrap host-root bind, missing `/executions/consume`) are second-hand [U]. Slice 1 treats them as _entry gates to re-verify_ (plan task T1), not as facts.
2. The assessment itself records a correction: its "consume route absent" finding was later superseded by uncommitted work in that worktree. Do not cite either state as current.
3. **ADR numbers collide.** In this checkout 0025 to 0028 are already taken by other decisions (0028 is outcome-engine verdict records [V]). The next free number here is **0029**. Prior harness ADRs must be renumbered when they land.
4. The package name `packages/harness-contracts` is used by that unmerged work. This spec uses `packages/harness-protocol` to avoid a merge collision.

Before any implementation starts, reconcile with that worktree's owner (AGENTS.md "Slice Workflow" rule 1: one writer per area).

## 1. Assumptions (correct me now or the plan proceeds on them)

1. The harness is **local, single-operator**, on the Linux host that runs ACS. Remote workers and multi-user tenancy are out of scope.
2. ACS remains the sole execution authority (ADR 0008, 0009) [V]. The harness is a client of ACS, not a second control plane.
3. The harness service is a **worker-class process** (like `apps/worker`): it holds a worker credential, claims leased work over HTTP, and launches agents. It is not an in-process extension of the gateway.
4. Slice 1 targets `claude` (Claude Code CLI) installed on the host. Its flags and output format are probed in a spike (T0) rather than assumed [U].
5. No Electron work in Slice 1. A thin CLI driver stands in for the UI so the contract can be tested without a renderer.
6. SQLite is the local harness store; ACS's SQLite hash chain stays canonical for execution state (ADR 0011) [V].
7. Node >= 24.16 and npm 11 workspaces, per `package.json` [V].

## 2. Objective

Build the smallest foundation on which a desktop multi-agent workstation can be added safely:

1. A **versioned adapter contract** (`AgentAdapter`) and a **run/event protocol** that any agent runtime can implement.
2. A normative **ACS integration contract**: how a harness run maps onto ACS work items, approvals, leases, fencing, audit and verified outcomes.
3. **One real adapter, Claude Code**, running a task end to end under ACS authority, with streaming events, approvals, cancellation, crash recovery and an honest governance label.

Users: the single operator of this ACS host, working through a CLI driver now and the desktop UI in a later phase.

Success looks like: the operator starts a Claude Code task, ACS records an approval-bound work item and lease, events stream with replay, the operator can cancel mid-run, killing the harness mid-run leaves a correct `outcome_unknown` that reconciles from ACS evidence, and the final status comes from ACS-accepted, independently verified results, never from the agent's exit code.

### Non-goals (Slice 1)

- Electron shell, renderer, Mission Control integration (Phase 1 desktop work, later).
- Multi-agent delegation, task DAGs, agent-to-agent handoff (Phase 3).
- Codex, Gemini, Hermes, local-model adapters (they must be _possible_ against the contract, not built).
- Reverse-engineering or patching Claude Desktop, or using undocumented Claude endpoints.
- A new approval UI, policy engine, audit log, or credential store. ACS owns these.
- Any widening of ACS authority (admin mode, new capability scopes) to make the harness easier.

## 3. Invariants (release blockers)

These generalize the four constraints in the architecture review and the existing ACS contracts ([`security-contracts.md`](../security-contracts.md) [V]). A task that violates one is not done.

| ID     | Invariant                                                                                                                                                                                                                                                               | Primary enforcement point                        |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| INV-1  | ACS alone decides policy, approval, lease, capability and outcome. The harness never grants, widens or infers authority.                                                                                                                                                | ACS gateway; harness has no write path to these  |
| INV-2  | No effect path around ACS. Every agent side effect is either (a) an ACS capability-bound call, or (b) happens inside a fail-closed sandbox on an isolated worktree and is _reported at that weaker governance level_. A run may not claim a stronger level than it has. | Adapter `capabilities()` + core start check      |
| INV-3  | An approval binds the exact invocation, arguments, requesting account, workspace, adapter configuration and expiry, and is single use.                                                                                                                                  | ACS approval + invocation hash (see contract §5) |
| INV-4  | An uncertain result stays `outcome_unknown` until reconciled from evidence. No automatic retry of a side-effecting step.                                                                                                                                                | Run state machine                                |
| INV-5  | The renderer and the agent process hold no execution authority and no long-lived provider credential. The lease token never leaves harness-core memory; the agent receives only a run-scoped, short-lived gate token.                                                   | Process/credential boundaries                    |
| INV-6  | Agent-side permission bypass is never authorization. If effective agent config enables a bypass (for example `--dangerously-skip-permissions`), the adapter refuses to start; it does not override or tolerate it.                                                      | Adapter preflight                                |
| INV-7  | Adapters report only what they can do. An adapter that cannot safely resume must not advertise `resume`.                                                                                                                                                                | Conformance suite                                |
| INV-8  | Success is an ACS-accepted result plus independent verification, never an exit code or the agent's own report (ADR 0024) [V].                                                                                                                                           | Core terminal-status logic                       |
| INV-9  | The harness event log is an ordered projection with gapless sequence numbers. The ACS hash-chained audit log stays canonical.                                                                                                                                           | Event log + audit references                     |
| INV-10 | Untrusted input is validated at every boundary with strict (`.strict()`) schemas: adapter output, ACS responses, persisted state on resume, renderer commands.                                                                                                          | Protocol package                                 |

## 4. Scope and requirements

### Slice 1 deliverables

| ID    | Requirement                                                                                                                                                                                                     | Acceptance (testable)                                                                                                                                          |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-1  | `packages/harness-protocol`: strict zod schemas and TypeScript types for `RunRequest`, `RunEvent`, `RunStatus`, `AgentCapabilities`, `CancelResult`, `ReconciliationResult`, plus the `AgentAdapter` interface. | Schemas reject unknown keys; golden fixtures round-trip; `npm run typecheck` clean.                                                                            |
| FR-2  | Adapter conformance suite runnable against any adapter, plus a scripted `FakeAdapter`.                                                                                                                          | FakeAdapter passes; a deliberately lying adapter (advertises `resume`, none implemented) fails.                                                                |
| FR-3  | `packages/harness-core`: durable run store and event log with gapless `seq`, opaque replay cursors, redaction before persistence.                                                                               | Replay from every cursor returns the exact suffix; a simulated crash between append and ack loses no event and duplicates none.                                |
| FR-4  | ACS client implementing the [contract](acs-integration-contract.md): create/claim/lease, approval observation, cancel, result submission, authority re-check.                                                   | Tests against a fake gateway cover each failure row in contract §9; harness never sends caller-supplied identity fields.                                       |
| FR-5  | Run state machine with `outcome_unknown` and `reconcile()`.                                                                                                                                                     | Property tests: no path from `outcome_unknown` to `succeeded` without a reconciliation record; no automatic retry edge exists.                                 |
| FR-6  | `packages/harness-claude-adapter` per [adapter spec](claude-code-adapter.md): launch, preflight, event translation, tool gating, cancel, reconcile.                                                             | Conformance suite passes; bypass-flag preflight refusal test passes; recorded-fixture translation tests pass.                                                  |
| FR-7  | Approval flow: a tool call needing approval produces `approval.requested`, blocks the agent, and proceeds only after a human approval recorded in ACS.                                                          | Integration test: argument swap after approval is denied; expired approval is denied; replayed approval is denied; the harness has no code path that approves. |
| FR-8  | Cancellation: ACS cancellation first, then process termination, with a truthful result.                                                                                                                         | Cancel mid-tool-call yields `cancelled` only when the process is verified dead and no call was in flight; otherwise `outcome_unknown`.                         |
| FR-9  | Crash recovery: on harness restart, every non-terminal run is reconciled against ACS state and process liveness.                                                                                                | Fault-injection test: `kill -9` the harness mid-run; restart; run ends in a correct terminal or `outcome_unknown` state with evidence; no orphan process.      |
| FR-10 | `apps/harness-cli`: thin driver (`run`, `events --cursor`, `cancel`, `status`, `reconcile`) with no domain logic.                                                                                               | E2E test with a fake `claude` binary through a real gateway in test mode.                                                                                      |
| FR-11 | Governance label on every run (`governed` / `acs_guarded` / `os_sandboxed` / `host_permissions`, aligned with ADR 0024) shown in CLI output and recorded in the audit event.                                    | A run never reports a label above its adapter's capability report.                                                                                             |
| FR-12 | Evidence document for Slice 1 gate, produced by running (not by reading) the security and fault-injection checks.                                                                                               | `docs/multi-agent-harness/slice-1-evidence.md` with command, output and commit for each gate.                                                                  |

### Deferred, tracked against the architecture review's phases

| Review phase           | This spec                                                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 Contracts            | **Slice 1** (FR-1, ADR 0029, contract docs)                                                                                                          |
| 1 Desktop MVP          | Slice 1 delivers the "one real adapter executes through ACS" exit condition (FR-6, FR-10). Electron, workspace manager and conversations come after. |
| 2 Execution            | Streaming, approvals, cancel and crash/reconnect are in Slice 1 (FR-3, 7, 8, 9) because they are part of the contract; UI approvals come later.      |
| 3 Multi-agent          | Not started. The contract keeps `parentRunId` and artifact handoff fields reserved (see contract §3) so Phase 3 does not break it.                   |
| 4 Production hardening | Credential broker, resource controls: partially pulled forward only as entry gates (T1).                                                             |
| 5 Advanced             | Not started.                                                                                                                                         |

## 5. Tech stack

TypeScript (strict), Node >= 24.16, ESM with `.js` import specifiers, zod ^4.6.7, Vitest, SQLite (the repo's existing driver; confirm in T4) [V per `packages/engine-adapter/package.json`, root `package.json`]. No new third-party runtime dependency without approval (Boundaries).

## 6. Commands

Run from the repository root. Vitest globs are root-relative; running `vitest` inside a package directory finds no files [V per the Slice 1 assessment].

```
Typecheck:     npm run typecheck
Lint:          npm run lint
Unit (new):    npx vitest run packages/harness-protocol packages/harness-core packages/harness-claude-adapter
Unit (all):    npm run test:vitest
Contracts:     npm run contracts:check
Docs format:   npx prettier --check docs/multi-agent-harness docs/adr/0029-desktop-harness-is-an-acs-client.md
Preflight:     npm run pr:preflight
New slice:     npm run slice:new -- <branch>
```

`npm run format:check` enumerates specific files [V]; new source files must be added there or covered by the lint step, otherwise they are unchecked.

## 7. Project structure

```
packages/harness-protocol/        Types + strict schemas + AgentAdapter + conformance suite. No I/O.
packages/harness-core/            Run store, event log, run state machine, ACS client, reconciliation. Ports for clock, store, isolation.
packages/harness-claude-adapter/  Claude Code adapter. Depends on harness-protocol only (plus injected ports).
apps/harness-cli/                 Thin driver. Parses argv, calls harness-core, prints. No domain rules.
docs/multi-agent-harness/         This spec set + evidence.
docs/adr/0029-*.md                Authority-boundary decision.
```

Rules (AGENTS.md [V]): applications stay thin; packages never import applications. `harness-protocol` has no dependency on ACS internals. `harness-core` talks to ACS over HTTP, so it must **not** import `work-items` or `policy-gate` stores. Add an ESLint `no-restricted-imports` rule for this in T2 (existing boundary rules live in `eslint.config.js` [V]).

## 8. Code style

Match the surrounding packages: strict zod schemas, branded identifier pattern, `ControlStackError` with snake_case codes, no default-allow.

```ts
import { z } from "zod";

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const runEventSchema = z
  .object({
    runId: identifierSchema,
    seq: z.number().int().nonnegative(), // gapless per run
    cursor: z.string().min(1).max(256), // opaque to callers
    ts: z.string().datetime(),
    source: z.enum(["adapter", "acs", "harness"]),
    type: runEventTypeSchema,
    data: z.record(z.string(), z.unknown()),
    auditRef: z.object({ eventId: identifierSchema, hash: hashSchema }).strict().optional()
  })
  .strict();
```

Conventions: errors are `throw new ControlStackError("harness_<reason>", "<human message>")`; every adapter-originated value is parsed through a schema before it touches core state; no `any`; comments explain constraints and authority, not mechanics.

## 9. Testing strategy

| Level               | What                                                                                                                      | Where                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Schema / golden     | Strict-schema rejection, fixture round-trips                                                                              | `packages/harness-protocol/src/*.test.ts`           |
| Conformance         | One suite every adapter must pass; includes a lying-adapter negative                                                      | `packages/harness-protocol/src/conformance/`        |
| State machine       | Property tests over event/ACS-state interleavings; invariants INV-4, INV-8                                                | `packages/harness-core`                             |
| Adapter translation | Recorded Claude output fixtures (from T0) to `RunEvent`; unknown event types surface as warnings, never dropped           | `packages/harness-claude-adapter/src/__fixtures__/` |
| Security            | Bypass-flag refusal; credential absence in child env; approval argument-swap / expiry / replay; renderer-has-no-authority | per package                                         |
| Fault injection     | `kill -9` harness mid-run; ACS outage during result submission; orphan agent; duplicate cancel; event-log torn write      | `packages/harness-core` + `apps/harness-cli` E2E    |
| E2E                 | Fake `claude` script through a real gateway in test mode                                                                  | `apps/harness-cli/src/e2e.test.ts`                  |

Coverage expectation: new packages follow the repo's authority-coverage convention (`npm run test:authority-coverage`) [V as a script; thresholds [U], confirm in T2]. Tests are written before implementation for each task (TDD).

## 10. Boundaries

- **Always:** validate every boundary input with a strict schema; fail closed on any ACS error, schema failure or missing binding; redact before persisting or emitting; write tests first; use path-scoped `git add`; state governance level honestly; run the focused tests and `npm run typecheck` and `npm run lint` before declaring a task done.
- **Ask first:** any change under `apps/gateway`, `packages/work-items`, `packages/policy-gate`, `storage/migrations` (the ACS-side gaps G1 to G9 in the contract); any new dependency; adding or changing ESLint boundary rules; changing the `acs.jc.v1` / `acs.dc.v1` contracts; touching the other harness worktree; anything that would introduce a second approval path.
- **Never:** let the harness, renderer or agent approve, grant or widen authority; pass `--dangerously-skip-permissions` or equivalent; copy host credential files into a sandbox; retry a side-effecting step automatically; report `succeeded` from an exit code; reuse the ADR-0022 agent-run path as if it were governed (it has no lease or approval record) [V]; commit, push or open PRs without authorization (AGENTS.md).

## 11. Success criteria for Slice 1

All must be shown by running, with output recorded in `slice-1-evidence.md`:

1. Conformance suite green for `FakeAdapter` and the Claude adapter; red for the lying adapter.
2. A Claude Code run (real binary, per-task sandbox) completes through a real ACS gateway: work item approved by a human, claimed under a lease with fencing epoch, result accepted and verified, `agent_run`-style review recorded.
3. Approval negative tests pass: argument swap, replay, expiry, self-approval.
4. Cancellation mid-run: ACS state and process state agree, or the run is `outcome_unknown` with a reconcile path.
5. `kill -9` of the harness mid-run followed by restart yields a correct terminal state or `outcome_unknown`; no orphan agent process; no duplicate or missing events on replay.
6. Bypass test: an effective Claude config containing a permission bypass makes `health()` report `unsafe` and `start()` refuse.
7. Credential test: the agent process environment and mounts contain no long-lived provider credential (assertion in a test, not an inspection).
8. `npm run typecheck`, `npm run lint`, and the new vitest suites pass; no regression in `npm run test:vitest`.

## 12. Risks

| Risk                                                                                    | Mitigation                                                                                                                                     |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude CLI event format or flags differ from assumptions or change between versions [U] | T0 spike records fixtures; adapter pins an allowed version range; unknown events become warnings; version in `adapterConfigHash`               |
| ACS lacks hooks the contract needs (G1 to G9)                                           | Each gap is an explicit Ask-first ACS slice with its own tests; Slice 1 scope shrinks to what ACS supports, never to a harness-side workaround |
| Second control plane creeping in (local approvals, local policy, local audit as truth)  | ADR 0029; ESLint boundary; INV-1 tests; review checklist item                                                                                  |
| PreToolUse-style gating is a deny-list, not a sandbox (ADR 0024 says so) [V]            | Governance label stays `acs_guarded`/`os_sandboxed`; `governed` is reserved for the tool-bridge mode (M2) and must not be claimed earlier      |
| Prior unmerged harness work conflicts or duplicates                                     | Section 0; reconcile before T2; distinct package names; ADR renumbering                                                                        |
| Worker-class process holds a lease token and a worker credential                        | Held only in harness-core memory; rotation/TTL per [`worker-identity.md`](../protocol/worker-identity.md) [V]                                  |

## 13. Open questions (need a human decision)

1. **Default governance mode for the first demonstrable run.** Recommendation: M1 = `acs_guarded` + sandbox + worktree (builds on the verified ADR 0024 hook and tool-check route); M2 = `governed` tool-bridge mode (native tools off, effects via the ACS MCP bridge). Confirm, or pull M2 forward.
2. **Isolation authority.** `EngineIsolation` takes an `EngineIsolationAuthorityVerifier` bound to persisted authority records (ADR 0014) [V]. Should the harness process verify in-process against the ACS DB (worker-class, same host), or should ACS expose an HTTP verification endpoint? This decides whether `harness-core` may import `packages/sandbox`.
3. **Model credential for Claude Code.** Subscription login (host `HOME`) cannot be isolated; API key can be injected but is long-lived. INV-5 wants a scoped short-lived token via a model proxy. Is that proxy in scope for Slice 1, or is the first run API-key-in-sandbox with an explicit waiver recorded?
4. **Run identity in ACS (the most consequential decision).** The recommendation is a normal work item and attempt per harness run, which gives the real lease, fencing, approval and verification path. It needs a new plan backend (contract gap G1), and **ADR 0022 explicitly rejected adding a third backend with network access** because it changes a hash-bound authority contract. The alternative, extending ADR 0022 agent runs with leases and per-call approvals, is smaller but builds a second lease/approval system. Confirm the work-item anchor and the amendment to ADR 0022, or choose the alternative and revise ADR 0029. Phase B of the plan does not depend on this answer; Phase D and the Claude adapter's gate do.
5. **Sequencing against the other harness worktree.** Land its pending authority work (consume route, sandbox fixes) first, rebuild on it, or supersede it?
