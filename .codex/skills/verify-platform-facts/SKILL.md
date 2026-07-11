---
name: verify-platform-facts
description: Refresh and audit docs/platform-facts.md from live official Claude and Anthropic sources. Use for the 30-day platform-fact review, model/pricing updates, Claude Code feature checks, official-name changes, or any build step that needs a cited platform claim.
---

# Verify Platform Facts

Keep live facts in `docs/platform-facts.md`, not in this skill. Use this skill
only for the repeatable evidence and audit procedure.

## Evidence rules

1. Use only live official pages on `docs.claude.com`,
   `code.claude.com/docs`, `claude.com/blog`, and `anthropic.com/news`.
2. Never use model memory, session memory, search snippets, or third-party pages
   as evidence in the deliverable.
3. Give every `CONFIRMED` and `CHANGED` row at least one official URL.
4. Mark an absent official claim `NOT FOUND` and provide a concrete,
   fail-closed repository fallback. Never turn absence into a factual claim of
   impossibility.
5. Preserve the five columns: `feature | status | spec | source or fallback
   plan | verified date`.

## Refresh workflow

1. Read `STATE.md` when present and load every skill listed under Active
   skills. Read the current `docs/platform-facts.md` in full.
2. Locate the controlling build plan and re-read any appendix that seeds the
   fact inventory. Compare every seed row with the ledger before live research.
   If a previously missing appendix appears, remove the stale absence claim and
   record the reconciliation; do not inherit the old limitation from
   `STATE.md`.
3. Record the current date and inspect the official indexes:
   - `https://docs.claude.com/llms.txt`
   - `https://code.claude.com/docs/llms.txt`
   - `https://claude.com/blog`
   - `https://www.anthropic.com/news`
4. Fetch direct Markdown pages where available. Follow redirects and retain a
   human-facing official URL in the table.
5. Resolve source conflicts with this precedence:
   - current feature reference over an older launch post;
   - model lifecycle page for retirement state;
   - pricing page for rates;
   - dated news for availability chronology.
6. Reconcile the complete first-party model inventory: latest general models,
   limited-access models, still-callable legacy models, canonical IDs and
   aliases, context and output limits, base input/output MTok prices,
   introductory-price end dates, and retirement dates.
7. Recheck every named feature's exact control surface, minimum version,
   availability, provider/plan limits, environment and connector access, cost
   caveats, and safety or refusal contract.
8. Search the full official indexes for every `NOT FOUND` term. Keep the local
   fallback until a live official page documents the capability.
9. Update every row date, the edition date, and the next due date exactly 30
   days later. Trigger an earlier refresh for launches, retirements, pricing
   changes, or preview-access changes.

If the controlling appendix is unavailable, disclose that limitation and seed
only from explicitly supplied rows. Never reconstruct an unseen appendix from
memory.

## Acceptance check

Run:

```bash
bash .codex/skills/verify-platform-facts/scripts/check-platform-facts.sh
git diff --check -- docs/platform-facts.md
```

Then manually compare each factual clause with the linked page. A successful
link check proves reachability, not semantic accuracy.

Record the manual review receipt under `STATE.md` > `Verified facts`:

- verification date and reviewer;
- counts of `CONFIRMED`, `CHANGED`, and `NOT FOUND` rows;
- first-party model count and any lifecycle conflict resolution;
- unique live-link count;
- acceptance-check commands and results;
- unresolved appendix or source-coverage limitations.

Do not close the gate from checker output alone. Close it only after this
semantic receipt exists and every row is covered.

## Changelog

- 2026-07-10: Added controlling-appendix reconciliation after a restored build
  plan exposed a stale "appendix absent" claim that structural and link checks
  did not catch.
