---
description: Review Agent Control Stack code or a proposed ACS change for policy, exact-action approval, audit-chain, authentication, MCP exposure, and execution-boundary defects. Use for ACS pull requests, release gates, security reviews, or changes under apps/gateway, apps/mcp, apps/worker, packages/policy-gate, packages/work-items, packages/shared, packages/machine-controller, or packages/sandbox.
---

# Review Agent Control Stack

## Objective

Determine whether the selected ACS change preserves the control plane's fail-closed security boundaries and is adequately tested. Report evidence, not reassurance.

## Inputs and assumptions

- Review `$ARGUMENTS` when it names a diff, branch, commit, pull request, or file set; otherwise review the current worktree diff.
- Work from the repository root.
- Treat agent requests and MCP inputs as untrusted.
- Treat the current worker and sandbox as dry-run only unless the checked code and release documentation prove otherwise.
- Do not assume a passing test suite covers the changed security boundary.

## Workflow

1. Establish scope with `git status --short`, the current branch, and the exact diff or files requested.
2. Read the changed code and its callers before drawing conclusions. Trace data from HTTP or MCP ingress through validation, policy, approval, storage, worker claim, execution boundary, result submission, and audit emission where applicable.
3. Check these invariants:
   - unknown, malformed, or unauthenticated input fails closed;
   - policy decisions bind to canonical requested actions;
   - approval binds to the exact action and cannot be reused after mutation, expiry, or consumption;
   - worker claims and results remain lease-bound;
   - privileged behavior cannot bypass policy, approval, or audit persistence;
   - audit-chain writes and verification preserve ordering and tamper evidence;
   - secrets are redacted before logs, responses, or persisted audit data;
   - MCP and HTTP exposure is loopback-first or protected by the documented auth mode;
   - path, command, network, and environment inputs cannot escape their allowlists;
   - dry-run behavior is not represented as real execution.
4. Inspect existing tests for each affected invariant. Add no code during a review-only request.
5. Run the narrowest relevant tests, then `npm run check` when the requested scope and environment permit it. Record exact commands and exit results.
6. Search the changed files for credentials, private keys, tokens, machine-specific paths, or unsafe interpolation. Distinguish placeholders from actual secrets.
7. Rank findings by exploitability and impact. Cite exact files and lines.

## Safety constraints

- Do not approve, unblock, cancel, execute, or mutate ACS work items during a review.
- Do not start externally reachable listeners or contact remote services unless the user explicitly requests it.
- Do not read real secret values. Verify configuration by variable name and control flow.
- Do not weaken authentication, policy, approval, redaction, audit, or dry-run boundaries to make a test pass.
- Stop and escalate if the requested review requires unavailable credentials, production access, or destructive state changes.

## Output contract

Return these sections:

1. `Verdict`: `PASS`, `PASS_WITH_CONCERNS`, or `BLOCK`.
2. `Blockers`: exploitable or release-blocking defects, highest impact first.
3. `Concerns`: non-blocking correctness, coverage, or operational risks.
4. `Nits`: optional maintainability improvements only.
5. `Verification`: commands run, exit results, and what each command actually covered.
6. `Unverified`: required checks not run and the precise reason.

Every finding must include impact, evidence, and a concrete fix. If a section has no items, say `None`.

## Failure behavior

If the diff, repository, dependencies, or tests are unavailable, do not infer a pass. Return `BLOCK` when the missing evidence prevents evaluation of a security invariant; otherwise return `PASS_WITH_CONCERNS` and identify the exact unverified surface and next command.
