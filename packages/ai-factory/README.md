# ACS AI Factory contracts

Pure, side-effect-free contracts for the AI Factory: intent parsing and proposal hashing (F0), principal-bound preview (F1), admission mapping onto existing ACS coding missions (F2), and plan DAG validation (F3). `src/architecture.test.ts` enforces that no module here imports network, process, filesystem, database or authority packages.

Runtime pieces with side effects live in `packages/ai-factory-runtime`, and HTTP routes in `apps/gateway/src/factory-intake.ts`. Status: `docs/ai-factory/implementation-status.md`.

Run: `npx vitest run packages/ai-factory`.
