# GitHub Actions agent workflows

Ops note for autonomous / comment-driven agent workflows in this repository.
Tracks which workflows are intentionally on or off after the FreeModel
retirement decision (ACS #84).

## Active (CI / analysis)

| Workflow | Path | State | Notes |
| --- | --- | --- | --- |
| check | `.github/workflows/check.yml` | active | ACS CI (typecheck / lint / unit checks on PR and push). |
| Vitest Tests | `.github/workflows/testdriver.yml` | active | Vitest suite. |
| codeql | `.github/workflows/codeql.yml` | active | CodeQL analysis. |
| Dependabot Updates | (GitHub Dependabot) | active | Dependency update PRs. |
| Dependabot auto-merge | `.github/workflows/dependabot-auto-merge.yml` | active | Patch/minor auto-merge; majors labeled (ACS #86). |

Other workflows such as `pr30-remediation` may exist for one-off remediation;
they are not autonomous coding agents.

## Dependabot triage (ACS #86)

Policy for dependency update PRs:

| Kind | Behavior |
| --- | --- |
| Patch / minor | Workflow `.github/workflows/dependabot-auto-merge.yml` runs `gh pr merge --auto --squash` for Dependabot. Merges after required CI (`check`, Vitest `test`, CodeQL `analyze`) is green. |
| Major | Labeled deps-major; human review only. |

Park red majors with deps-parked. Keep Allow auto-merge on.

Do not re-enable Hourly or FreeModel.

## Intentionally disabled / gated (agent automation)

| Workflow | Path | State | Why |
| --- | --- | --- | --- |
| Hourly Pull Request Cycle | `.github/workflows/hourly-pr.yml` | `disabled_manually` in GitHub Actions | FreeModel insufficient balance; decision not to fund FreeModel. Do **not** re-enable without an explicit funded-provider decision. |
| opencode | `.github/workflows/opencode.yml` | gated in-repo (`if: false`); FreeModel env/model removed | `/oc` and `/opencode` comments previously called `freemodel/*` via `FREEMODEL_API_KEY` and could fail on balance/key alone. |

## FreeModel policy

- Do **not** reintroduce paid FreeModel (`FREEMODEL_API_KEY`, `freemodel/*` models) without an explicit funding decision.
- Do **not** re-enable Hourly while it still depends on FreeModel.

## How to re-enable OpenCode (supported provider)

1. Choose a funded provider supported by `anomalyco/opencode` (prefer Anthropic: store `ANTHROPIC_API_KEY` as a repository Actions secret).
2. Update `.github/workflows/opencode.yml`:
   - Remove the durable `if: false` gate.
   - Restore the OWNER/MEMBER/COLLABORATOR + `/oc` / `/opencode` comment guards from git history before the ACS #84 gate.
   - Run `anomalyco/opencode/github` with the supported provider secret and a **non-freemodel** model id.
3. If the workflow was also disabled in the Actions UI: `gh workflow enable opencode`.
4. Verify with a controlled `/oc` comment on a PR from an allowed author association.

## How to re-enable Hourly (explicit decision required)

Hourly remains `disabled_manually`. Re-enable only after replacing FreeModel with a funded supported provider in `.github/workflows/hourly-pr.yml`, then:

```sh
gh workflow enable "Hourly Pull Request Cycle"
```

Do not enable Hourly solely to restore FreeModel.

## Quick status check

```sh
gh workflow list
gh api repos/jnibarger01/agent-control-stack/actions/workflows \
  --jq '.workflows[] | {name,state,path}'
```
