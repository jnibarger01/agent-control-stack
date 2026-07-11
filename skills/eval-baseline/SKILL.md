---
name: eval-baseline
description: Run and compare the repository's fixed, costed evaluation corpus. Use when establishing a baseline, verifying an improvement claim, checking grader variance, or reconciling predicted model-token cost with live provider receipts.
---

# Eval Baseline

Keep baseline claims tied to immutable task content, isolated grading, exact
model receipts, and actual provider cost.

## Procedure

1. Read `STATE.md`, `evals/README.md`, `harness/routing.md`, and the current
   `docs/platform-facts.md` pricing rows.
2. Run `npm run check`. Do not spend on a live baseline while the local gate is
   red.
3. Hash the unchanged corpus:
   `sha256sum evals/tasks/*.json | sha256sum`.
4. Run the corpus twice with explicit, distinct output paths under `runs/`:
   `scripts/run-evals --provider claude-cli --output <path>`.
5. Require the runner to print predicted spend before the first provider call
   and actual spend after the result is written.
6. Validate both JSON files, exact model IDs, criterion totals, cost fields, and
   absence of secret material. A failed or partial invocation with no result
   JSON is not a baseline.
7. Compare normalized scores without changing tasks between runs. The initial
   repository variance bound is absolute delta `<= 0.10`; document any larger
   delta as an open failure rather than averaging it away.
8. Record both paths, corpus hash, scores, costs, exact models, and delta in
   `STATE.md`.

## Cost receipt rule

The routing estimator prices task-estimated base tokens. Claude CLI actual cost
may also include execution context, cache creation, and internal calls. Retain
both values. Never present predicted cost as the billing receipt or silently
replace prediction with actual after execution.

## Acceptance check

```bash
npm run check
jq -e '.schemaVersion == 1 and .provider == "claude-cli"' runs/*-eval-baseline-1.json
jq -e '.schemaVersion == 1 and .provider == "claude-cli"' runs/*-eval-baseline-2.json
sha256sum evals/tasks/*.json | sha256sum
```

Manually confirm the two run scores differ by no more than the documented
variance bound and that `STATE.md` contains the full receipt.

## Changelog

- 2026-07-09: Created after live baselines showed CLI actual spend materially
  exceeding base-token prediction; added the dual-receipt and corpus-hash gate.
