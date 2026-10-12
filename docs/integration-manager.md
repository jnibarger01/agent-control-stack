# Integration Manager (read-only reconciliation)

Slice 3.1 of the autonomous-evolution mission. `@agent-control-stack/integration-manager` looks at the open pull requests
of a repository and reports which of them would satisfy the merge gate, in what order, and whether the result still
merges cleanly once the ones ahead of it have landed. **It merges nothing, pushes nothing and approves nothing.**

## Why it does not merge

The repository already has a merge authority: the review-and-merge workflow plus branch protections. A second merger would
be a competing authority with its own bugs. This engine is a second opinion that is never more permissive than that gate:
`wouldMerge` is true only when the gate verdict is `eligible`. Merging remains the workflow's job; automating a merge from
this report is a later, separately authorized slice.

## Pieces

| Piece                       | What it does                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evaluateGate`              | Pure. Mirrors the workflow's rules: open, not a draft, no conflicts, no requested changes, no unresolved review threads, every check `SUCCESS`/`NEUTRAL`/`SKIPPED`. Adds source integrity: no forks, optional author allowlist, a change to the gate policy file is blocked, and a truncated view of threads, checks or files is a blocker, never read as clean. Checks still running or an unknown mergeability give `pending`. |
| `classifyFailure`           | Triage hint from a failing check's _name_ (test, lint, typecheck, format, security, review-gate, deploy, build). It reads no logs and does not diagnose.                                                                                                                                                                                                                                                                         |
| `analyzeDependencies`       | Stacked pull requests (B's base is A's head) are ordered A before B. Cycles and bases that are neither the target nor an open head are reported and never queued, at any depth.                                                                                                                                                                                                                                                  |
| `MergeSimulator`            | `git merge-tree --write-tree` in a **disposable bare clone** (`createIsolatedClone`). No working tree, index or ref is touched; only unreferenced objects are added to the clone. Reports conflicting paths and how far the base has moved (stale base).                                                                                                                                                                         |
| `reconcile`                 | Walks the dependency order and merges virtually: each pull request is simulated against the tip _after_ the queued ones ahead of it. Clean alone but conflicting after an upstream merge is reported as exactly that.                                                                                                                                                                                                            |
| `createGhPullRequestSource` | Reads open pull requests through the authenticated `gh` CLI with one GraphQL query. A second page of pull requests is an error, not a silent truncation.                                                                                                                                                                                                                                                                         |

## Mirrors the gate, and tests prove it

The default policy is read from the repository's own workflow by a test (`policy-drift.test.ts`), so the two cannot drift
apart unnoticed: only the author the workflow acts on is eligible (`jnibarger01`); a change to **either** the workflow or
`.github/instructions/jnibarger01-pr-review.instructions.md` is blocked; the merge method is the first allowed of merge
commit, squash, rebase, in the workflow's order (`selectMergeMethod`).

## The merge method changes the answer

`reconcile` needs the repository's merge method and simulates it. A **merge** commit records the pull request's history, so a
stacked child that edits its parent's lines still merges. A **squash** does not, so the same child conflicts once its parent
has landed; the simulation uses a single-parent commit and reports that. **Rebase** replays each commit and is not modeled:
every otherwise-eligible pull request is reported not mergeable (`merge_method_not_modeled`) rather than guessed at.

## Dependencies

A base branch lives in the repository being merged into, so only a pull request whose head is in that repository can be a
parent; a fork's branch that shares a name is never matched. A genuine dependency cycle is reported as `dependency_cycle` on
its members; a pull request that only depends on one is `blocked_by_cycle`, and is still simulated on its own.

## Credentials and configuration

- The GitHub response is validated at runtime (strict enums, required fields). An unknown `mergeable`, `reviewDecision` or
  state, or a missing field, fails the whole read; it is never read as eligible. The error names the pull request and the
  fields, not the response content. An unrecognized check status is `UNKNOWN`, which the gate treats as not finished.
- The `gh` subprocess does not inherit `GH_TOKEN` or `GITHUB_TOKEN`. A caller with a narrowly scoped, read-only token passes
  it explicitly: `createGhRunner({ token })`. Without one, `gh` uses its own stored login.
- Git runs with no host configuration: global and system config, system attributes, `HOME` and `XDG_CONFIG_HOME` are all
  disabled, so a merge driver named in an operator's `~/.gitconfig` cannot be selected by a pull request's `.gitattributes`.
- Repository names follow GitHub's rules; `..`, `.` and anything else that could reach the API path as a segment is refused.

## Fail-closed behavior

- A head commit that is not in the clone, a base that cannot be read, or a merge that could not be evaluated is reported as
  not mergeable with the reason, never guessed.
- A failed or partial source read raises; it does not produce an empty queue.
- The report always carries `merged: false`.

## Not in this slice

- Merging, pushing or repairing branches, and the repository-level lock that serializes those (nothing here mutates a
  shared target, so no lock is needed yet; it arrives with the first mutating operation).
- Fetching pull request heads into the clone (`refs/pull/*/head`) and a CLI. Callers supply a clone that already contains the
  heads; the report says so for any head it cannot find.
- Re-running tests, or reading CI logs, to classify failures beyond the check's name.
- Required-review and branch-protection settings beyond what GitHub reports in `reviewDecision` and `mergeable`.
- Rebase simulation (per-commit replay).
