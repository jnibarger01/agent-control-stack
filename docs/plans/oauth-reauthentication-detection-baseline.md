# Baseline: clean HEAD versus this feature

Recorded 2026-10-17, base `03f026b7`. **This replaces the earlier version of this file, whose root cause was wrong.**

## Correction

The earlier "baseline failures" (9 failing gateway tests, 626 failing tests in the full suite, 135 `tsc -b` errors) were not
properties of `HEAD`. They came from the agent worktree having **no `node_modules` of its own**: Node resolved every
`@agent-control-stack/*` import upward into the main checkout (`/home/jacen/projects/agent-control-stack/node_modules`), whose
workspace links point at that checkout's `packages/*` on a different branch (`feat/antigravity-agent-card`, dirty tree). Tests there
were running this branch's `apps/*` against another branch's `packages/*`.

Lesson: tests run from inside `.claude/worktrees/<name>` are only meaningful after an install in that worktree.

## Reproduction (clean, self-contained)

Both trees live in the session scratchpad, each with its own `npm install` (HEAD's `package-lock.json` is out of sync with
`apps/local-advisor-mcp`, so `npm ci` exits 1 at HEAD; `npm install` is required and rewrites the lockfile in the throwaway copy only).

| Tree         | Command                                   | Exit | Result                                                                                 |
| ------------ | ----------------------------------------- | ---- | -------------------------------------------------------------------------------------- |
| clean `HEAD` | `npm ci --prefer-offline`                 | 1    | lockfile out of sync (`@agent-control-stack/local-advisor-mcp` missing). Pre-existing. |
| clean `HEAD` | `npm install --prefer-offline`            | 0    | 495 packages                                                                           |
| clean `HEAD` | `npx tsc -b --pretty false`               | 0    | 0 errors                                                                               |
| clean `HEAD` | `env -u ACS_GATEWAY_TOKEN npx vitest run` | 0    | 4325 passed, 91 skipped, **0 failed**                                                  |

The feature tree is clean `HEAD` plus this worktree's diff and untracked files (`sync-feat.sh`, kept with the evidence); its results are in
[the readiness report](oauth-reauthentication-detection-readiness.md).

So there are **no baseline failures to carry**. The previous statement that "9 gateway tests fail at HEAD" was an environment artifact.
