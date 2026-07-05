---
ijfw_version: 1.3.2
ijfw_schema: 1
type: business
primary_type: business
secondary_types: []
confidence: 0.609
detected_at: 2026-07-05T15:01:30.502Z
signals:
  - kind: dir_business
    weight: 0.4
    name: runbooks
---
# Repository Guidelines

## Project Structure & Module Organization

This is a TypeScript/Node monorepo. Keep apps thin and domain logic in packages.

- `apps/gateway/`: Fastify HTTP/SSE gateway and dashboard host.
- `apps/control-ui/`: server-rendered work-item dashboard.
- `apps/worker/`: one-shot worker for approved work.
- `packages/shared/`: schemas, IDs, errors, and redaction.
- `packages/work-items/`, `policy-gate/`, `audit-log/`, `eval-harness/`, `temporal-memory/`, `sandbox/`: layered domain packages.
- `storage/migrations/`: SQLite schema.
- `docs/`: architecture, threat model, and runbooks.

## Build, Test, and Development Commands

- `npm install`: install workspace dependencies.
- `npm run build`: compile every app and package with `tsc -b`.
- `npm test`: run Vitest tests.
- `npm run check`: build, then test.
- `ACS_DB_PATH=storage/local.db npm run start:gateway`: run the local gateway at `127.0.0.1:3000`.
- `ACS_DB_PATH=storage/local.db npm run start:worker`: execute one approved work item.

## Coding Style & Naming Conventions

Use strict TypeScript, ESM, two-space JSON, and small named exports. Package names use `@agent-control-stack/<name>`. Keep dependency direction inward: apps may depend on packages, but packages must not depend on apps. Prefer Zod schemas at trust boundaries and OpenTelemetry-shaped audit events with `name`, `timeUnixNano`, `attributes`, and `body`.

## Testing Guidelines

Use Vitest for behavior tests. Put tests beside the code as `*.test.ts`. Focus tests on lifecycle, policy, replay, and storage behavior. For SQLite tests, use temporary database files and clean them up.

## Commit & Pull Request Guidelines

No usable Git history is present, so use concise imperative subjects, for example `Add audit log replay test`. Pull requests should include changed paths, validation commands, linked issues if any, and screenshots only when UI behavior changed.

## Security & Configuration Tips

Never log secrets. Redaction belongs in `packages/shared`; approval rules belong in `packages/policy-gate`; execution isolation belongs behind `packages/sandbox`. The sandbox is dry-run until real isolation such as firejail, nsjail, bubblewrap, or Docker is wired in.

<!-- IJFW-MEMORY-START -->
Project memory at .ijfw/memory/. Call `ijfw_memory_prelude` for full context.
<!-- IJFW-MEMORY-END -->

<!-- IJFW-AGENTS-START -->
No project agents yet. Run `ijfw team` to set them up.
<!-- IJFW-AGENTS-END -->
