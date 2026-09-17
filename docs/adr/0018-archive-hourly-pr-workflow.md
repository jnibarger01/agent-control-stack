# ADR 0018: Archive the disabled Hourly Pull Request Cycle workflow

## Status

Accepted

## Context

After FreeModel was retired (ACS #84), Hourly Pull Request Cycle was left
`disabled_manually` in GitHub Actions. The workflow file
(`.github/workflows/hourly-pr.yml`), its `.automation/hourly-pr*` prompts, and
`scripts/hourly_pr.py` remained on `main`. That leftover confused operators and
gave Dependabot a surface to bump pins inside a workflow that must not run
again without an explicit funded-provider decision.

ACS #113 asks to remove the scheduled hourly path from the tree and document
that it is not coming back without a funded provider, while keeping
`opencode.yml` gated per #84.

## Decision

Delete the Hourly Pull Request Cycle path from the repository:

- `.github/workflows/hourly-pr.yml` (cron `0 * * * *` + dispatch)
- `.automation/hourly-pr.yml` and `.automation/hourly-pr-prompt.md`
- `scripts/hourly_pr.py`

Do **not** reintroduce a scheduled hourly agent workflow, FreeModel funding, or
an Hourly re-enable without a new ADR and an explicit funded supported
provider. Keep `.github/workflows/opencode.yml` gated (`if: false`) per ACS #84.

## Consequences

- No scheduled hourly Actions path remains on `main`; Dependabot no longer
  touches Hourly workflow pins.
- README and the agent-workflows runbook list only active CI/analysis workflows
  plus gated OpenCode; Hourly is documented as archived here, not as a
  re-enableable leftover file.
- Historical workflow runs and git history retain the prior implementation if a
  future funded redesign needs a starting point — restore from history under a
  new ADR, do not flip a UI enable switch on a deleted path.

## Rejected alternatives

### Leave `hourly-pr.yml` on main, disabled in the Actions UI

Rejected. A disabled-but-present workflow still confuses ops and attracts
Dependabot updates (the failure mode that motivated ACS #113).

### Re-enable Hourly with FreeModel or another unpaid path

Rejected. Mandate: no FreeModel funding and no Hourly re-enable.

## Implementation requirements

- Remove the files listed under Decision.
- Update `docs/runbooks/github-agent-workflows.md` and README ops notes so they
  list active workflows only and point here for the Hourly archive decision.
- Leave `opencode.yml` gated; adjust its header comment so it no longer claims
  Hourly still lives at `.github/workflows/hourly-pr.yml`.
