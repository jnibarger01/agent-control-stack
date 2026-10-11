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
