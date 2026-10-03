# Governed dispatch verification — 2026-10-03

## Custody and runtime comparison

- Isolated implementation checkout: `/home/jacen/.codex/worktrees/governed-agent-dispatch/agent-control-stack`.
- Base and inspected latest remote main: `cb864e0e3b19998c821c7f6b6d014884e1a6dda2`.
- Running gateway: PID 5644, working directory `/home/jacen/releases/acs/464d54b-step2`.
- Deployed RELEASE.json commit: `464d54ba37eef1b0a98f6fd363ab1ccd9a3752f3`.
- Gateway `/readyz` returned healthy read/write/integrity/migration/audit checks and unsaturated execution admission.
- Existing `acs-worker.service` was inactive and pointed at the primary checkout; no active `acs-worker.timer` unit was found.
- The primary checkout changed concurrently during this work. This implementation remained in the isolated checkout, with its base HEAD unchanged. No primary-checkout changes, commits, pushes, PRs, service changes, or deployment were performed for this request.

## Implemented scope

- Human-only preview and confirmed scheduling of an existing approved Change Set.
- Snapshot/approval/executor hash binding and transactional duplicate-request handling.
- Hash-chained scheduling receipts, paged complete worker replay, and bounded recent UI projection.
- Existing worker timer entry point and shared mission runner; no gateway process execution, new daemon, new lease system, or database migration.
- Runtime preflight before permits, reconstructed canonical progress, and paused-mission fairness.
- Existing policy, operation permits, scheduler admission, capabilities, execution leases, fenced results, verification, and completion remain authoritative.
- Jev retains its advisory-only boundary. No Jev authority or executor-selection path was added.
- Distinct UI presentation for governed missions and the existing weaker host-side CLI path.
- Generated public contracts and dashboard golden files regenerated using their generators.

## Verification

- `env -u ACS_GATEWAY_TOKEN npm run check`: exit 0 on the final source tree. Both normal and coverage Vitest runs passed 253 files and 2,398 tests; 11 files / 90 tests were explicitly skipped. Formatting, lint, build, contract synchronization, dry-run gate, browser-harness structural gate, supplemental workspace suites, authority coverage, and audit completed successfully.
- Coverage: 81.72% statements/lines, 78.44% branches, 88.08% functions; required gates passed.
- `npm run typecheck`: exit 0.
- `ACS_DC_E2E=1` with the gateway-token environment unset: all 13 real managed Change Set execution scenarios passed, covering the new dispatch driver, dependent writes, independent verification, restart, concurrent runners, stale dispatch, and in-flight lease loss. The new Mission Control scenario also passed separately on the final tree after paged replay was added.
- Chromium against an isolated live gateway: actual review/confirmation/receipt flow passed, review did not dispatch prematurely, exactly one scheduling receipt was recorded, and no execution child was created before worker dispatch.
- New panel accessibility: zero axe violations. Desktop 1440px and mobile 390px screenshots captured; mobile horizontal overflow check passed, and browser reported no script errors.
- Negative tests passed for missing human authority, disabled dispatch, stale confirmation, duplicate requests after database reopen, wrong executor, revoked approval after scheduling, amended snapshots, and missing runtime configuration before permit creation. Repeated blocked checks produced one stable observation.
- Existing Jev differential/negative tests ran in the full suite; source authority remains independent of advisory outputs.
- `npm run security:secrets`: exit 0, no leaks found.
- `git diff --check`: exit 0; final source diff and new files inspected.

## Limits and remaining production work

- The new integration requires a submitted, approved Change Set. It does not turn arbitrary CLI prompts into plans or govern all internal tools of the nine CLI agents.
- DC was exercised end to end for the new dispatch driver. The JC client path uses the existing shared runner but was not separately exercised through the new dispatch UI in this verification.
- Production was not modified. Enabling this requires a reviewed immutable release, matched gateway/worker database and credentials, and a correctly configured worker service/timer.
- Dependency audit reported seven moderate advisories; the high-severity audit gate passed. No dependency or security-policy changes were made to suppress findings.
- Ledger replay memory is paged, but historical scan time grows with dispatch history; no production throughput benchmark was performed.

See `docs/runbooks/governed-mission-dispatch.md` for configuration and operational boundaries.
