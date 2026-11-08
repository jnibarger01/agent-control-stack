# Review ruleset for `main` (owner action required)

The PR merge classifier (`.github/workflows/jnibarger01-pr-review-merge.yml`) does not approve or merge anything
itself. It only enables native auto-merge for documentation-only changes, and it first checks that GitHub enforces
the protections below. If any check fails, the classifier blocks and enables nothing. These settings are applied by the
repository owner in GitHub. This document does not change them.

## Required settings

Ruleset `CI required for merge` (id 22526882) currently requires only `check` and `test`. Add a `pull_request` rule to
the same ruleset, or to a new ruleset that targets `refs/heads/main`:

| Setting                                                          | Value                                               | Why the classifier needs it                            |
| ---------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------ |
| Require a pull request before merging                            | on                                                  | No direct pushes to `main`.                            |
| Required approving reviews                                       | at least 1                                          | An independent human must approve.                     |
| Require approval of the most recent reviewable push              | on                                                  | An approval cannot carry over to a newer head.         |
| Dismiss stale pull request approvals when new commits are pushed | on                                                  | Matches the classifier's stale-dismissal check.        |
| Require review from Code Owners                                  | on, with a `CODEOWNERS` entry covering `.github/**` | Matches the path-scoped reviewer check.                |
| Required status checks                                           | `check`, `test`                                     | Already present. Keep bound to the GitHub Actions app. |
| Bypass list                                                      | empty                                               | No actor can skip the rules.                           |

The classifier reads these through `repos/{repo}/rules/branches/main` and fails closed if `require_last_push_approval`,
`dismiss_stale_reviews_on_push`, a `.github/**` required reviewer, or an app-bound `check`/`test` is missing.

## Actions cannot approve

GitHub Actions must not be able to approve pull requests. This is a repository setting that the classifier's token
cannot read. In **Settings → Actions → General**, turn off "Allow GitHub Actions to create and approve pull requests".
Then set the repository variable `ACS_ATTESTED_ACTIONS_CANNOT_APPROVE_PRS` to `true`. The classifier refuses to run
without this attestation.

## What the classifier will and will not auto-merge

- Auto-merge is enabled only for a non-draft pull request by `jnibarger01`, from the same repository, whose changed
  files are all under `docs/` or are `README.md` or `CHANGELOG.md`, and that contains no sensitive path.
- Any `.github/`, `vendor/`, `CODEOWNERS`, or path matching auth, secret, token, policy, execution, gateway, or similar
  names is never auto-merged.
- Any renamed or copied file is never auto-merged, because its previous name is not returned to the classifier.
- Auto-merge is bound to the classified head SHA (`--match-head-commit`). A new push cancels the classification.

## Verifying after you apply it

1. Open a docs-only test pull request from the owner account. Expect auto-merge to be enabled only after the
   required checks pass, and expect the merge to wait for the required approval if you require one for it.
2. Open a pull request that touches `.github/` and confirm the classifier disables auto-merge and comments.
3. Confirm the rules on `main` with `gh api repos/jnibarger01/agent-control-stack/rules/branches/main` and check that
   the `pull_request` rule is present.

## Not verified here

I could not read the Actions approval setting or the branch-protection API with the token available to this session
(it returned 403 for the classic branch-protection endpoint). The ruleset above is read from the rulesets API only. The
owner needs to confirm the settings in the GitHub UI.

## Known limitation: merges made with GITHUB_TOKEN do not re-run main CI

The classifier merges with `GITHUB_TOKEN`. GitHub does not start normal push workflows for events made with that token,
so `check`, `Vitest Tests` and `dc-execution-chain` do not run on the new `main` commit after an unattended merge. The
checks did run on the PR head before the merge. Nothing re-verifies `main` afterwards.

This limitation is accepted temporarily (decision A). It is not resolved.

What exists now:

- `scripts/post-merge-verify.py` is read-only. It asks GitHub for the check runs on one commit and exits non-zero unless
  every required check concluded `success` on that exact commit. It can read and report only. It has no merge,
  approve, comment, dispatch or settings capability.
- It is not wired to any workflow trigger. It must not be activated until a reviewed change proves, against the actual
  merged `main` commit, that it runs and reports correctly.

Activation requires the owner's approval and must keep the verifier without merge authority.
