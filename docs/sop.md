# Session operating procedure

This procedure keeps every session grounded in repository evidence and makes
handoffs reproducible.

## Session contract

<!-- SESSION-CONTRACT-START -->
1. Read `STATE.md` in full and load every skill listed under **Active skills**.
2. Restate the session objective in one sentence and list the acceptance
   criteria that grade it.
3. Work only inside this repository unless the task explicitly says otherwise.

Before ending a session:

4. Update **Verified facts**, **Open failures**, **Lessons learned**, and
   **Last session** in `STATE.md`. Give **Last session** a concrete resume
   pointer.
5. If a lesson generalizes beyond the session, update or create the relevant
   skill and record the change in that skill's changelog.
6. List every artifact created or changed, with paths.

Hard rules:

- No artifact without an acceptance check.
- No platform-feature claim without a citation in `docs/platform-facts.md` or
  an explicit `UNVERIFIED` tag.
- If blocked, document the block; do not guess or route around it silently.
<!-- SESSION-CONTRACT-END -->

## Start a session

Run `scripts/new-session`. It prints the contract above followed by the full
current `STATE.md`. Treat that output as the controlling handoff, then inspect
the live worktree before relying on prior conclusions.

## Work and verification

- Define an acceptance check before creating an artifact.
- Preserve unrelated worktree changes and stage task paths explicitly.
- Keep model, pricing, availability, and product-feature facts in
  `docs/platform-facts.md`; other files cite that source instead of memory.
- Write small run summaries and required evidence traces under `runs/`. Put
  large, binary, or transient payloads under `runs/artifacts/`, which Git
  ignores.
- Record failed commands and their relevant cause. Never turn a narrow test
  into a broad completion claim.

## End a session

Update `STATE.md`, including a non-empty **Last session** paragraph, then run
`scripts/end-session`. The script requires explicit confirmation, refuses an
empty handoff, and prunes stale Git worktree administrative records. It does
not delete live worktrees.

## Commit discipline

Commit only paths owned by the task. Before committing, inspect the staged
diff, run the artifact-specific acceptance checks, and run `git diff --check`.
Do not stage unrelated dirty files.
