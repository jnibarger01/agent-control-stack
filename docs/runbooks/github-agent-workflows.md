# GitHub Actions agent workflows

Ops note for autonomous / comment-driven agent workflows in this repository.
Tracks which workflows are intentionally on or off after the FreeModel
retirement decision (ACS #84) and the Hourly archive (ACS #113 / ADR 0015).

## Active (CI / analysis)

| Workflow | Path | State | Notes |
| --- | --- | --- | --- |
| check | `.github/workflows/check.yml` | active | ACS CI (typecheck / lint / unit checks on PR and push). |
| Vitest Tests | `.github/workflows/testdriver.yml` | active | Vitest suite. |
| codeql | `.github/workflows/codeql.yml` | active | CodeQL analysis. |
| Dependabot Updates | (GitHub Dependabot) | active | Dependency update PRs. |
| Dependabot auto-merge | `.github/workflows/dependabot-auto-merge.yml` | active | Patch/minor only; `deps-major` / `deps-parked` hard-blocked (ACS #86; after #102). |

Other workflows such as `pr30-remediation` may exist for one-off remediation;
they are not autonomous coding agents.

## Dependabot triage (ACS #86)

Policy for dependency update PRs:

| Kind | Behavior |
| --- | --- |
| Patch / minor | Workflow `.github/workflows/dependabot-auto-merge.yml` runs `gh pr merge --auto --squash` for Dependabot **only when the PR is not labeled `deps-major` or `deps-parked`**. Merges after required CI (`check`, Vitest `test`, CodeQL `analyze`) is green. |
| Major | Labeled `deps-major`; auto-merge is **disabled**; human review only. |
| Parked | Label `deps-parked` **hard-blocks** auto-merge even if Dependabot metadata misclassifies the bump (see #102 codeql-action group slip). |

Park red majors with `deps-parked`. Repo may keep Allow auto-merge on, but the workflow must never enable or leave auto-merge on for `deps-major` / `deps-parked`.

Do not reintroduce FreeModel or a scheduled Hourly agent workflow.

## Intentionally gated (agent automation)

| Workflow | Path | State | Why |
| --- | --- | --- | --- |
| opencode | `.github/workflows/opencode.yml` | gated in-repo (`if: false`); FreeModel env/model removed | `/oc` and `/opencode` comments previously called `freemodel/*` via `FREEMODEL_API_KEY` and could fail on balance/key alone. |

## Archived (not on tree)

| Former workflow | Decision | Why |
| --- | --- | --- |
| Hourly Pull Request Cycle (`.github/workflows/hourly-pr.yml`, `.automation/hourly-pr*`, `scripts/hourly_pr.py`) | Removed per ADR 0015 / ACS #113 | Was `disabled_manually` after FreeModel retirement; leftover confused ops and attracted Dependabot pin bumps. Not coming back without a funded supported provider and a new ADR. |

## FreeModel policy

- Do **not** reintroduce paid FreeModel (`FREEMODEL_API_KEY`, `freemodel/*` models) without an explicit funding decision.
- Do **not** restore a scheduled Hourly agent path without ADR + funded provider (see ADR 0015).

## How to re-enable OpenCode (supported provider)

1. Choose a funded provider supported by `anomalyco/opencode` (prefer Anthropic: store `ANTHROPIC_API_KEY` as a repository Actions secret).
2. Update `.github/workflows/opencode.yml`:
   - Remove the durable `if: false` gate.
   - Restore the OWNER/MEMBER/COLLABORATOR + `/oc` / `/opencode` comment guards from git history before the ACS #84 gate.
   - Run `anomalyco/opencode/github` with the supported provider secret and a **non-freemodel** model id.
3. If the workflow was also disabled in the Actions UI: `gh workflow enable opencode`.
4. Verify with a controlled `/oc` comment on a PR from an allowed author association.

## Quick status check

```sh
gh workflow list
gh api repos/jnibarger01/agent-control-stack/actions/workflows \
  --jq '.workflows[] | {name,state,path}'
```
