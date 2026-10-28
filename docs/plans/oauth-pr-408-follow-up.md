# PR 408 OAuth follow-up verification

Date: 2026-10-23 (America/Chicago). Release-readiness verdict: **PARTIAL**. The initial investigation and validation
were performed in an isolated clone. Publication and main-to-PR-branch integration were subsequently authorized by
the user. No history rewrite, remote review-thread resolution, PR merge into main, deployment, service restart,
credential migration, or production flag changes were performed. Test flags were used only inside disposable test processes.

## Source and custody

- PR: <https://github.com/jnibarger01/agent-control-stack/pull/408>.
- Inspected head: `e100b223fa3d54f6407a5a71413b9350f2edd63d`; all 36 changed filenames and 10 inline review threads inspected.
- The 10 threads were already resolved by the author. Their resolution does not prove the follow-up code is correct.
- GitHub reports open, draft, mergeable, with mergeable state `unstable`; its reported base is `318c27a00e4c7d6e4cf248148b8c8b14a08d56d6`.
- The clone separately fetched `origin/main` at `3266a7aa347685e1dfb1b0c6401d801d190138fe`. Baseline comparisons below use
  the PR's reported base, **not** a claim about that newer main. Reconcile base freshness before publication.
- The old `/workspace/acs-pr` checkout had a dangling Git-worktree pointer. It was left untouched. The new clone started
  with no checkout; it was checked out detached at the exact PR head and was clean before task edits.

## Findings and smallest fixes

| Finding                                  | Inspected-head evidence and follow-up                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| False expiry after successful refresh    | Still reproducible: `McpClientService.authView` and browser `mcpAuthExpired` inferred expiry from silence. A successful rotation can lose its report and have no later MCP request. Both inferences removed. Only a confirmed permanent edge refusal creates a warning.                                                                                        |
| Auth-only events mark clients live       | Server counter guard already existed. Browser `mcpIsLive` still used only time; it now also requires real activity counters.                                                                                                                                                                                                                                   |
| Stale UI expiry snapshot                 | Browser no longer creates warnings from a snapshot's old expiry. Existing auth-event SSE refresh displays confirmed failures; no proactive time-only warning is promised.                                                                                                                                                                                      |
| Out-of-order failure reasons             | Existing guard against both last-success and last-failure timestamps verified by focused tests. Grant-family selection had a separate ordering gap: now an older grant cannot switch the family before timestamp validation.                                                                                                                                   |
| Unsanitized refusal logs                 | Existing printable-ASCII, bounded `logSafe` in `server.js` and its edge regression pass. No duplicate fix added.                                                                                                                                                                                                                                               |
| Wrong-lane expiry                        | Existing issuer/audience-before-expiry classification in `classifyBearer` and edge regressions pass.                                                                                                                                                                                                                                                           |
| Short writes                             | Existing write loop handled positive short writes, but lacked a progress guard and fault-injection coverage. Extracted the same private atomic writer to `atomic-json.js`; reject zero progress. Tests prove repeated short writes finish before rename, preserve 0600 permissions, and preserve old JSON/remove temporary secrets on ENOSPC or zero progress. |
| Confidential-client authentication order | Existing secret validation before revoked/expired state in `resolveRefresh` and edge regressions pass.                                                                                                                                                                                                                                                         |
| Health shared across lanes/families      | Existing per-lane/current-family model retained. New-grant selection is ordered, superseded-family failure state is reset, familyless outcomes cannot mutate identified grants. Failure-report throttling now also keys on family, preventing an old family's refusal from suppressing the current family's failure.                                           |
| Expiry-warning eviction                  | There are no inferred-expiry warnings now. Eviction still prioritizes confirmed permanent failures; its regression now proves that supported behavior.                                                                                                                                                                                                         |

Seven gateway/UI assertions failed before these fixes and passed afterwards. A separate reporter test failed before the
family throttle change and passed afterwards. Three persistence fault tests cover short writes, zero progress and ENOSPC.
Dashboard goldens were regenerated through the snapshot test; architecture and runbooks now describe the confirmed-failure rule.

Tradeoff: expiry of an idle grant is detected on its next attributable refresh refusal. Best-effort success telemetry
cannot safely support proactive idle-expiry warnings. This patch does not add authoritative token-state reconciliation.
The existing product model tracks the newest authorization family per lane; it does not inventory concurrent sessions
or claim that a new grant revokes older tokens at the edge. Lost events can still hide warnings or recovery.

## GitHub checks: distinguish heads

At inspected head `e100b223`:

| Check                        | Verified GitHub result                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `check`                      | [Success, run 39741642491](https://github.com/jnibarger01/agent-control-stack/actions/runs/39741642491)                        |
| Vitest                       | [Success, run 39741642766](https://github.com/jnibarger01/agent-control-stack/actions/runs/39741642766)                        |
| DC suite and execution chain | [Both success, run 39741642326](https://github.com/jnibarger01/agent-control-stack/actions/runs/39741642326)                   |
| GitGuardian                  | [Failure, check 119700006099](https://github.com/jnibarger01/agent-control-stack/runs/119700006099): historical findings below |

The earlier failed `check` at `91a2a217` was inspected directly:
[run 39738471966](https://github.com/jnibarger01/agent-control-stack/actions/runs/39738471966) failed ESLint on unused
`verifyJwt`, `checkAuth`, and test parameter `req`. These were already removed before the inspected head.
Do not treat older Gmail notifications as the current commit's validation. Those remote successes predate this follow-up and do not validate its changed tree.

## Historical GitGuardian and Desktop Commander

GitGuardian incident `38845674` has two occurrences in `scripts/oauth-compat-lab.mjs`, at
`af72479efa0098a55bc3dc056e19f9f0280369bd` and `ff9b61fb827102d4ad41f7eca01000e0f2ee1f45`.
Reading those sources confirms the flagged consent passphrase is generated at runtime with `crypto.randomBytes`,
not a literal live credential. The current script calls it `consentCode`. A new fix commit cannot remove historical occurrences.
No GitGuardian dismissal or force-push was attempted; incident disposition remains a separate authorized action.

The reported historical Desktop Commander retired-audit-endpoint failure is not reproduced by the current vendor audit
gate: `npm run audit:gate` exits 0 with its existing documented node-forge exception. This patch changes neither the
vendor audit policy nor its dependencies. The current-head GitHub DC job also passed. No claim is made that an earlier
transient npm endpoint failure was fixed by OAuth code.

## Local validation

Runtime: Node 24.19.0, npm 11.9.0. Root and vendor dependencies installed with `npm ci --ignore-scripts --no-audit --no-fund`;
vendor build run explicitly. CI pins Node 24.16.0 and npm 11.17.0, so the exact CI runtime still needs its own run.

| Command / scope                                                                                            | Observed result                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                                                                                            | Exit 1. Formatting, full ESLint, root build (including TypeScript and both frontends), and dry-run release gate passed. Stopped at `contracts:check` because `tsx` CLI cannot bind `/tmp/tsx-0/*.pipe` (`EPERM`). No full-check pass claimed. |
| `node --import tsx scripts/public-contracts.ts --check`                                                    | Exit 0; five generated public-contract files current.                                                                                                                                                                                         |
| `node --import tsx scripts/dc-tool-manifest.ts --check`                                                    | Exit 0; DC artifacts verified.                                                                                                                                                                                                                |
| `node --import tsx scripts/jc-tool-manifest.ts --check`                                                    | Exit 0; JC manifest current. Import-loader invocation avoids the CLI's unrelated IPC socket.                                                                                                                                                  |
| Focused Vitest: gateway auth health/E2E/client visibility, control-ui client panel, all vercel-mcp-ingress | Exit 0; 116 passed in 10 files.                                                                                                                                                                                                               |
| `node --test apps/dc-mcp-gateway/test/{atomic-json,auth-health,auth-health-edge}.test.mjs`                 | Exit 0; 50 passed. All real edge HTTP processes use disposable data and stub upstreams.                                                                                                                                                       |
| `npx vitest run apps/control-ui/src/render-golden.test.ts -u`                                              | Exit 0; 4 passed, 3 golden files regenerated. The subsequent full Vitest run also passed these four without update mode.                                                                                                                      |
| `npm run test:dc-mcp-gateway`                                                                              | Exit 1; 137 passed, 2 failed in process-identity readiness tests. Both reproduce on the PR base; see below.                                                                                                                                   |
| Vendor `npm run build`, then `node --test test/test-jace-commander-mcp-auth.js`                            | Both exit 0; all 10 inner JC auth assertions passed.                                                                                                                                                                                          |
| `npm test`                                                                                                 | Exit 1 in its first stage (full Vitest): 5052 passed, 13 failed, 97 skipped across 402 files. Later npm-test stages did not execute through this command. OAuth-focused suites passed in this broader run too.                                |
| `node scripts/check-mission-control-e2e-gate.mjs`                                                          | Exit 0; gate configuration check only, not execution of the browser harness.                                                                                                                                                                  |
| Root `npm run security:audit`                                                                              | Exit 0 at high severity threshold; 1 low and 6 moderate advisories remain.                                                                                                                                                                    |
| Vendor `npm run audit:gate`                                                                                | Exit 0; existing documented exception, no other high/critical advisories.                                                                                                                                                                     |
| `git diff --check`                                                                                         | Exit 0.                                                                                                                                                                                                                                       |

### Baseline comparison of broad failures

An independent source export of `318c27a0` was used with the same installed dependency tree. No PR source changes were
applied to that export; root packages are unchanged by PR 408. These are comparisons against the PR base, not a second
clean dependency installation or evidence from production.

All 13 full-Vitest failing cases also fail on that export:

| File                                                    | Failing cases | Observed limitation                                                                                                                                                                   |
| ------------------------------------------------------- | ------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/workspace-manager/src/index.test.ts`          |             1 | Cross-process worktree serialization probe cannot complete its child-worker run.                                                                                                      |
| `apps/gateway/src/agent-dispatch.test.ts`               |             2 | Child process considered already exited instead of provably live; process-identity path.                                                                                              |
| `packages/coding-mission/src/verification-gate.test.ts` |             1 | Abandoned-verifier reconciliation returns `verification_run_active` instead of `verification_reconciliation_required`. Reproduced baseline failure; underlying cause not established. |
| `packages/work-items/src/trace-outbox.test.ts`          |             1 | Cross-process worker fails at `tsx` Unix-socket bind (`EPERM`).                                                                                                                       |
| `apps/scheduler/src/index.test.ts`                      |             1 | Same `tsx` Unix-socket restriction.                                                                                                                                                   |
| `packages/local-advisor/src/egress.test.ts`             |             1 | Real env-proxy `NO_PROXY` probe times out at 5 seconds.                                                                                                                               |
| `packages/sandbox/src/egress-proxy.test.ts`             |             6 | Unix-domain egress socket bind denied (`EPERM`).                                                                                                                                      |

The two broader edge-suite failures also reproduce on the base's identical test sources:
`authority-endpoints.test.mjs` cannot read its child's `/proc/<pid>/stat`, and
`bridge-ready-configured-executor.test.mjs` times out with unreadable Linux process identity. These are not OAuth
regressions. They must still pass in a suitable environment before release readiness can be claimed.

## Exact remaining gates

1. After publication, confirm the new PR head and its hosted checks. Keep it draft while validation is incomplete;
   local preflight and a successful push do not establish release readiness.
2. Run the complete `npm run check` on a clean supported Linux checkout with usable Unix sockets and process identity.
   Resolve or independently establish the baseline status of any remaining failures; do not weaken identity or socket tests.
   Run all stages skipped here, including authority coverage and the remaining npm-test stages.
3. On the resulting commit, run the full GitHub `check` workflow (coverage, secret scan, production image build and isolated
   Compose smoke), Vitest and DC/execution-chain checks. Preserve the current feature flag default. These are validation
   gates, not permission to deploy or enable production behavior.
4. Independently review this follow-up diff, especially grant ordering, family supersession and persistence fault behavior.
   Repeat disposable-lab loss/outage/reconnect scenarios with the changed confirmed-failure semantics. Browser checks must
   include an auth-only row and a dashboard left open across lost refresh reports. Real ChatGPT web and claude.ai behavior
   remains unverified; account changes/public tunneling need their own authorization.
5. Resolve GitGuardian incident disposition separately using the source evidence above. Its historical occurrences are
   not cleared by this patch. No merge, deployment, feature-flag activation or credential migration is authorized here.

## Authorized publication and main synchronization

The user explicitly authorized committing/pushing, then authorized synchronizing main into the PR branch before publication.
The original remote head was rechecked as `e100b223fa3d54f6407a5a71413b9350f2edd63d`. Main at
`3266a7aa347685e1dfb1b0c6401d801d190138fe` was integrated locally without conflicts. Its six commits only update dependencies
in five package/lock files; no OAuth source correction was overwritten. The local integration commit is
`a86c0da13912d8a534d043dd29eb776ed8c4bb93`.

Because `gh` is unavailable and there is no CLI credential, preflight uses a read-only transport adapter backed by the
connected GitHub API's complete inventory of 12 open PRs and all their changed filenames. The repository's
`scripts/pr-preflight.mjs` is unmodified. The adapter only provides `gh pr list`/`gh pr view` data, rejects writes and
repository mismatches, and does not override staleness, migration, or overlap decisions. Open-PR overlap warnings are
retained; no other branch is modified and no review thread is marked resolved.

Post-sync validation results are recorded below. Full release validation remains required; publishing to a draft PR
is not a declaration that all checks passed, approval to merge, or approval to deploy.

| Post-sync check                                       | Result                                                                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Fresh root dependency installation                    | Exit 0; merged lockfile, 531 packages installed.                                                                                   |
| Full `npm run check`                                  | Exit 1 after formatting, lint, build and dry-run gate passed; same `tsx` CLI Unix-socket EPERM at the contract stage.              |
| Focused gateway/UI/ingress plus dashboard goldens     | Exit 0; 120 tests passed in 11 files.                                                                                              |
| OAuth and atomic-persistence edge tests               | Exit 0; 50 passed.                                                                                                                 |
| Full `npm test`                                       | Exit 1; 5052 passed, 13 failed, 97 skipped. The failing cases match the 13 already reproduced on the original PR base above.       |
| Three contract generators through `node --import tsx` | Exit 0; public/DC/JC artifacts current.                                                                                            |
| Browser-harness gate configuration                    | Exit 0; browser harness itself still not executed here.                                                                            |
| Root high-severity dependency audit                   | Exit 0; 1 low and 6 moderate findings remain.                                                                                      |
| Preflight on synchronized branch                      | Exit 0, zero behind main; retains a warning for PR 395 touching `server.js`. Final clean-tree rerun is required before publishing. |

PR 395's server patch was inspected: it adds `enableAcsTiming` and a conditional bootstrap diagnostic call. This follow-up
only adds the atomic-writer import and removes its old inline definition in that file; it does not alter PR 395 or
change its diagnostic behavior. The overlap warning is documented rather than suppressed.

Publication uses the connected GitHub Git-data API, since this environment has no authenticated Git CLI. The tree
must match the locally validated Git tree exactly. The published commit retains the original PR head and synchronized
main as parents, followed by a non-forced branch update with the expected old head. Local validation commits are retained.
