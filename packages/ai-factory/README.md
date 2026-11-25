# ACS AI Factory F0

This is an **internal TypeScript project**, not an activated npm workspace, runtime or API. F0 only parses untrusted intent and deterministically produces proposal-only hashes. It must never be accepted as a policy/approval/lease/capability token.

F1/F2 will add workspace metadata, update the root package lockfile and wire an authenticated ACS admission path. Keeping this directory off the workspace lockfile in F0 avoids an incomplete `npm ci` transition. The root TypeScript project graph includes it.

Run `npx vitest run packages/ai-factory/src/plan.test.ts packages/ai-factory/src/architecture.test.ts`. See `docs/ai-factory/README.md`.

