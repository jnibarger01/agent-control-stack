# Worktree cleanup closeout — 2026-07-10

## Completed objective

Preserve every unique or dirty repository state, reconcile intended work into `main`, verify and push it without rewriting history, and remove only the four accounted-for cleanup paths.

## Acceptance receipt

| Criterion | Result | Evidence |
| --- | --- | --- |
| Inspect `main` and every named path | PASS | Branch, dirty-state, unique-commit, and preservation inventory was captured before mutation. |
| Preserve uncommitted and unmerged work | PASS | Exact tips remain on the five remote preservation/archive refs listed below. |
| Reconcile intended work into `main` | PASS | AgentOS contracts landed as `e38a004`; newer lease behavior already existed; the test-red MCP slice stayed isolated. |
| Run tests, type checks, builds, and validations | PASS | `npm run check`: 33 files/276 tests; AgentOS Node: 48 tests; bootstrap acceptance passed. Slice-specific results are recorded in `STATE.md`. |
| Commit legitimate remaining work | PASS | Preservation, archive, and AgentOS integration commits are enumerated below. |
| Fetch and reconcile safely | PASS | Final implementation fetch showed `main` nine ahead and zero behind; the push was a normal fast-forward. |
| Push `main` and preservation branches | PASS | GitHub refs and exact SHAs are listed below. |
| Prove local/GitHub parity and clean state | PASS | Implementation SHA was `e38a004c03e5f8881a9499c8c8cd542b9e7146ca` at `0 0`; the documentation-only closeout requires the same post-push gate. |
| Remove named worktrees only after proof | PASS | Three registered worktrees were removed without force after remote-SHA verification. |
| Remove the Phase-0 artifact path safely | PASS | Authored source/reviews were archived first; generated ISO/chroot/cache output was then removed. |
| Prune metadata and delete branches safely | PASS | Stale metadata was pruned; local cleanup branches were deleted only after exact remote refs existed. |
| Preserve unrelated worktrees | PASS | The final registry retains only `main` and unrelated preexisting worktrees. |

## Verified remote refs before closeout

```text
main                                      e38a004c03e5f8881a9499c8c8cd542b9e7146ca
hermes/agentos-contracts-slice            6633abc552ffae7fe17163948ebd2fd8702b201f
hermes/lease-bound-results                45c7830388966012d2fd8aadb7d39b5dd1778c88
hermes/mcp-transport                      3ef51925b84ef01a93744dc3ef8cb6c7e425e8b5
preserve/main-working-tree-20260710       3eb8b6f8a5b2a8b5d6ab5d62813a97ac5e40b6e8
archive/agentos-phase0-20260708           eb58b8d301b9642c49c88364cfce07b6e35be6ef
```

## Files changed on `main`

Range: `da6467c7a72b18e6b54bc3a3c053ddf53ea1560c..e38a004c03e5f8881a9499c8c8cd542b9e7146ca`.

```text
M	.claude-plugin/marketplace.json
A	.env.example
A	.github/workflows/opencode.yml
M	.gitignore
M	CLAUDE.md
M	README.md
A	STATE.md
M	apps/gateway/package.json
M	apps/gateway/tsconfig.json
M	apps/mcp/src/server.test.ts
M	apps/mcp/src/server.ts
A	docs/goal-loops.md
A	docs/independent-verification.md
A	docs/orchestration-patterns.md
A	docs/platform-facts.md
A	docs/sop.md
A	evals/README.md
A	evals/cli.ts
A	evals/dynamic-workflow-evidence.test.ts
A	evals/fixture-provider.ts
A	evals/graders/.gitkeep
A	evals/graders/independent-grader.test.ts
A	evals/graders/independent-grader.ts
A	evals/maker-verifier-cli.ts
A	evals/maker-verifier-evidence.test.ts
A	evals/maker-verifier-evidence.ts
A	evals/orchestration-evidence-cli.ts
A	evals/orchestration-evidence.test.ts
A	evals/orchestration-evidence.ts
A	evals/orchestration-live-cli.ts
A	evals/orchestration-live-evidence.test.ts
A	evals/result-schema.test.ts
A	evals/result-schema.ts
A	evals/runner.test.ts
A	evals/runner.ts
A	evals/task-schema.test.ts
A	evals/task-schema.ts
A	evals/tasks/approval-binding-check.json
A	evals/tasks/audit-replay-invariant.json
A	evals/tasks/auth-boundary-review.json
A	evals/tasks/grader-isolation-design.json
A	evals/tasks/model-routing-choice.json
A	evals/tasks/policy-action-classification.json
A	evals/tasks/redaction-repair.json
A	evals/tasks/routing-cost-estimate.json
A	evals/tasks/sandbox-safety-plan.json
A	evals/tasks/work-item-lifecycle.json
A	harness/claude-cli-provider.test.ts
A	harness/claude-cli-provider.ts
A	harness/cost.test.ts
A	harness/cost.ts
A	harness/goal-evidence-cli.ts
A	harness/goal-evidence.test.ts
A	harness/goal-evidence.ts
A	harness/maker-verifier.test.ts
A	harness/maker-verifier.ts
A	harness/model-provider.ts
A	harness/orchestration-patterns.test.ts
A	harness/orchestration-patterns.ts
A	harness/orchestration.ts
A	harness/outcomes.test.ts
A	harness/outcomes.ts
A	harness/routing.md
A	harness/routing.test.ts
A	harness/routing.ts
A	ijfw/memory/knowledge.md
A	ijfw/memory/project-journal.md
M	package-lock.json
A	packages/agentos-contracts/README.md
A	packages/agentos-contracts/RUNBOOK.md
A	packages/agentos-contracts/examples/sample-envelope.json
A	packages/agentos-contracts/examples/smoke.mjs
A	packages/agentos-contracts/package.json
A	packages/agentos-contracts/schemas/gate-evidence.schema.json
A	packages/agentos-contracts/schemas/task-envelope.schema.json
A	packages/agentos-contracts/schemas/trace-event.schema.json
A	packages/agentos-contracts/src/envelope.js
A	packages/agentos-contracts/src/failure-taxonomy.js
A	packages/agentos-contracts/src/index.d.ts
A	packages/agentos-contracts/src/index.js
A	packages/agentos-contracts/src/promotion-gate.js
A	packages/agentos-contracts/src/risk-policy.js
A	packages/agentos-contracts/src/router.js
A	packages/agentos-contracts/src/trace-events.js
A	packages/agentos-contracts/test/envelope.test.js
A	packages/agentos-contracts/test/gate.test.js
A	packages/agentos-contracts/test/router.test.js
A	packages/agentos-contracts/test/trace.test.js
M	packages/eval-harness/package.json
M	packages/eval-harness/src/index.ts
A	packages/eval-harness/src/promotion-gate.test.ts
A	packages/eval-harness/src/promotion-gate.ts
M	packages/machine-controller/src/controller.ts
A	packages/machine-controller/src/direct-agent.test.ts
A	packages/machine-controller/src/direct-agent.ts
M	packages/machine-controller/src/index.ts
M	packages/policy-gate/package.json
A	packages/policy-gate/src/contracts.test.ts
A	packages/policy-gate/src/contracts.ts
M	packages/policy-gate/src/index.ts
M	packages/policy-gate/src/tools.test.ts
M	packages/policy-gate/src/tools.ts
M	packages/shared/src/redact.test.ts
M	packages/shared/src/redact.ts
A	runs/.gitignore
A	runs/2026-07-09-dynamic-workflow-attempts.json
A	runs/2026-07-09-eval-baseline-1.json
A	runs/2026-07-09-eval-baseline-2.json
A	runs/2026-07-09-goal-policy-action-classification.json
A	runs/2026-07-09-maker-verifier-audit-replay-invariant.json
A	runs/2026-07-09-maker-verifier-redaction-repair.json
A	runs/2026-07-09-maker-verifier-work-item-lifecycle-seeded.json
A	runs/2026-07-09-orchestration-adversarial.json
A	runs/2026-07-09-orchestration-fan-out-synthesize.json
A	runs/2026-07-09-orchestration-live-adversarial.json
A	runs/2026-07-09-orchestration-live-fan-out.json
A	runs/2026-07-09-orchestration-live-loop.json
A	runs/2026-07-09-orchestration-loop-iteration-cap.json
A	runs/2026-07-09-orchestration-loop-until-done.json
A	scripts/bootstrap-acceptance.test.sh
A	scripts/end-session
A	scripts/new-session
A	scripts/run-evals
A	skills/INDEX.md
A	skills/_templates/SKILL.md
A	skills/bounded-orchestration/SKILL.md
A	skills/bounded-orchestration/agents/openai.yaml
A	skills/eval-baseline/SKILL.md
A	skills/eval-baseline/agents/openai.yaml
A	skills/independent-verification/SKILL.md
A	skills/independent-verification/agents/openai.yaml
A	tsconfig.compounding.json
M	tsconfig.json
M	vitest.config.ts
```

## Files in preservation commits

```text
COMMIT 6633abc552ffae7fe17163948ebd2fd8702b201f feat(agentos): add contract validation package

M	package-lock.json
A	packages/agentos-contracts/README.md
A	packages/agentos-contracts/RUNBOOK.md
A	packages/agentos-contracts/examples/sample-envelope.json
A	packages/agentos-contracts/examples/smoke.mjs
A	packages/agentos-contracts/package.json
A	packages/agentos-contracts/schemas/gate-evidence.schema.json
A	packages/agentos-contracts/schemas/task-envelope.schema.json
A	packages/agentos-contracts/schemas/trace-event.schema.json
A	packages/agentos-contracts/src/envelope.js
A	packages/agentos-contracts/src/failure-taxonomy.js
A	packages/agentos-contracts/src/index.d.ts
A	packages/agentos-contracts/src/index.js
A	packages/agentos-contracts/src/promotion-gate.js
A	packages/agentos-contracts/src/risk-policy.js
A	packages/agentos-contracts/src/router.js
A	packages/agentos-contracts/src/trace-events.js
A	packages/agentos-contracts/test/envelope.test.js
A	packages/agentos-contracts/test/gate.test.js
A	packages/agentos-contracts/test/router.test.js
A	packages/agentos-contracts/test/trace.test.js
M	packages/eval-harness/package.json
M	packages/eval-harness/src/index.ts
A	packages/eval-harness/src/promotion-gate.test.ts
A	packages/eval-harness/src/promotion-gate.ts
M	packages/policy-gate/package.json
A	packages/policy-gate/src/contracts.test.ts
A	packages/policy-gate/src/contracts.ts
M	packages/policy-gate/src/index.ts
M	packages/policy-gate/src/tools.test.ts
M	packages/policy-gate/src/tools.ts
COMMIT 45c7830388966012d2fd8aadb7d39b5dd1778c88 fix(worker): bind results to lease claims

M	apps/gateway/src/mcp.test.ts
M	apps/gateway/src/mcp.ts
M	apps/gateway/src/tools/execute-approved.ts
M	apps/worker/src/index.ts
M	packages/eval-harness/src/replay.test.ts
M	packages/work-items/src/state-machine.test.ts
M	packages/work-items/src/store.ts
M	packages/work-items/src/work-item.ts
M	storage/migrations/001_audit_log.sql
COMMIT 3ef51925b84ef01a93744dc3ef8cb6c7e425e8b5 chore(mcp): preserve hardening slice

M	apps/control-ui/src/index.ts
A	apps/gateway/src/auth.ts
M	apps/gateway/src/mcp.ts
M	apps/gateway/src/server.test.ts
M	apps/gateway/src/server.ts
M	apps/gateway/src/tools/execute-approved.ts
M	apps/gateway/src/tools/work-items.ts
M	apps/worker/src/index.ts
M	packages/audit-log/src/event.ts
M	packages/audit-log/src/store.ts
M	packages/eval-harness/src/cli.ts
M	packages/eval-harness/src/index.ts
M	packages/eval-harness/src/replay.test.ts
M	packages/policy-gate/src/index.ts
M	packages/policy-gate/src/policy.ts
M	packages/policy-gate/src/rules.ts
A	packages/policy-gate/src/workspace.ts
M	packages/sandbox/src/index.ts
M	packages/shared/src/hash.ts
M	packages/shared/src/redact.ts
M	packages/work-items/src/state-machine.test.ts
M	packages/work-items/src/store.ts
M	packages/work-items/src/work-item.ts
A	storage/migrations/002_audit_hash_chain.sql
COMMIT 68846d93a3a71e64329ddf84d374700a59d46636 chore(repo): preserve local working state

M	CLAUDE.md
M	package-lock.json
M	package.json
COMMIT 3eb8b6f8a5b2a8b5d6ab5d62813a97ac5e40b6e8 chore(repo): capture updated IJFW profile

M	CLAUDE.md
```

## Files archived from Phase-0

```text
COMMIT eb58b8d301b9642c49c88364cfce07b6e35be6ef chore(archive): preserve AgentOS phase-zero

A	archives/agentos-phase0-20260708/IDEA.md
A	archives/agentos-phase0-20260708/README.md
A	archives/agentos-phase0-20260708/reviews/hardening-review-02-formal.md
A	archives/agentos-phase0-20260708/reviews/hardening-review-02.md
A	archives/agentos-phase0-20260708/source/agentos/Makefile
A	archives/agentos-phase0-20260708/source/agentos/README.md
A	archives/agentos-phase0-20260708/source/agentos/VERSION
A	archives/agentos-phase0-20260708/source/agentos/auto/clean
A	archives/agentos-phase0-20260708/source/agentos/auto/config
A	archives/agentos-phase0-20260708/source/agentos/config/hooks/normal/0100-identity.hook.chroot
A	archives/agentos-phase0-20260708/source/agentos/config/hooks/normal/0200-desktop-defaults.hook.chroot
A	archives/agentos-phase0-20260708/source/agentos/config/hooks/normal/0300-firewall.hook.chroot
A	archives/agentos-phase0-20260708/source/agentos/config/hooks/normal/0500-tailscale.hook.chroot.disabled
A	archives/agentos-phase0-20260708/source/agentos/config/includes.chroot/etc/dconf/db/local.d/00-agentos-desktop
A	archives/agentos-phase0-20260708/source/agentos/config/includes.chroot/etc/dconf/profile/user
A	archives/agentos-phase0-20260708/source/agentos/config/includes.chroot/etc/lightdm/slick-greeter.conf
A	archives/agentos-phase0-20260708/source/agentos/config/includes.chroot/etc/nftables.conf
A	archives/agentos-phase0-20260708/source/agentos/config/includes.chroot/etc/xdg/autostart/agentos-panel-setup.desktop
A	archives/agentos-phase0-20260708/source/agentos/config/includes.chroot/usr/libexec/agentos/panel-setup.sh
A	archives/agentos-phase0-20260708/source/agentos/config/includes.chroot/usr/share/agentos/branding/wallpaper/agentos-default.png
A	archives/agentos-phase0-20260708/source/agentos/config/includes.chroot/usr/share/applications/agentos-mission-control.desktop
A	archives/agentos-phase0-20260708/source/agentos/config/includes.chroot/usr/share/cinnamon/applets/acs-health@agentos/applet.js
A	archives/agentos-phase0-20260708/source/agentos/config/includes.chroot/usr/share/cinnamon/applets/acs-health@agentos/metadata.json
A	archives/agentos-phase0-20260708/source/agentos/config/includes.chroot/usr/share/cinnamon/applets/acs-health@agentos/settings-schema.json
A	archives/agentos-phase0-20260708/source/agentos/config/package-lists/agentos-desktop.list.chroot
A	archives/agentos-phase0-20260708/source/agentos/config/package-lists/agentos-firmware.list.chroot
A	archives/agentos-phase0-20260708/source/agentos/config/package-lists/agentos-tools.list.chroot
A	archives/agentos-phase0-20260708/source/agentos/docs/REQUIRED-INPUTS.md
A	archives/agentos-phase0-20260708/source/agentos/docs/adr/ADR-0001-base-os-and-image-pipeline.md
A	archives/agentos-phase0-20260708/source/agentos/docs/adr/ADR-0002-desktop-environment.md
A	archives/agentos-phase0-20260708/source/agentos/docs/adr/ADR-0003-installer-strategy.md
A	archives/agentos-phase0-20260708/source/agentos/docs/research-synthesis.md
A	archives/agentos-phase0-20260708/source/agentos/docs/system-design.md
A	archives/agentos-phase0-20260708/source/agentos/installer/README.md
A	archives/agentos-phase0-20260708/source/agentos/installer/calamares/branding/agentos/branding.desc
A	archives/agentos-phase0-20260708/source/agentos/installer/calamares/settings.conf
A	archives/agentos-phase0-20260708/source/agentos/scripts/build-in-docker.sh
A	archives/agentos-phase0-20260708/source/agentos/tests/chroot-smoke-test.sh
A	archives/agentos-phase0-20260708/source/agentos/tests/iso-structure-check.sh
A	archives/agentos-phase0-20260708/source/agentos/tests/qemu-boot-test.sh
```

## Generated or reproducible Phase-0 paths removed

- `/home/jacen/agent-control-stack-phase0-artifacts-20260708-0212/agentos/expanded/scaffold/agentos/live-image-amd64.hybrid.iso`
- `/home/jacen/agent-control-stack-phase0-artifacts-20260708-0212/agentos/expanded/scaffold/agentos/binary/`
- `/home/jacen/agent-control-stack-phase0-artifacts-20260708-0212/agentos/expanded/scaffold/agentos/chroot/`
- `/home/jacen/agent-control-stack-phase0-artifacts-20260708-0212/agentos/expanded/scaffold/agentos/cache/`
- `/home/jacen/agent-control-stack-phase0-artifacts-20260708-0212/agentos/expanded/` (all remaining generated and extracted live-build state)
- `/home/jacen/agent-control-stack-phase0-artifacts-20260708-0212/agentos/files.zip` (duplicate documentation archive)

The complete Phase-0 directory was removed after `eb58b8d` was verified on GitHub. The original authored-source archive SHA-256 was `c856e1818b2e42fab774f5965d6fd7487bc7d7aec5beb52dbd1472dc221e5ff5`.

## Closeout artifacts

- `STATE.md` — objective, cleanup acceptance criteria, verified facts, Prompt 11 open failure, MCP test failures, lesson, and resume pointer.
- `skills/bounded-orchestration/SKILL.md` — exact remote-SHA gate before worktree removal, plus 2026-07-10 changelog entry.
- `docs/worktree-cleanup-closeout-2026-07-10.md` — this acceptance receipt and full artifact manifest.

## Open concerns

- `hermes/mcp-transport` remains preserved but not merged because two audit-chain tests fail; exact test names are in `STATE.md`.
- Prompt 11 remains `OPEN_FAILURE`: the independent audit had no contributing auditor because Codex authentication was stale and Gemini failed under `TERM=dumb`.
- The deleted Phase-0 ISO was not rebuilt during closeout; its authored source and build scripts are preserved on the archive branch.
