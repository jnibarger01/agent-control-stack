---
name: procedural-learning
description: Retrieve verified ACS skills before engineering work.
---

# Procedural learning

Use ACS-promoted skills as guidance only. They never authorize merges, deploys,
credential changes, or policy bypasses.

## When to Use

- Starting a non-trivial engineering investigation
- After a verified successful repair that should become reusable
- Inspecting what agents learned and whether a skill is useful or failing

## Procedure

1. Classify the problem signals, error text, repository technology, and task type.
2. Retrieve before investigating:

```bash
acs skills retrieve --problem "<signals>" --error "<message>" --tech <tech> --type <task-type>
```

3. ACS claims the work item, derives a problem signature, and automatically retrieves matching skills.
4. The worker injects retrieved skill IDs/versions into the execution context before execute/spawn.
5. After execution, record `used` separately from `retrieved`. Confidence changes only when used AND the independent validator PASSes.
6. Restart the worker and submit a similar task; the same skill must be injected again without any `acs skills retrieve` command.

## Acceptance check

```bash
npx vitest run packages/procedural-learning/src/learning.test.ts packages/procedural-learning/src/execution-bridge.test.ts apps/worker/src/learning-loop.e2e.test.ts
```

## Changelog

- 2026-08-18: Created from the verified experience → promotion → retrieval loop.
