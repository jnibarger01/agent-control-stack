# Rust migration plan: acs-rust-pilot-20261118 (TypeScript/JavaScript)

59 packages, 828 source files (184588 lines), 643 test files, 25 UI files, grouped into 599 units.

| Ready | Caution | Blocked | Keep in source language |
| ---: | ---: | ---: | ---: |
| 463 | 111 | 4 | 21 |

## Start here

Best first ports: safe to port (readiness) and worth porting (loops and string work, tests, size).

| # | Unit | Lines | Priority | Readiness | Tests | Bridge | Main risks |
| ---: | --- | ---: | ---: | ---: | ---: | --- | --- |
| 1 | `packages/integration-manager/src/graph.ts` | 136 | 95 | 96 | 1 | napi-rs | Insertion-ordered maps and object keys (13) |
| 2 | `apps/gateway/src/public-contract-compatibility.ts` | 46 | 88 | 100 | 1 | napi-rs | Insertion-ordered maps and object keys (1) |
| 3 | `packages/black-box-recorder/src/load.ts` | 53 | 87 | 100 | 1 | napi-rs | Async and promises (4); Reflection and prototypes (1) |
| 4 | `packages/looptrace-query/src/sanitize.ts` | 123 | 87 | 84 | 1 | napi-rs | String offsets and slicing (10); Insertion-ordered maps and object keys (3); JSON round-trips (2) |
| 5 | `packages/black-box-recorder/src/redact.ts` | 66 | 86 | 89 | 2 | napi-rs | String offsets and slicing (4); Regex features the `regex` crate lacks (1); Insertion-ordered maps and object keys (1) |
| 6 | `apps/gateway/src/metrics.ts` | 97 | 86 | 89 | 1 | napi-rs | String offsets and slicing (3); Insertion-ordered maps and object keys (5); Callback-shaped APIs (1) |
| 7 | `packages/policy-gate/src/command-policy-corpus.test-support.ts` | 184 | 84 | 100 | 1 | napi-rs | JSON round-trips (6) |
| 8 | `packages/work-items/src/authority-narrowing.ts` | 86 | 84 | 100 | 1 | napi-rs | Insertion-ordered maps and object keys (2); Exceptions (1) |
| 9 | `packages/coding-mission/src/mission-intelligence.ts` | 147 | 84 | 98 | 1 | napi-rs | Insertion-ordered maps and object keys (6); Exceptions (1) |
| 10 | `packages/shared/src/redact.ts` | 99 | 84 | 89 | 1 | napi-rs | String offsets and slicing (3); Insertion-ordered maps and object keys (6); Exceptions (1) |

### `packages/integration-manager/src/graph.ts`

136 lines in 1 files, wave 1, priority 95, readiness 96, bridge **napi-rs**.

- 1 test files import it directly.
- Insertion-ordered maps and object keys x13: `packages/integration-manager/src/graph.ts:22`, `packages/integration-manager/src/graph.ts:28`, `packages/integration-manager/src/graph.ts:29`

### `apps/gateway/src/public-contract-compatibility.ts`

46 lines in 1 files, wave 0, priority 88, readiness 100, bridge **napi-rs**.

- Leaf: imports no other unit.
- 1 test files import it directly.
- Insertion-ordered maps and object keys x1: `apps/gateway/src/public-contract-compatibility.ts:24`

### `packages/black-box-recorder/src/load.ts`

53 lines in 1 files, wave 3, priority 87, readiness 100, bridge **napi-rs**.

- 2 imports use aliases or virtual modules and were not followed.
- 1 test files import it directly.
- Async and promises x4: `packages/black-box-recorder/src/load.ts:31`, `packages/black-box-recorder/src/load.ts:40`, `packages/black-box-recorder/src/load.ts:44`
- Reflection and prototypes x1: `packages/black-box-recorder/src/load.ts:29`

### `packages/looptrace-query/src/sanitize.ts`

123 lines in 1 files, wave 0, priority 87, readiness 84, bridge **napi-rs**.

- Leaf: imports no other unit.
- 1 test files import it directly.
- String offsets and slicing x10: `packages/looptrace-query/src/sanitize.ts:34`, `packages/looptrace-query/src/sanitize.ts:35`, `packages/looptrace-query/src/sanitize.ts:37`
- Insertion-ordered maps and object keys x3: `packages/looptrace-query/src/sanitize.ts:37`, `packages/looptrace-query/src/sanitize.ts:68`, `packages/looptrace-query/src/sanitize.ts:105`
- JSON round-trips x2: `packages/looptrace-query/src/sanitize.ts:73`, `packages/looptrace-query/src/sanitize.ts:73`

### `packages/black-box-recorder/src/redact.ts`

66 lines in 1 files, wave 0, priority 86, readiness 89, bridge **napi-rs**.

- Leaf: imports no other unit.
- 2 test files import it directly.
- String offsets and slicing x4: `packages/black-box-recorder/src/redact.ts:20`, `packages/black-box-recorder/src/redact.ts:24`, `packages/black-box-recorder/src/redact.ts:60`
- Regex features the `regex` crate lacks x1: `packages/black-box-recorder/src/redact.ts:49`
- Insertion-ordered maps and object keys x1: `packages/black-box-recorder/src/redact.ts:24`
- JSON round-trips x1: `packages/black-box-recorder/src/redact.ts:68`

## Order by package

Packages come after the workspace packages they use. Inside a package, port by wave: a unit's imports are in earlier waves.

### 1. agent-control-stack (`.`, node, 35 test files)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `contracts/public/v1/` | ready | 368 | 95 | napi-rs | Insertion-ordered maps and object keys (5) |
| 0 | `evals/graders/` | ready | 128 | 92 | napi-rs | Insertion-ordered maps and object keys (4); Async and promises (2) |
| 0 | `harness/` | caution | 2326 | 0 | napi-rs | String offsets and slicing (2); Async and promises (32) |
| 1 | `evals/` | caution | 1631 | 22 | napi-rs | String offsets and slicing (4); Async and promises (36) |
| 4 | `scripts/` | blocked | 3251 | 0 | napi-rs | String offsets and slicing (52); Dynamic code (eval, new Function, computed import) (2) |

### 2. @agent-control-stack/chatgpt-widget (`apps/chatgpt-widget`, portable, 0 test files)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `apps/chatgpt-widget/src/main.tsx` | keep | 402 | 72 | keep | Async and promises (5); Callback-shaped APIs (4) |

### 3. @agent-control-stack/dc-relay (`apps/dc-relay`, node, 8 test files)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `apps/dc-relay/src/pairing-crypto.ts` | ready | 73 | 99 | napi-rs | Exceptions (3) |
| 0 | `apps/dc-relay/src/pages.ts` | ready | 151 | 98 | napi-rs | JSON round-trips (1) |
| 0 | `apps/dc-relay/src/pairing-store.ts` | ready | 248 | 65 | napi-rs | String offsets and slicing (2); Async and promises (21) |
| 0 | `apps/dc-relay/src/service.ts` | caution | 237 | 58 | napi-rs | String offsets and slicing (1); Async and promises (47) |
| 1 | `apps/dc-relay/src/mcp.ts` | caution | 158 | 83 | napi-rs | Async and promises (11); Callback-shaped APIs (2) |
| 1 | `apps/dc-relay/src/supabase-store.ts` | ready | 204 | 79 | napi-rs | Async and promises (32); Callback-shaped APIs (1) |
| 2 | `apps/dc-relay/src/server.ts` | ready | 370 | 59 | napi-rs | String offsets and slicing (4); Async and promises (36) |

### 4. @agent-control-stack/jace-commander (`apps/jace-commander`, node, 36 test files)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `apps/jace-commander/src/child-env.ts` | ready | 14 | 100 | napi-rs | - |
| 0 | `apps/jace-commander/src/credential-paths.ts` | ready | 33 | 100 | napi-rs | - |
| 0 | `apps/jace-commander/src/version.ts` | ready | 11 | 98 | napi-rs | Exceptions (1); JSON round-trips (1) |
| 0 | `apps/jace-commander/deploy/` | ready | 23 | 97 | napi-rs | Async and promises (1) |
| 0 | `apps/jace-commander/src/passkey-ceremony.ts` | ready | 117 | 90 | napi-rs | Callback-shaped APIs (2); Async and promises (1) |
| 0 | `apps/jace-commander/src/canonical-json.ts` | ready | 76 | 83 | napi-rs | Reflection and prototypes (4); Dynamic typing (3) |
| 0 | `apps/jace-commander/src/root-controlled-file.ts` | caution | 153 | 82 | napi-rs | Callback-shaped APIs (11); Class inheritance (1) |
| 0 | `apps/jace-commander/src/gui.ts` | caution | 196 | 81 | napi-rs | Async and promises (6); Insertion-ordered maps and object keys (2) |
| 0 | `apps/jace-commander/src/approver-client.ts` | ready | 67 | 80 | napi-rs | String offsets and slicing (2); Async and promises (5) |
| 0 | `apps/jace-commander/src/credential-scan.ts` | ready | 179 | 77 | napi-rs | String offsets and slicing (12); Insertion-ordered maps and object keys (2) |
| 0 | `apps/jace-commander/src/mcp-auth.ts` | ready | 265 | 76 | napi-rs | Async and promises (25); Insertion-ordered maps and object keys (3) |
| 0 | `apps/jace-commander/src/device-login.ts` | ready | 194 | 74 | napi-rs | String offsets and slicing (1); Async and promises (12) |
| 0 | `apps/jace-commander/src/executor-lease.ts` | ready | 333 | 74 | napi-rs | String offsets and slicing (2); Dynamic typing (4) |
| 0 | `apps/jace-commander/src/looptrace.ts` | ready | 259 | 70 | napi-rs | Regex features the `regex` crate lacks (1); Insertion-ordered maps and object keys (3) |
| 0 | `apps/jace-commander/verify/` | ready | 215 | 65 | napi-rs | String offsets and slicing (2); Async and promises (55) |
| 0 | `apps/jace-commander/src/manifest.generated.ts` | ready | 1539 | 64 | napi-rs | - |
| 0 | `apps/jace-commander/src/documents.ts` | ready | 144 | 58 | napi-rs | String offsets and slicing (14); Regexes built at runtime (1) |
| 0 | `apps/jace-commander/src/mcp-http-client.ts` | ready | 416 | 51 | napi-rs | String offsets and slicing (3); Async and promises (26) |
| 1 | `apps/jace-commander/src/tool-descriptors.ts` | ready | 17 | 100 | napi-rs | Reflection and prototypes (2) |
| 1 | `apps/jace-commander/src/mirror-outbox.ts` | caution | 212 | 79 | napi-rs | String offsets and slicing (3); Async and promises (2) |
| 1 | `apps/jace-commander/src/contract.ts` | ready | 347 | 72 | napi-rs | Reflection and prototypes (8); Insertion-ordered maps and object keys (4) |
| 1 | `apps/jace-commander/src/cli-commands.ts` | ready | 700 | 58 | napi-rs | String offsets and slicing (14); Insertion-ordered maps and object keys (4) |
| 2 | `apps/jace-commander/src/current-authority.ts` | ready | 70 | 98 | napi-rs | Exceptions (2) |
| 2 | `apps/jace-commander/src/config.ts` | ready | 135 | 83 | napi-rs | String offsets and slicing (1); Reflection and prototypes (2) |
| 2 | `apps/jace-commander/src/local-token.ts` | ready | 187 | 79 | napi-rs | Reflection and prototypes (4); Callback-shaped APIs (2) |
| 2 | `apps/jace-commander/src/providers.ts` | ready | 179 | 79 | napi-rs | Reflection and prototypes (7); Async and promises (6) |
| 2 | `apps/jace-commander/src/integrations.ts` | ready | 237 | 70 | napi-rs | Async and promises (6); Insertion-ordered maps and object keys (1) |
| 3 | `apps/jace-commander/src/approval-protocol.ts` | ready | 238 | 77 | napi-rs | Callback-shaped APIs (6); Async and promises (5) |
| 3 | `apps/jace-commander/src/passkey-verifier.ts` | ready | 198 | 75 | napi-rs | Insertion-ordered maps and object keys (3); Callback-shaped APIs (3) |
| 3 | `apps/jace-commander/src/authorizers.ts` | ready | 160 | 73 | napi-rs | Reflection and prototypes (13); Insertion-ordered maps and object keys (4) |
| 3 | `apps/jace-commander/src/privileged-core.ts` | ready | 450 | 63 | napi-rs | String offsets and slicing (1); Insertion-ordered maps and object keys (4) |
| 3 | `apps/jace-commander/src/sandbox.ts` | ready | 315 | 62 | napi-rs | String offsets and slicing (7); Insertion-ordered maps and object keys (4) |
| 3 | `apps/jace-commander/src/approverd.ts` | ready | 687 | 51 | napi-rs | String offsets and slicing (2); Async and promises (14) |
| 4 | `apps/jace-commander/src/privileged-helper.ts` | ready | 64 | 95 | napi-rs | Async and promises (4); Exceptions (2) |
| 4 | `apps/jace-commander/src/privileged-client.ts` | ready | 71 | 94 | napi-rs | Async and promises (2); JSON round-trips (2) |
| 4 | `apps/jace-commander/src/approverd-cli.ts` | ready | 51 | 91 | napi-rs | String offsets and slicing (2); Async and promises (2) |
| 4 | `apps/jace-commander/src/passkey-register.ts` | ready | 95 | 83 | napi-rs | String offsets and slicing (2); Async and promises (4) |
| 4 | `apps/jace-commander/src/approve-cli.ts` | caution | 153 | 75 | napi-rs | String offsets and slicing (3); Async and promises (8) |
| 4 | `apps/jace-commander/src/doctor.ts` | ready | 245 | 74 | napi-rs | String offsets and slicing (2); Async and promises (12) |
| 4 | `apps/jace-commander/src/local-policy.ts` | ready | 427 | 71 | napi-rs | Insertion-ordered maps and object keys (10); Reflection and prototypes (5) |
| 4 | `apps/jace-commander/src/filesystem.ts` | caution | 506 | 43 | napi-rs | String offsets and slicing (6); Async and promises (49) |
| 5 | `apps/jace-commander/src/mutations.ts` | ready | 186 | 73 | napi-rs | String offsets and slicing (4); Async and promises (34) |
| 5 | `apps/jace-commander/src/git-ops.ts` | ready | 224 | 66 | napi-rs | String offsets and slicing (10); Async and promises (45) |
| 5 | `apps/jace-commander/src/processes.ts` | caution | 231 | 66 | napi-rs | String offsets and slicing (3); Async and promises (14) |
| 5 | `apps/jace-commander/src/search.ts` | caution | 269 | 62 | napi-rs | String offsets and slicing (2); Regexes built at runtime (2) |
| 6 | `apps/jace-commander/src/server.ts` | caution | 696 | 41 | napi-rs | String offsets and slicing (1); Async and promises (111) |
| 7 | `apps/jace-commander/src/cli.ts` | ready | 466 | 53 | napi-rs | String offsets and slicing (11); Async and promises (20) |

### 5. agent-control-stack-public-site (`apps/public-site`, portable, 0 test files)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `apps/public-site/src/fixtures.js` | ready | 209 | 92 | wasm-bindgen | - |
| 1 | `apps/public-site/scripts/` | ready | 75 | 91 | napi-rs | Async and promises (10) |
| 1 | `apps/public-site/src/App.jsx` | keep | 500 | 86 | keep | - |
| 2 | `apps/public-site/src/main.jsx` | keep | 9 | 96 | keep | - |

### 6. agentos-contracts (`packages/agentos-contracts`, node, 4 test files)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/agentos-contracts/src/promotion-gate.js` | ready | 104 | 98 | napi-rs | Dynamic typing (4); Reflection and prototypes (2) |
| 0 | `packages/agentos-contracts/src/failure-taxonomy.js` | ready | 32 | 96 | napi-rs | Insertion-ordered maps and object keys (1); Reflection and prototypes (1) |
| 0 | `packages/agentos-contracts/src/envelope.js` | ready | 112 | 88 | napi-rs | String offsets and slicing (1); Reflection and prototypes (7) |
| 1 | `packages/agentos-contracts/src/risk-policy.js` | ready | 79 | 100 | napi-rs | Reflection and prototypes (2) |
| 1 | `packages/agentos-contracts/src/trace-events.js` | ready | 144 | 91 | napi-rs | Regex features the `regex` crate lacks (1); Insertion-ordered maps and object keys (3) |
| 2 | `packages/agentos-contracts/src/router.js` | ready | 81 | 100 | napi-rs | Reflection and prototypes (1) |
| 3 | `packages/agentos-contracts/src/index.js` | ready | 13 | 100 | napi-rs | - |

### 7. @agent-control-stack/black-box-recorder (`packages/black-box-recorder`, node, 7 test files)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/black-box-recorder/src/flag.ts` | ready | 7 | 100 | napi-rs | - |
| 0 | `packages/black-box-recorder/src/types.ts` | ready | 102 | 95 | napi-rs | - |
| 0 | `packages/black-box-recorder/src/canonical.ts` | ready | 52 | 92 | napi-rs | String offsets and slicing (1); Async and promises (2) |
| 0 | `packages/black-box-recorder/src/redact.ts` | ready | 66 | 89 | napi-rs | String offsets and slicing (4); Regex features the `regex` crate lacks (1) |
| 1 | `packages/black-box-recorder/src/fixture.ts` | ready | 265 | 94 | napi-rs | - |
| 1 | `packages/black-box-recorder/src/provenance.ts` | ready | 63 | 94 | napi-rs | String offsets and slicing (1); Async and promises (3) |
| 2 | `packages/black-box-recorder/src/signing.ts` | ready | 20 | 100 | napi-rs | Exceptions (2) |
| 2 | `packages/black-box-recorder/src/store.ts` | ready | 242 | 67 | napi-rs | String offsets and slicing (3); Async and promises (14) |
| 3 | `packages/black-box-recorder/src/acs-emitter.ts` | ready | 76 | 100 | napi-rs | Async and promises (2) |
| 3 | `packages/black-box-recorder/src/load.ts` | ready | 53 | 100 | napi-rs | Async and promises (4); Reflection and prototypes (1) |
| 3 | `packages/black-box-recorder/src/analyze.ts` | ready | 649 | 69 | napi-rs | String offsets and slicing (4); Insertion-ordered maps and object keys (14) |
| 4 | `packages/black-box-recorder/src/index.ts` | ready | 42 | 100 | napi-rs | - |

### 8. @agent-control-stack/dc-tool-manifest (`packages/dc-tool-manifest`, portable, 4 test files)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/dc-tool-manifest/src/argument-schemas.ts` | ready | 265 | 92 | wasm-bindgen | Reflection and prototypes (1) |
| 1 | `packages/dc-tool-manifest/src/manifest.ts` | ready | 264 | 82 | wasm-bindgen | Reflection and prototypes (8); Insertion-ordered maps and object keys (4) |
| 2 | `packages/dc-tool-manifest/src/contracts.ts` | ready | 60 | 98 | wasm-bindgen | Insertion-ordered maps and object keys (2) |
| 3 | `packages/dc-tool-manifest/src/index.ts` | ready | 3 | 100 | wasm-bindgen | - |

### 9. @agent-control-stack/jc-tool-manifest (`packages/jc-tool-manifest`, node, 5 test files)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/jc-tool-manifest/src/argument-schemas.ts` | ready | 294 | 81 | napi-rs | String offsets and slicing (1); Reflection and prototypes (4) |
| 1 | `packages/jc-tool-manifest/src/manifest.ts` | ready | 951 | 69 | napi-rs | Reflection and prototypes (8); Insertion-ordered maps and object keys (3) |
| 2 | `packages/jc-tool-manifest/src/index.ts` | ready | 21 | 100 | napi-rs | - |

### 10. @agent-control-stack/execution-admission (`packages/execution-admission`, node, 9 test files, uses @agent-control-stack/dc-tool-manifest, @agent-control-stack/jc-tool-manifest)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/execution-admission/src/index.ts` | ready | 526 | 65 | napi-rs | String offsets and slicing (2); Callback-shaped APIs (16) |

### 11. @agent-control-stack/mission-control-contract (`packages/mission-control-contract`, portable, 7 test files)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/mission-control-contract/src/overview.ts` | ready | 219 | 96 | wasm-bindgen | - |
| 0 | `packages/mission-control-contract/src/queue-trace.ts` | ready | 153 | 94 | wasm-bindgen | - |
| 1 | `packages/mission-control-contract/src/actions.ts` | ready | 107 | 100 | wasm-bindgen | - |
| 1 | `packages/mission-control-contract/src/audit.ts` | ready | 41 | 100 | wasm-bindgen | - |
| 1 | `packages/mission-control-contract/src/registry.ts` | ready | 82 | 100 | wasm-bindgen | - |
| 2 | `packages/mission-control-contract/src/index.ts` | ready | 5 | 95 | wasm-bindgen | - |

### 12. @agent-control-stack/mission-control-web (`apps/mission-control-web`, node, 13 test files, uses @agent-control-stack/mission-control-contract)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `apps/mission-control-web/public/` | ready | 10 | 100 | napi-rs | Exceptions (1) |
| 3 | `apps/mission-control-web/src/data/` | keep | 440 | 51 | keep | String offsets and slicing (3); Async and promises (18) |
| 4 | `apps/mission-control-web/src/features/assistant/` | keep | 100 | 100 | keep | - |
| 4 | `apps/mission-control-web/src/design/` | keep | 289 | 62 | keep | String offsets and slicing (4); Callback-shaped APIs (4) |
| 5 | `apps/mission-control-web/src/features/policy/` | keep | 35 | 100 | keep | - |
| 5 | `apps/mission-control-web/src/features/queue/` | keep | 116 | 98 | keep | Insertion-ordered maps and object keys (2) |
| 5 | `apps/mission-control-web/src/features/system/` | keep | 41 | 97 | keep | Async and promises (3) |
| 5 | `apps/mission-control-web/src/features/registry/` | keep | 178 | 95 | keep | String offsets and slicing (1); Exceptions (1) |
| 5 | `apps/mission-control-web/src/features/trace/` | keep | 143 | 95 | keep | - |
| 5 | `apps/mission-control-web/src/features/actions/` | keep | 123 | 86 | keep | Callback-shaped APIs (3); Async and promises (2) |
| 5 | `apps/mission-control-web/src/features/audit/` | keep | 133 | 83 | keep | Insertion-ordered maps and object keys (3); Callback-shaped APIs (3) |
| 5 | `apps/mission-control-web/src/features/black-box/` | keep | 297 | 79 | keep | String offsets and slicing (5); Async and promises (4) |
| 5 | `apps/mission-control-web/src/features/command/` | keep | 582 | 68 | keep | String offsets and slicing (5); Insertion-ordered maps and object keys (7) |
| 6 | `apps/mission-control-web/src/features/metrics/` | keep | 36 | 100 | keep | - |
| 6 | `apps/mission-control-web/src/shell/` | keep | 206 | 97 | keep | Callback-shaped APIs (1) |
| 6 | `apps/mission-control-web/src/features/approvals/` | keep | 74 | 92 | keep | Insertion-ordered maps and object keys (1); Callback-shaped APIs (1) |
| 6 | `apps/mission-control-web/src/features/execution/` | keep | 75 | 92 | keep | Insertion-ordered maps and object keys (1); Callback-shaped APIs (1) |
| 7 | `apps/mission-control-web/src/App.tsx` | keep | 139 | 100 | keep | - |
| 8 | `apps/mission-control-web/src/main.tsx` | keep | 18 | 91 | keep | Exceptions (1) |

### 13. @agent-control-stack/moa-orchestrator (`packages/moa-orchestrator`, node, 5 test files)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/moa-orchestrator/src/errors.ts` | caution | 23 | 94 | napi-rs | Class inheritance (1) |
| 0 | `packages/moa-orchestrator/src/types.ts` | ready | 114 | 88 | napi-rs | - |
| 0 | `packages/moa-orchestrator/src/util.ts` | ready | 45 | 73 | napi-rs | String offsets and slicing (3); Async and promises (4) |
| 1 | `packages/moa-orchestrator/src/classifier.ts` | ready | 25 | 98 | napi-rs | Insertion-ordered maps and object keys (1) |
| 1 | `packages/moa-orchestrator/src/config.ts` | ready | 104 | 88 | napi-rs | Insertion-ordered maps and object keys (4); Exceptions (1) |
| 1 | `packages/moa-orchestrator/src/ports.ts` | ready | 81 | 86 | napi-rs | Callback-shaped APIs (9) |
| 2 | `packages/moa-orchestrator/src/audit.ts` | ready | 83 | 97 | napi-rs | Insertion-ordered maps and object keys (1) |
| 2 | `packages/moa-orchestrator/src/aggregator.ts` | caution | 50 | 94 | napi-rs | Async and promises (2); JSON round-trips (3) |
| 2 | `packages/moa-orchestrator/src/advisor.ts` | caution | 67 | 90 | napi-rs | String offsets and slicing (1); Async and promises (2) |
| 3 | `packages/moa-orchestrator/src/orchestrator.ts` | caution | 211 | 74 | napi-rs | String offsets and slicing (2); Async and promises (23) |
| 4 | `packages/moa-orchestrator/src/gateway.ts` | caution | 126 | 87 | napi-rs | Async and promises (9); Insertion-ordered maps and object keys (1) |
| 5 | `packages/moa-orchestrator/src/index.ts` | ready | 35 | 100 | napi-rs | - |

### 14. @agent-control-stack/recovery (`packages/recovery`, node, 2 test files)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/recovery/src/index.ts` | ready | 122 | 100 | napi-rs | Insertion-ordered maps and object keys (1) |
| 0 | `packages/recovery/src/startup.ts` | caution | 106 | 92 | napi-rs | String offsets and slicing (1); Callback-shaped APIs (6) |

### 15. @agent-control-stack/release-integrity (`packages/release-integrity`, node, 1 test files)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/release-integrity/src/index.js` | ready | 227 | 94 | napi-rs | String offsets and slicing (1); Exceptions (39) |

### 16. @agent-control-stack/dc-mcp-gateway (`apps/dc-mcp-gateway`, node, 30 test files, uses @agent-control-stack/release-integrity)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `apps/dc-mcp-gateway/atomic-json.js` | ready | 27 | 100 | napi-rs | Exceptions (5); JSON round-trips (1) |
| 0 | `apps/dc-mcp-gateway/readiness.js` | ready | 69 | 100 | napi-rs | - |
| 0 | `apps/dc-mcp-gateway/recycle-policy.js` | ready | 11 | 100 | napi-rs | - |
| 0 | `apps/dc-mcp-gateway/release-integrity.js` | ready | 3 | 100 | napi-rs | - |
| 0 | `apps/dc-mcp-gateway/acs-timing.js` | ready | 67 | 96 | napi-rs | Insertion-ordered maps and object keys (1); Exceptions (1) |
| 0 | `apps/dc-mcp-gateway/jc-routing.js` | ready | 95 | 94 | napi-rs | Insertion-ordered maps and object keys (9); Reflection and prototypes (1) |
| 0 | `apps/dc-mcp-gateway/public-edge-policy.js` | ready | 40 | 94 | napi-rs | String offsets and slicing (2); Regex features the `regex` crate lacks (1) |
| 0 | `apps/dc-mcp-gateway/t.mjs` | ready | 13 | 94 | napi-rs | Async and promises (4); Exceptions (1) |
| 0 | `apps/dc-mcp-gateway/client-attribution.js` | ready | 135 | 87 | napi-rs | String offsets and slicing (1); Insertion-ordered maps and object keys (4) |
| 0 | `apps/dc-mcp-gateway/cimd-guard.js` | ready | 178 | 85 | napi-rs | String offsets and slicing (5); Async and promises (1) |
| 1 | `apps/dc-mcp-gateway/public-edge-proxy.js` | ready | 71 | 99 | napi-rs | Insertion-ordered maps and object keys (3); Async and promises (3) |
| 1 | `apps/dc-mcp-gateway/auth-health.js` | ready | 179 | 89 | napi-rs | String offsets and slicing (1); Async and promises (4) |
| 1 | `apps/dc-mcp-gateway/managed.js` | ready | 413 | 75 | napi-rs | String offsets and slicing (1); Async and promises (7) |
| 2 | `apps/dc-mcp-gateway/server.js` | caution | 986 | 38 | napi-rs | String offsets and slicing (4); Async and promises (40) |
| 2 | `apps/dc-mcp-gateway/bridge.js` | caution | 1394 | 28 | napi-rs | String offsets and slicing (7); Async and promises (38) |

### 17. @agent-control-stack/shared (`packages/shared`, node, 77 test files)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/shared/src/hash.ts` | ready | 27 | 100 | napi-rs | Insertion-ordered maps and object keys (2); Exceptions (1) |
| 0 | `packages/shared/src/schema.ts` | ready | 12 | 100 | napi-rs | - |
| 0 | `packages/shared/src/auth-lockout.ts` | ready | 208 | 98 | napi-rs | Insertion-ordered maps and object keys (3); Exceptions (3) |
| 0 | `packages/shared/src/redact.ts` | ready | 99 | 89 | napi-rs | String offsets and slicing (3); Insertion-ordered maps and object keys (6) |
| 0 | `packages/shared/src/strict-canonical-v1.ts` | ready | 115 | 88 | napi-rs | Reflection and prototypes (4); Dynamic typing (2) |
| 0 | `packages/shared/src/migration.ts` | caution | 1103 | 38 | napi-rs | String offsets and slicing (32); Regexes built at runtime (1) |
| 1 | `packages/shared/src/audit-chain.ts` | ready | 61 | 100 | napi-rs | - |
| 2 | `packages/shared/src/audit-export.ts` | ready | 148 | 98 | napi-rs | Insertion-ordered maps and object keys (1); Exceptions (13) |
| 2 | `packages/shared/src/database-health.ts` | ready | 130 | 96 | napi-rs | Insertion-ordered maps and object keys (2); Exceptions (6) |
| 3 | `packages/shared/src/database-operations.ts` | ready | 201 | 77 | napi-rs | String offsets and slicing (4); Async and promises (7) |
| 4 | `packages/shared/src/database-backup-policy.ts` | ready | 411 | 77 | napi-rs | String offsets and slicing (1); Async and promises (20) |
| 5 | `packages/shared/src/index.ts` | ready | 43 | 100 | napi-rs | Class inheritance (1) |

### 18. @agent-control-stack/advisory (`packages/advisory`, node, 15 test files, uses @agent-control-stack/shared)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/advisory/src/admitted-plan.ts` | ready | 126 | 100 | napi-rs | JSON round-trips (2) |
| 0 | `packages/advisory/src/reviewer-grant.ts` | ready | 135 | 100 | napi-rs | - |
| 0 | `packages/advisory/src/roles.ts` | ready | 22 | 98 | napi-rs | Exceptions (1) |
| 0 | `packages/advisory/src/advisor-consultation.ts` | ready | 249 | 85 | napi-rs | String offsets and slicing (3); Insertion-ordered maps and object keys (4) |
| 1 | `packages/advisory/src/plan-proposal.ts` | ready | 106 | 100 | napi-rs | - |
| 1 | `packages/advisory/src/review-finding.ts` | ready | 126 | 100 | napi-rs | - |
| 1 | `packages/advisory/src/advisor-guidance.ts` | ready | 154 | 99 | napi-rs | Async and promises (2); Callback-shaped APIs (1) |
| 2 | `packages/advisory/src/index.ts` | ready | 88 | 100 | napi-rs | - |

### 19. @agent-control-stack/agent-cli (`packages/agent-cli`, node, 3 test files, uses @agent-control-stack/shared)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/agent-cli/src/discovery-probe.ts` | ready | 71 | 98 | napi-rs | String offsets and slicing (2); Async and promises (1) |
| 0 | `packages/agent-cli/src/catalog.ts` | caution | 268 | 90 | napi-rs | Callback-shaped APIs (1); Exceptions (1) |
| 0 | `packages/agent-cli/src/worktree.ts` | ready | 126 | 78 | napi-rs | String offsets and slicing (4); Async and promises (9) |
| 0 | `packages/agent-cli/src/tool-guard.ts` | ready | 266 | 71 | napi-rs | String offsets and slicing (4); Regex features the `regex` crate lacks (2) |
| 1 | `packages/agent-cli/src/probe.ts` | ready | 116 | 88 | napi-rs | String offsets and slicing (1); Async and promises (5) |
| 2 | `packages/agent-cli/src/runner.ts` | ready | 215 | 81 | napi-rs | String offsets and slicing (1); Callback-shaped APIs (2) |
| 3 | `packages/agent-cli/src/test-summary.ts` | ready | 112 | 90 | napi-rs | String offsets and slicing (4); Regex features the `regex` crate lacks (1) |
| 4 | `packages/agent-cli/src/index.ts` | ready | 7 | 100 | napi-rs | - |

### 20. @agent-control-stack/machine-controller (`packages/machine-controller`, node, 6 test files, uses @agent-control-stack/shared)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/machine-controller/src/config.ts` | ready | 205 | 82 | napi-rs | String offsets and slicing (4); Exceptions (5) |
| 1 | `packages/machine-controller/src/path.ts` | ready | 38 | 100 | napi-rs | Exceptions (3) |
| 2 | `packages/machine-controller/src/filesystem.ts` | ready | 194 | 89 | napi-rs | String offsets and slicing (6); Exceptions (5) |
| 2 | `packages/machine-controller/src/readonly-rules.ts` | ready | 425 | 68 | napi-rs | String offsets and slicing (12); Callback-shaped APIs (3) |
| 3 | `packages/machine-controller/src/command.ts` | ready | 234 | 81 | napi-rs | String offsets and slicing (1); Async and promises (5) |
| 4 | `packages/machine-controller/src/audit.ts` | ready | 24 | 100 | napi-rs | JSON round-trips (1) |
| 4 | `packages/machine-controller/src/direct-agent.ts` | ready | 198 | 86 | napi-rs | String offsets and slicing (2); Async and promises (5) |
| 5 | `packages/machine-controller/src/controller.ts` | caution | 119 | 89 | napi-rs | String offsets and slicing (2); Async and promises (5) |
| 6 | `packages/machine-controller/src/index.ts` | ready | 7 | 100 | napi-rs | - |

### 21. @agent-control-stack/mcp (`apps/mcp`, node, 1 test files, uses @agent-control-stack/machine-controller, @agent-control-stack/shared)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `apps/mcp/src/server.ts` | ready | 174 | 89 | napi-rs | String offsets and slicing (2); Async and promises (4) |
| 1 | `apps/mcp/src/index.ts` | ready | 1 | 100 | napi-rs | - |
| 1 | `apps/mcp/src/cli.ts` | ready | 9 | 97 | napi-rs | String offsets and slicing (2) |

### 22. @agent-control-stack/integration-manager (`packages/integration-manager`, node, 9 test files, uses @agent-control-stack/machine-controller)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/integration-manager/src/types.ts` | ready | 151 | 92 | napi-rs | Callback-shaped APIs (2) |
| 1 | `packages/integration-manager/src/fixtures.test-support.ts` | ready | 67 | 100 | napi-rs | Insertion-ordered maps and object keys (1) |
| 1 | `packages/integration-manager/src/graph.ts` | ready | 136 | 96 | napi-rs | Insertion-ordered maps and object keys (13) |
| 1 | `packages/integration-manager/src/gate.ts` | ready | 108 | 94 | napi-rs | Regexes built at runtime (2); Insertion-ordered maps and object keys (2) |
| 1 | `packages/integration-manager/src/git-simulator.ts` | caution | 130 | 78 | napi-rs | String offsets and slicing (6); Async and promises (18) |
| 1 | `packages/integration-manager/src/github-source.ts` | ready | 342 | 67 | napi-rs | String offsets and slicing (5); Regex features the `regex` crate lacks (1) |
| 2 | `packages/integration-manager/src/reconcile.ts` | caution | 164 | 84 | napi-rs | String offsets and slicing (2); Async and promises (6) |
| 3 | `packages/integration-manager/src/index.ts` | ready | 19 | 100 | napi-rs | - |

### 23. @agent-control-stack/model-broker (`packages/model-broker`, node, 6 test files, uses @agent-control-stack/machine-controller, @agent-control-stack/shared)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/model-broker/src/types.ts` | ready | 143 | 90 | napi-rs | String offsets and slicing (1) |
| 1 | `packages/model-broker/src/catalog.ts` | ready | 56 | 100 | napi-rs | Insertion-ordered maps and object keys (2); Exceptions (3) |
| 1 | `packages/model-broker/src/policy.ts` | ready | 148 | 96 | napi-rs | String offsets and slicing (1); Insertion-ordered maps and object keys (1) |
| 1 | `packages/model-broker/src/compute.ts` | ready | 91 | 92 | napi-rs | Async and promises (7); Callback-shaped APIs (7) |
| 1 | `packages/model-broker/src/discovery.ts` | ready | 116 | 88 | napi-rs | Async and promises (8); Callback-shaped APIs (5) |
| 2 | `packages/model-broker/src/evidence.ts` | ready | 168 | 93 | napi-rs | Exceptions (4); JSON round-trips (2) |
| 3 | `packages/model-broker/src/fixtures.test-support.ts` | ready | 68 | 100 | napi-rs | String offsets and slicing (1) |
| 3 | `packages/model-broker/src/broker.ts` | ready | 192 | 89 | napi-rs | Async and promises (5); Callback-shaped APIs (5) |
| 4 | `packages/model-broker/src/index.ts` | ready | 21 | 100 | napi-rs | - |

### 24. @agent-control-stack/procedural-learning (`packages/procedural-learning`, node, 4 test files, uses @agent-control-stack/shared)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/procedural-learning/src/schema.ts` | ready | 244 | 87 | napi-rs | String offsets and slicing (2); Insertion-ordered maps and object keys (4) |
| 1 | `packages/procedural-learning/src/learning.ts` | ready | 1040 | 50 | napi-rs | String offsets and slicing (10); Insertion-ordered maps and object keys (3) |
| 2 | `packages/procedural-learning/scripts/` | ready | 121 | 100 | napi-rs | JSON round-trips (1) |
| 2 | `packages/procedural-learning/src/execution-bridge.ts` | ready | 110 | 100 | napi-rs | Insertion-ordered maps and object keys (1); JSON round-trips (1) |
| 2 | `packages/procedural-learning/src/operator.ts` | ready | 108 | 92 | napi-rs | String offsets and slicing (2); Callback-shaped APIs (3) |
| 3 | `packages/procedural-learning/src/index.ts` | ready | 27 | 100 | napi-rs | - |

### 25. @agent-control-stack/secret-broker (`packages/secret-broker`, node, 2 test files, uses @agent-control-stack/shared)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/secret-broker/src/source.ts` | ready | 35 | 100 | napi-rs | Insertion-ordered maps and object keys (2); Callback-shaped APIs (1) |
| 1 | `packages/secret-broker/src/handle.ts` | caution | 60 | 100 | napi-rs | Callback-shaped APIs (2) |
| 1 | `packages/secret-broker/src/broker.ts` | caution | 407 | 81 | napi-rs | Callback-shaped APIs (6); Insertion-ordered maps and object keys (3) |
| 2 | `packages/secret-broker/src/index.ts` | ready | 11 | 100 | napi-rs | - |

### 26. @agent-control-stack/temporal-memory (`packages/temporal-memory`, portable, 0 test files, uses @agent-control-stack/shared)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/temporal-memory/src/index.ts` | ready | 32 | 99 | wasm-bindgen | - |

### 27. @agent-control-stack/vercel-bridge-contract (`packages/vercel-bridge-contract`, node, 9 test files)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/vercel-bridge-contract/src/crypto.ts` | ready | 109 | 100 | napi-rs | Exceptions (6) |
| 1 | `packages/vercel-bridge-contract/src/index.ts` | ready | 71 | 100 | napi-rs | Exceptions (1); JSON round-trips (1) |

### 28. @agent-control-stack/vercel-bridge-worker (`apps/vercel-bridge-worker`, node, 6 test files, uses @agent-control-stack/vercel-bridge-contract)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `apps/vercel-bridge-worker/src/tunnel.ts` | ready | 29 | 100 | napi-rs | Exceptions (1) |
| 0 | `apps/vercel-bridge-worker/src/oidc.ts` | caution | 74 | 95 | napi-rs | Async and promises (5); Callback-shaped APIs (2) |
| 0 | `apps/vercel-bridge-worker/src/replay-store.ts` | ready | 97 | 94 | napi-rs | String offsets and slicing (1); Insertion-ordered maps and object keys (2) |
| 1 | `apps/vercel-bridge-worker/src/worker.ts` | caution | 154 | 87 | napi-rs | Async and promises (8); Callback-shaped APIs (8) |
| 2 | `apps/vercel-bridge-worker/src/queue-runtime.ts` | caution | 115 | 86 | napi-rs | Async and promises (6); Callback-shaped APIs (6) |
| 3 | `apps/vercel-bridge-worker/src/daemon.ts` | ready | 284 | 81 | napi-rs | Async and promises (11); Callback-shaped APIs (7) |
| 4 | `apps/vercel-bridge-worker/src/cli.ts` | ready | 15 | 100 | napi-rs | Async and promises (1); Exceptions (1) |

### 29. @agent-control-stack/vercel-mcp-ingress (`apps/vercel-mcp-ingress`, node, 6 test files, uses @agent-control-stack/vercel-bridge-contract)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `apps/vercel-mcp-ingress/src/handler.ts` | caution | 171 | 79 | napi-rs | String offsets and slicing (1); Async and promises (4) |
| 1 | `apps/vercel-mcp-ingress/src/queue.ts` | caution | 111 | 88 | napi-rs | Async and promises (6); Callback-shaped APIs (6) |
| 1 | `apps/vercel-mcp-ingress/src/oauth.ts` | caution | 98 | 87 | napi-rs | String offsets and slicing (1); Async and promises (4) |
| 2 | `apps/vercel-mcp-ingress/src/auth-config.ts` | ready | 55 | 100 | napi-rs | Exceptions (4) |
| 3 | `apps/vercel-mcp-ingress/api/` | ready | 73 | 100 | napi-rs | Exceptions (1) |

### 30. @agent-control-stack/work-items (`packages/work-items`, node, 146 test files, uses @agent-control-stack/advisory, @agent-control-stack/shared)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/work-items/src/assignment.ts` | ready | 15 | 100 | napi-rs | - |
| 0 | `packages/work-items/src/execution-backend.ts` | ready | 30 | 100 | napi-rs | Exceptions (1) |
| 0 | `packages/work-items/src/liveness.ts` | ready | 25 | 100 | napi-rs | Exceptions (1) |
| 0 | `packages/work-items/src/recovery.ts` | ready | 26 | 100 | napi-rs | - |
| 0 | `packages/work-items/src/routing.ts` | ready | 257 | 100 | napi-rs | - |
| 0 | `packages/work-items/src/scheduler-firing.ts` | ready | 45 | 100 | napi-rs | - |
| 0 | `packages/work-items/src/validation.ts` | ready | 27 | 100 | napi-rs | - |
| 0 | `packages/work-items/src/worker-identity.ts` | ready | 204 | 100 | napi-rs | Exceptions (4) |
| 0 | `packages/work-items/src/publication.ts` | ready | 61 | 99 | napi-rs | - |
| 0 | `packages/work-items/src/contracts.ts` | ready | 276 | 98 | napi-rs | Insertion-ordered maps and object keys (2) |
| 0 | `packages/work-items/src/trace-event.ts` | ready | 85 | 98 | napi-rs | Insertion-ordered maps and object keys (1); Exceptions (3) |
| 0 | `packages/work-items/src/change-set-approval.ts` | ready | 46 | 97 | napi-rs | - |
| 0 | `packages/work-items/src/governance.ts` | ready | 192 | 96 | napi-rs | - |
| 0 | `packages/work-items/src/trace-outbox.ts` | ready | 419 | 72 | napi-rs | String offsets and slicing (7); Callback-shaped APIs (5) |
| 0 | `packages/work-items/src/work-item.ts` | ready | 459 | 72 | napi-rs | String offsets and slicing (1); Insertion-ordered maps and object keys (2) |
| 1 | `packages/work-items/src/state-machine.ts` | ready | 41 | 99 | napi-rs | Exceptions (2) |
| 1 | `packages/work-items/src/execution-plan.ts` | ready | 215 | 90 | napi-rs | String offsets and slicing (1); Insertion-ordered maps and object keys (1) |
| 1 | `packages/work-items/src/observation-outbox.ts` | ready | 56 | 89 | napi-rs | String offsets and slicing (1); Callback-shaped APIs (5) |
| 1 | `packages/work-items/src/change-set.ts` | ready | 235 | 74 | napi-rs | String offsets and slicing (2); Insertion-ordered maps and object keys (9) |
| 2 | `packages/work-items/src/autonomous-authority.ts` | ready | 224 | 94 | napi-rs | Insertion-ordered maps and object keys (2); Exceptions (2) |
| 2 | `packages/work-items/src/change-set-store.ts` | ready | 158 | 92 | napi-rs | Exceptions (10); JSON round-trips (4) |
| 2 | `packages/work-items/src/attempt.ts` | ready | 215 | 91 | napi-rs | - |
| 2 | `packages/work-items/src/observation-store.ts` | caution | 180 | 84 | napi-rs | String offsets and slicing (2); Callback-shaped APIs (4) |
| 3 | `packages/work-items/src/authority-narrowing.ts` | ready | 86 | 100 | napi-rs | Insertion-ordered maps and object keys (2); Exceptions (1) |
| 3 | `packages/work-items/src/change-set-approval-store.ts` | ready | 142 | 86 | napi-rs | Exceptions (12); JSON round-trips (3) |
| 3 | `packages/work-items/src/advisor-consultation.ts` | ready | 730 | 80 | napi-rs | String offsets and slicing (1); Exceptions (29) |
| 3 | `packages/work-items/src/execution-read.ts` | ready | 291 | 80 | napi-rs | String offsets and slicing (2); Insertion-ordered maps and object keys (3) |
| 4 | `packages/work-items/src/autonomous-authority-store.ts` | ready | 173 | 93 | napi-rs | Exceptions (12); JSON round-trips (2) |
| 4 | `packages/work-items/src/change-set-operation-permit.ts` | ready | 143 | 92 | napi-rs | Exceptions (5); JSON round-trips (1) |
| 5 | `packages/work-items/src/authoritative-completion-receipt.ts` | ready | 199 | 100 | napi-rs | Exceptions (1) |
| 5 | `packages/work-items/src/change-set-review.ts` | ready | 116 | 91 | napi-rs | Dynamic typing (1); Insertion-ordered maps and object keys (1) |
| 5 | `packages/work-items/src/mission-trace.ts` | caution | 251 | 86 | napi-rs | String offsets and slicing (1); Insertion-ordered maps and object keys (1) |
| 5 | `packages/work-items/src/change-set-progress.ts` | ready | 418 | 85 | napi-rs | Callback-shaped APIs (1); JSON round-trips (3) |
| 5 | `packages/work-items/src/store.ts` | caution | 10046 | 0 | napi-rs | String offsets and slicing (37); Callback-shaped APIs (188) |
| 6 | `packages/work-items/src/concurrency-race-worker.ts` | ready | 42 | 99 | napi-rs | Dynamic typing (2); Exceptions (1) |
| 6 | `packages/work-items/src/trace-race-child.ts` | ready | 12 | 99 | napi-rs | String offsets and slicing (1); Exceptions (1) |
| 6 | `packages/work-items/src/mission-time-travel.ts` | ready | 311 | 95 | napi-rs | Insertion-ordered maps and object keys (3); Exceptions (4) |
| 6 | `packages/work-items/src/actor-discovery.ts` | ready | 130 | 83 | napi-rs | String offsets and slicing (2); Async and promises (5) |
| 7 | `packages/work-items/src/index.ts` | ready | 68 | 100 | napi-rs | - |

### 31. @agent-control-stack/control-ui (`apps/control-ui`, portable, 25 test files, uses @agent-control-stack/mission-control-contract, @agent-control-stack/work-items)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `apps/control-ui/src/coding-mission-panel.ts` | ready | 107 | 100 | wasm-bindgen | - |
| 0 | `apps/control-ui/src/icons.ts` | ready | 25 | 100 | wasm-bindgen | - |
| 0 | `apps/control-ui/src/operator-impact.ts` | ready | 117 | 100 | wasm-bindgen | - |
| 0 | `apps/control-ui/src/premium-styles.ts` | ready | 158 | 99 | wasm-bindgen | - |
| 0 | `apps/control-ui/src/system-probes.ts` | ready | 99 | 99 | wasm-bindgen | - |
| 0 | `apps/control-ui/src/audit-timeline.ts` | ready | 128 | 98 | wasm-bindgen | - |
| 0 | `apps/control-ui/src/sse-connection.ts` | ready | 36 | 97 | wasm-bindgen | Callback-shaped APIs (4) |
| 0 | `apps/control-ui/src/operator-workflow.ts` | ready | 341 | 96 | wasm-bindgen | JSON round-trips (1) |
| 0 | `apps/control-ui/src/types.ts` | ready | 126 | 96 | wasm-bindgen | - |
| 0 | `apps/control-ui/src/operator-ux.ts` | ready | 140 | 95 | wasm-bindgen | String offsets and slicing (2); Exceptions (1) |
| 0 | `apps/control-ui/src/mcp-clients.ts` | ready | 276 | 93 | wasm-bindgen | - |
| 0 | `apps/control-ui/src/operator-insights.ts` | ready | 153 | 93 | wasm-bindgen | String offsets and slicing (1); Insertion-ordered maps and object keys (3) |
| 0 | `apps/control-ui/src/html.ts` | ready | 6 | 92 | wasm-bindgen | - |
| 0 | `apps/control-ui/src/live-dashboard.ts` | ready | 314 | 91 | wasm-bindgen | JSON round-trips (1) |
| 0 | `apps/control-ui/src/agent-dispatch.ts` | ready | 439 | 89 | wasm-bindgen | - |
| 0 | `apps/control-ui/src/redaction.ts` | ready | 98 | 83 | wasm-bindgen | Regexes built at runtime (3); Insertion-ordered maps and object keys (1) |
| 1 | `apps/control-ui/src/execution-mode.ts` | ready | 69 | 100 | wasm-bindgen | Insertion-ordered maps and object keys (1) |
| 1 | `apps/control-ui/src/format.ts` | ready | 12 | 100 | wasm-bindgen | - |
| 1 | `apps/control-ui/src/work-item-controls.ts` | ready | 154 | 99 | wasm-bindgen | Callback-shaped APIs (1); JSON round-trips (1) |
| 1 | `apps/control-ui/src/composer.ts` | ready | 181 | 94 | wasm-bindgen | JSON round-trips (1) |
| 1 | `apps/control-ui/src/operator-thirty-ui.ts` | ready | 563 | 89 | wasm-bindgen | JSON round-trips (1) |
| 1 | `apps/control-ui/src/approval-actions.ts` | ready | 201 | 76 | wasm-bindgen | String offsets and slicing (1); Callback-shaped APIs (14) |
| 1 | `apps/control-ui/src/visibility.ts` | ready | 265 | 76 | wasm-bindgen | String offsets and slicing (2); Insertion-ordered maps and object keys (3) |
| 1 | `apps/control-ui/src/queue-filter.ts` | ready | 192 | 72 | wasm-bindgen | String offsets and slicing (6); Callback-shaped APIs (4) |
| 2 | `apps/control-ui/src/styles.ts` | ready | 446 | 97 | wasm-bindgen | - |
| 2 | `apps/control-ui/src/agents.ts` | ready | 146 | 93 | wasm-bindgen | Insertion-ordered maps and object keys (3) |
| 3 | `apps/control-ui/src/operations-client.ts` | ready | 220 | 96 | wasm-bindgen | JSON round-trips (1) |
| 3 | `apps/control-ui/src/client-script.ts` | ready | 1323 | 68 | wasm-bindgen | JSON round-trips (5) |
| 3 | `apps/control-ui/src/render/` | ready | 1040 | 57 | wasm-bindgen | String offsets and slicing (11); Insertion-ordered maps and object keys (12) |
| 4 | `apps/control-ui/src/read-model/` | ready | 765 | 60 | wasm-bindgen | String offsets and slicing (23); Insertion-ordered maps and object keys (16) |
| 5 | `apps/control-ui/src/index.ts` | ready | 161 | 100 | wasm-bindgen | - |
| 6 | `apps/control-ui/src/live-harness.test-support.ts` | caution | 179 | 80 | wasm-bindgen | Async and promises (13); Callback-shaped APIs (10) |

### 32. @agent-control-stack/runtime (`apps/runtime`, node, 7 test files, uses @agent-control-stack/machine-controller, @agent-control-stack/work-items)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `apps/runtime/src/config.ts` | ready | 68 | 100 | napi-rs | - |
| 0 | `apps/runtime/src/auth/` | ready | 411 | 83 | napi-rs | Async and promises (11); Callback-shaped APIs (5) |
| 1 | `apps/runtime/src/index.ts` | caution | 191 | 79 | napi-rs | Async and promises (11); Insertion-ordered maps and object keys (4) |
| 2 | `apps/runtime/src/lifecycle.ts` | caution | 18 | 100 | napi-rs | - |
| 3 | `apps/runtime/src/cli.ts` | ready | 41 | 92 | napi-rs | String offsets and slicing (2); Async and promises (4) |

### 33. @agent-control-stack/acp-adapter (`packages/acp-adapter`, node, 1 test files, uses @agent-control-stack/shared, @agent-control-stack/work-items)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/acp-adapter/src/index.ts` | ready | 581 | 62 | napi-rs | String offsets and slicing (3); Async and promises (11) |

### 34. @agent-control-stack/actor-router (`packages/actor-router`, node, 14 test files, uses @agent-control-stack/shared, @agent-control-stack/work-items)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/actor-router/src/nimble-config.ts` | ready | 131 | 98 | napi-rs | Class inheritance (1); Exceptions (10) |
| 0 | `packages/actor-router/src/route-metrics.ts` | ready | 253 | 92 | napi-rs | Insertion-ordered maps and object keys (3); Callback-shaped APIs (3) |
| 0 | `packages/actor-router/src/route-shadow.ts` | caution | 87 | 83 | napi-rs | Async and promises (5); Reflection and prototypes (4) |
| 0 | `packages/actor-router/src/route-strategy.ts` | ready | 196 | 79 | napi-rs | String offsets and slicing (5); Async and promises (5) |
| 1 | `packages/actor-router/src/nimble-client.ts` | ready | 179 | 82 | napi-rs | Async and promises (5); Insertion-ordered maps and object keys (4) |
| 2 | `packages/actor-router/src/index.ts` | caution | 205 | 95 | napi-rs | Insertion-ordered maps and object keys (2); Callback-shaped APIs (2) |
| 2 | `packages/actor-router/src/authoritative.ts` | caution | 580 | 69 | napi-rs | Async and promises (9); Callback-shaped APIs (8) |
| 2 | `packages/actor-router/src/nimble.ts` | ready | 321 | 69 | napi-rs | String offsets and slicing (6); Async and promises (12) |

### 35. @agent-control-stack/jev-advisor (`packages/jev-advisor`, node, 4 test files, uses @agent-control-stack/shared, @agent-control-stack/work-items)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/jev-advisor/src/latency-projection.ts` | ready | 135 | 99 | napi-rs | - |
| 0 | `packages/jev-advisor/src/contracts/` | ready | 265 | 93 | napi-rs | Insertion-ordered maps and object keys (5); Dynamic typing (1) |
| 0 | `packages/jev-advisor/src/redaction.ts` | ready | 59 | 89 | napi-rs | String offsets and slicing (4); Insertion-ordered maps and object keys (1) |
| 0 | `packages/jev-advisor/src/trace-projection.ts` | ready | 212 | 80 | napi-rs | String offsets and slicing (3); Insertion-ordered maps and object keys (4) |
| 1 | `packages/jev-advisor/src/question-registry.ts` | ready | 65 | 91 | napi-rs | Insertion-ordered maps and object keys (4); Reflection and prototypes (2) |
| 2 | `packages/jev-advisor/src/telemetry.ts` | ready | 197 | 82 | napi-rs | String offsets and slicing (4); Insertion-ordered maps and object keys (2) |
| 2 | `packages/jev-advisor/src/index.ts` | ready | 490 | 74 | napi-rs | Async and promises (11); Insertion-ordered maps and object keys (4) |
| 3 | `packages/jev-advisor/src/intake.ts` | caution | 77 | 100 | napi-rs | Async and promises (2); Insertion-ordered maps and object keys (1) |
| 3 | `packages/jev-advisor/src/cli.ts` | caution | 95 | 80 | napi-rs | String offsets and slicing (4); Async and promises (4) |

### 36. @agent-control-stack/evidence (`packages/evidence`, node, 9 test files, uses @agent-control-stack/advisory, @agent-control-stack/jev-advisor, @agent-control-stack/shared, @agent-control-stack/work-items)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/evidence/src/observation-outbox.ts` | ready | 34 | 100 | napi-rs | - |
| 0 | `packages/evidence/src/observation.ts` | ready | 39 | 100 | napi-rs | - |
| 0 | `packages/evidence/src/workspace-revision.ts` | ready | 75 | 93 | napi-rs | String offsets and slicing (1); Async and promises (8) |
| 0 | `packages/evidence/src/read-surface.ts` | ready | 121 | 89 | napi-rs | Regex features the `regex` crate lacks (2); Callback-shaped APIs (17) |
| 1 | `packages/evidence/src/evidence-manifest.ts` | ready | 109 | 100 | napi-rs | - |
| 1 | `packages/evidence/src/observation-worker.ts` | caution | 250 | 86 | napi-rs | Async and promises (12); Callback-shaped APIs (3) |
| 1 | `packages/evidence/src/reader.ts` | caution | 205 | 73 | napi-rs | String offsets and slicing (5); Async and promises (23) |
| 2 | `packages/evidence/src/execution-receipt.ts` | ready | 435 | 89 | napi-rs | Insertion-ordered maps and object keys (3); Class inheritance (1) |
| 3 | `packages/evidence/src/canonical-receipt-binding.ts` | ready | 193 | 90 | napi-rs | String offsets and slicing (1); Insertion-ordered maps and object keys (2) |
| 4 | `packages/evidence/src/index.ts` | ready | 96 | 100 | napi-rs | - |

### 37. @agent-control-stack/evidence-mcp (`apps/evidence-mcp`, node, 2 test files, uses @agent-control-stack/advisory, @agent-control-stack/evidence, @agent-control-stack/shared, @agent-control-stack/work-items)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `apps/evidence-mcp/src/authorize.ts` | ready | 76 | 100 | napi-rs | Exceptions (7) |
| 0 | `apps/evidence-mcp/src/store-reader.ts` | ready | 117 | 98 | napi-rs | - |
| 0 | `apps/evidence-mcp/src/server.ts` | ready | 145 | 87 | napi-rs | String offsets and slicing (2); Async and promises (4) |
| 1 | `apps/evidence-mcp/src/index.ts` | ready | 9 | 100 | napi-rs | - |
| 1 | `apps/evidence-mcp/src/cli.ts` | ready | 49 | 98 | napi-rs | Async and promises (2); Exceptions (1) |

### 38. @agent-control-stack/outcome-engine (`packages/outcome-engine`, node, 10 test files, uses @agent-control-stack/integration-manager, @agent-control-stack/shared, @agent-control-stack/work-items)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/outcome-engine/src/exposure.ts` | ready | 62 | 100 | napi-rs | Callback-shaped APIs (1) |
| 0 | `packages/outcome-engine/src/fixtures.test-support.ts` | ready | 42 | 100 | napi-rs | Async and promises (1); Exceptions (1) |
| 0 | `packages/outcome-engine/src/canonical.ts` | ready | 34 | 95 | napi-rs | Insertion-ordered maps and object keys (1); Exceptions (3) |
| 0 | `packages/outcome-engine/src/readonly-gh-runner.ts` | ready | 60 | 92 | napi-rs | String offsets and slicing (2); Async and promises (2) |
| 0 | `packages/outcome-engine/src/domain.ts` | ready | 152 | 83 | napi-rs | String offsets and slicing (2); Regex features the `regex` crate lacks (1) |
| 1 | `packages/outcome-engine/src/persist.ts` | ready | 32 | 97 | napi-rs | String offsets and slicing (1); Insertion-ordered maps and object keys (2) |
| 1 | `packages/outcome-engine/src/plan.ts` | ready | 102 | 95 | napi-rs | Insertion-ordered maps and object keys (3); Class inheritance (1) |
| 1 | `packages/outcome-engine/src/criteria.ts` | ready | 65 | 94 | napi-rs | String offsets and slicing (1); Insertion-ordered maps and object keys (1) |
| 1 | `packages/outcome-engine/src/probes.ts` | ready | 292 | 84 | napi-rs | String offsets and slicing (2); Regexes built at runtime (1) |
| 2 | `packages/outcome-engine/src/verdict.ts` | ready | 206 | 93 | napi-rs | String offsets and slicing (1); Insertion-ordered maps and object keys (2) |
| 3 | `packages/outcome-engine/src/ledger.ts` | ready | 393 | 77 | napi-rs | String offsets and slicing (2); Callback-shaped APIs (4) |
| 4 | `packages/outcome-engine/src/engine.ts` | caution | 406 | 79 | napi-rs | String offsets and slicing (4); Async and promises (3) |
| 5 | `packages/outcome-engine/src/index.ts` | ready | 11 | 100 | napi-rs | - |

### 39. @agent-control-stack/policy-gate (`packages/policy-gate`, node, 53 test files, uses @agent-control-stack/actor-router, @agent-control-stack/advisory, agentos-contracts, @agent-control-stack/execution-admission, @agent-control-stack/jev-advisor, @agent-control-stack/shared, @agent-control-stack/work-items)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/policy-gate/src/advisor-requirement.ts` | ready | 33 | 100 | napi-rs | - |
| 0 | `packages/policy-gate/src/mission-classifier.ts` | ready | 70 | 100 | napi-rs | Regex features the `regex` crate lacks (1) |
| 0 | `packages/policy-gate/src/verification-policy.ts` | ready | 179 | 99 | napi-rs | Insertion-ordered maps and object keys (4) |
| 0 | `packages/policy-gate/src/contracts.ts` | ready | 153 | 93 | napi-rs | String offsets and slicing (1); Insertion-ordered maps and object keys (2) |
| 0 | `packages/policy-gate/src/mission-runner.ts` | caution | 229 | 75 | napi-rs | Async and promises (19); Dynamic typing (3) |
| 0 | `packages/policy-gate/src/command-effects.ts` | ready | 689 | 62 | napi-rs | String offsets and slicing (23); Insertion-ordered maps and object keys (7) |
| 1 | `packages/policy-gate/src/fingerprint.ts` | ready | 19 | 100 | napi-rs | - |
| 1 | `packages/policy-gate/src/jev-shadow.ts` | caution | 170 | 92 | napi-rs | Async and promises (6); Callback-shaped APIs (2) |
| 1 | `packages/policy-gate/src/mission-dispatch.ts` | caution | 204 | 89 | napi-rs | Async and promises (2); Generators (2) |
| 1 | `packages/policy-gate/src/rules.ts` | ready | 496 | 86 | napi-rs | Insertion-ordered maps and object keys (7); Reflection and prototypes (1) |
| 1 | `packages/policy-gate/src/policy.ts` | ready | 182 | 84 | napi-rs | Insertion-ordered maps and object keys (2); Callback-shaped APIs (2) |
| 2 | `packages/policy-gate/src/command-policy-corpus.test-support.ts` | ready | 184 | 100 | napi-rs | JSON round-trips (6) |
| 2 | `packages/policy-gate/src/execution-mode.ts` | ready | 133 | 100 | napi-rs | - |
| 2 | `packages/policy-gate/src/explain.ts` | ready | 63 | 100 | napi-rs | - |
| 2 | `packages/policy-gate/src/preview.ts` | caution | 45 | 100 | napi-rs | Exceptions (2) |
| 2 | `packages/policy-gate/src/change-set-policy.ts` | caution | 106 | 94 | napi-rs | Insertion-ordered maps and object keys (1); Callback-shaped APIs (1) |
| 3 | `packages/policy-gate/src/tools.ts` | ready | 732 | 76 | napi-rs | Insertion-ordered maps and object keys (2); Reflection and prototypes (1) |
| 3 | `packages/policy-gate/src/managed-authority.ts` | ready | 452 | 73 | napi-rs | String offsets and slicing (7); Callback-shaped APIs (2) |
| 4 | `packages/policy-gate/src/plan-tools.ts` | caution | 139 | 100 | napi-rs | Exceptions (4) |
| 4 | `packages/policy-gate/src/pending-approval-digest.ts` | ready | 226 | 89 | napi-rs | Async and promises (4); Callback-shaped APIs (3) |
| 4 | `packages/policy-gate/src/authoritative-dispatch.ts` | caution | 160 | 86 | napi-rs | String offsets and slicing (1); Callback-shaped APIs (4) |
| 5 | `packages/policy-gate/src/index.ts` | ready | 26 | 100 | napi-rs | - |
| 5 | `packages/policy-gate/src/pending-approval-digest-cli.ts` | ready | 8 | 100 | napi-rs | Async and promises (1); Exceptions (1) |

### 40. @agent-control-stack/scheduler (`apps/scheduler`, node, 3 test files, uses @agent-control-stack/policy-gate, @agent-control-stack/shared, @agent-control-stack/work-items)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `apps/scheduler/src/index.ts` | ready | 206 | 95 | napi-rs | Async and promises (2); Callback-shaped APIs (1) |
| 1 | `apps/scheduler/src/cli.ts` | ready | 3 | 100 | napi-rs | Async and promises (1); JSON round-trips (1) |
| 1 | `apps/scheduler/src/concurrency-probe-worker.ts` | ready | 13 | 100 | napi-rs | Async and promises (1); JSON round-trips (2) |

### 41. @agent-control-stack/desktop-commander-adapter (`packages/desktop-commander-adapter`, node, 29 test files, uses @agent-control-stack/dc-tool-manifest, @agent-control-stack/jc-tool-manifest, @agent-control-stack/machine-controller, @agent-control-stack/policy-gate, @agent-control-stack/shared, @agent-control-stack/work-items)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/desktop-commander-adapter/src/authorization-arguments.ts` | ready | 60 | 100 | napi-rs | Insertion-ordered maps and object keys (1); Exceptions (2) |
| 0 | `packages/desktop-commander-adapter/src/device-authorization.ts` | ready | 43 | 94 | napi-rs | Async and promises (2); Callback-shaped APIs (2) |
| 0 | `packages/desktop-commander-adapter/src/containment.ts` | ready | 105 | 89 | napi-rs | String offsets and slicing (1); Exceptions (12) |
| 0 | `packages/desktop-commander-adapter/src/jc-looptrace-normalizer.ts` | ready | 224 | 85 | napi-rs | String offsets and slicing (6); Insertion-ordered maps and object keys (2) |
| 0 | `packages/desktop-commander-adapter/src/tool-policy.ts` | ready | 381 | 85 | napi-rs | Insertion-ordered maps and object keys (2); Reflection and prototypes (2) |
| 0 | `packages/desktop-commander-adapter/src/mcp-stdio-client.ts` | ready | 425 | 64 | napi-rs | String offsets and slicing (5); Async and promises (12) |
| 1 | `packages/desktop-commander-adapter/src/test-fixtures.ts` | ready | 78 | 100 | napi-rs | - |
| 1 | `packages/desktop-commander-adapter/src/result.ts` | ready | 119 | 90 | napi-rs | String offsets and slicing (3) |
| 1 | `packages/desktop-commander-adapter/src/command-validation.ts` | ready | 162 | 82 | napi-rs | String offsets and slicing (5); Insertion-ordered maps and object keys (4) |
| 1 | `packages/desktop-commander-adapter/src/jace-commander.ts` | ready | 660 | 58 | napi-rs | String offsets and slicing (6); Reflection and prototypes (11) |
| 2 | `packages/desktop-commander-adapter/src/jace-commander-approval.test-support.ts` | ready | 96 | 100 | napi-rs | Exceptions (1) |
| 2 | `packages/desktop-commander-adapter/src/arguments.ts` | ready | 216 | 91 | napi-rs | Insertion-ordered maps and object keys (4); Exceptions (11) |
| 2 | `packages/desktop-commander-adapter/src/jace-commander-registry.ts` | ready | 217 | 89 | napi-rs | String offsets and slicing (4); Callback-shaped APIs (1) |
| 3 | `packages/desktop-commander-adapter/src/execution-authorization.ts` | ready | 192 | 92 | napi-rs | Reflection and prototypes (4); Exceptions (13) |
| 3 | `packages/desktop-commander-adapter/src/concurrency-scheduler/` | caution | 1234 | 38 | napi-rs | String offsets and slicing (7); Insertion-ordered maps and object keys (14) |
| 4 | `packages/desktop-commander-adapter/src/audit.ts` | ready | 267 | 97 | napi-rs | Insertion-ordered maps and object keys (1) |
| 4 | `packages/desktop-commander-adapter/src/capability.ts` | ready | 192 | 88 | napi-rs | String offsets and slicing (1); Reflection and prototypes (2) |
| 5 | `packages/desktop-commander-adapter/src/runtime-registry.ts` | ready | 534 | 70 | napi-rs | String offsets and slicing (4); Callback-shaped APIs (5) |
| 6 | `packages/desktop-commander-adapter/src/config.ts` | ready | 250 | 91 | napi-rs | Insertion-ordered maps and object keys (2); Callback-shaped APIs (2) |
| 7 | `packages/desktop-commander-adapter/src/machine-executor.ts` | caution | 445 | 73 | napi-rs | String offsets and slicing (1); Async and promises (21) |
| 8 | `packages/desktop-commander-adapter/src/index.ts` | ready | 136 | 100 | napi-rs | - |

### 42. @agent-control-stack/jace-mem-issuer (`packages/jace-mem-issuer`, node, 2 test files, uses @agent-control-stack/policy-gate, @agent-control-stack/shared, @agent-control-stack/work-items)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/jace-mem-issuer/src/manifest.ts` | ready | 159 | 88 | napi-rs | Reflection and prototypes (10) |
| 1 | `packages/jace-mem-issuer/src/issuer.ts` | ready | 415 | 71 | napi-rs | String offsets and slicing (1); Reflection and prototypes (8) |
| 2 | `packages/jace-mem-issuer/src/test-support.ts` | ready | 115 | 100 | napi-rs | Reflection and prototypes (2); Exceptions (1) |
| 2 | `packages/jace-mem-issuer/src/registry.ts` | ready | 210 | 83 | napi-rs | String offsets and slicing (4); Callback-shaped APIs (1) |
| 3 | `packages/jace-mem-issuer/src/index.ts` | ready | 36 | 100 | napi-rs | - |

### 43. @agent-control-stack/looptrace-query (`packages/looptrace-query`, node, 6 test files, uses @agent-control-stack/desktop-commander-adapter, @agent-control-stack/evidence, @agent-control-stack/shared, @agent-control-stack/work-items)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/looptrace-query/src/model.ts` | ready | 201 | 94 | napi-rs | - |
| 0 | `packages/looptrace-query/src/sanitize.ts` | ready | 123 | 84 | napi-rs | String offsets and slicing (10); Insertion-ordered maps and object keys (3) |
| 1 | `packages/looptrace-query/src/correlate.ts` | ready | 68 | 97 | napi-rs | Insertion-ordered maps and object keys (5) |
| 1 | `packages/looptrace-query/src/types.ts` | ready | 79 | 94 | napi-rs | Callback-shaped APIs (2); Class inheritance (1) |
| 2 | `packages/looptrace-query/src/authz.ts` | ready | 96 | 97 | napi-rs | Insertion-ordered maps and object keys (1); Exceptions (11) |
| 2 | `packages/looptrace-query/src/gaps.ts` | ready | 615 | 66 | napi-rs | String offsets and slicing (5); Insertion-ordered maps and object keys (10) |
| 3 | `packages/looptrace-query/src/sources/` | caution | 1275 | 33 | napi-rs | String offsets and slicing (30); Insertion-ordered maps and object keys (12) |
| 4 | `packages/looptrace-query/src/verify.ts` | ready | 371 | 68 | napi-rs | String offsets and slicing (3); Regexes built at runtime (1) |
| 5 | `packages/looptrace-query/src/service.ts` | caution | 251 | 79 | napi-rs | String offsets and slicing (6); Async and promises (4) |
| 6 | `packages/looptrace-query/src/index.ts` | ready | 11 | 100 | napi-rs | - |

### 44. @agent-control-stack/looptrace-mcp (`apps/looptrace-mcp`, node, 1 test files, uses @agent-control-stack/looptrace-query)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `apps/looptrace-mcp/src/config.ts` | ready | 48 | 94 | napi-rs | String offsets and slicing (1); Insertion-ordered maps and object keys (1) |
| 0 | `apps/looptrace-mcp/src/server.ts` | caution | 242 | 78 | napi-rs | String offsets and slicing (4); Async and promises (10) |
| 1 | `apps/looptrace-mcp/src/index.ts` | ready | 2 | 100 | napi-rs | - |
| 1 | `apps/looptrace-mcp/src/cli.ts` | ready | 59 | 94 | napi-rs | String offsets and slicing (2); Exceptions (8) |

### 45. @agent-control-stack/local-advisor (`packages/local-advisor`, node, 11 test files, uses @agent-control-stack/advisory, @agent-control-stack/looptrace-query, @agent-control-stack/model-broker, @agent-control-stack/shared, @agent-control-stack/work-items)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/local-advisor/src/provider.ts` | caution | 37 | 100 | napi-rs | Class inheritance (1); Callback-shaped APIs (1) |
| 0 | `packages/local-advisor/src/egress.ts` | ready | 78 | 97 | napi-rs | String offsets and slicing (2); Class inheritance (1) |
| 0 | `packages/local-advisor/src/util.ts` | ready | 24 | 97 | napi-rs | Insertion-ordered maps and object keys (1); JSON round-trips (2) |
| 0 | `packages/local-advisor/src/contracts.ts` | caution | 176 | 91 | napi-rs | Insertion-ordered maps and object keys (1); Class inheritance (1) |
| 0 | `packages/local-advisor/src/redact.ts` | ready | 186 | 69 | napi-rs | String offsets and slicing (6); Regex features the `regex` crate lacks (5) |
| 1 | `packages/local-advisor/src/prompt.ts` | ready | 38 | 100 | napi-rs | - |
| 1 | `packages/local-advisor/src/router.ts` | ready | 55 | 100 | napi-rs | Class inheritance (1); Exceptions (1) |
| 1 | `packages/local-advisor/src/to-review-finding.ts` | ready | 117 | 96 | napi-rs | String offsets and slicing (1); Class inheritance (1) |
| 1 | `packages/local-advisor/src/trace-event.ts` | ready | 155 | 96 | napi-rs | String offsets and slicing (3) |
| 1 | `packages/local-advisor/src/ollama-provider.ts` | ready | 282 | 76 | napi-rs | String offsets and slicing (1); Async and promises (25) |
| 2 | `packages/local-advisor/src/to-consultation.ts` | ready | 158 | 99 | napi-rs | String offsets and slicing (1); Exceptions (5) |
| 2 | `packages/local-advisor/src/advisor.ts` | ready | 186 | 89 | napi-rs | String offsets and slicing (1); Insertion-ordered maps and object keys (2) |
| 3 | `packages/local-advisor/src/index.ts` | ready | 57 | 100 | napi-rs | - |

### 46. @agent-control-stack/local-advisor-mcp (`apps/local-advisor-mcp`, node, 2 test files, uses @agent-control-stack/local-advisor)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `apps/local-advisor-mcp/src/advise.ts` | caution | 86 | 97 | napi-rs | Async and promises (2); Insertion-ordered maps and object keys (1) |
| 0 | `apps/local-advisor-mcp/src/server.ts` | caution | 405 | 69 | napi-rs | String offsets and slicing (7); Async and promises (8) |
| 1 | `apps/local-advisor-mcp/src/cli.ts` | ready | 36 | 100 | napi-rs | - |
| 1 | `apps/local-advisor-mcp/src/index.ts` | ready | 2 | 100 | napi-rs | - |

### 47. @agent-control-stack/publication (`packages/publication`, portable, 3 test files, uses @agent-control-stack/machine-controller, @agent-control-stack/work-items)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/publication/src/github.ts` | caution | 142 | 87 | wasm-bindgen | Async and promises (10); Callback-shaped APIs (1) |
| 0 | `packages/publication/src/index.ts` | caution | 333 | 78 | wasm-bindgen | Async and promises (22); Callback-shaped APIs (9) |

### 48. @agent-control-stack/sandbox (`packages/sandbox`, node, 11 test files, uses @agent-control-stack/shared, @agent-control-stack/work-items)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/sandbox/src/contracts.ts` | ready | 185 | 93 | napi-rs | Callback-shaped APIs (3); Insertion-ordered maps and object keys (2) |
| 1 | `packages/sandbox/src/engine-contracts.ts` | ready | 174 | 99 | napi-rs | Callback-shaped APIs (1) |
| 1 | `packages/sandbox/src/linux.ts` | ready | 771 | 58 | napi-rs | String offsets and slicing (2); Async and promises (26) |
| 2 | `packages/sandbox/src/egress-proxy.ts` | caution | 155 | 80 | napi-rs | String offsets and slicing (3); Async and promises (8) |
| 3 | `packages/sandbox/src/engine.ts` | ready | 522 | 72 | napi-rs | String offsets and slicing (2); Async and promises (20) |
| 4 | `packages/sandbox/src/index.ts` | ready | 24 | 100 | napi-rs | Async and promises (1) |

### 49. @agent-control-stack/engine-adapter (`packages/engine-adapter`, node, 8 test files, uses @agent-control-stack/policy-gate, @agent-control-stack/sandbox, @agent-control-stack/shared, @agent-control-stack/work-items)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/engine-adapter/src/supervisor.ts` | ready | 78 | 100 | napi-rs | Callback-shaped APIs (5) |
| 0 | `packages/engine-adapter/src/types.ts` | ready | 109 | 100 | napi-rs | Callback-shaped APIs (1) |
| 0 | `packages/engine-adapter/src/codex-swarm-envelope.ts` | ready | 298 | 98 | napi-rs | Callback-shaped APIs (1); Exceptions (2) |
| 0 | `packages/engine-adapter/src/command-broker.ts` | caution | 230 | 93 | napi-rs | Async and promises (3); Callback-shaped APIs (3) |
| 1 | `packages/engine-adapter/src/codex.ts` | ready | 138 | 96 | napi-rs | Callback-shaped APIs (3); Async and promises (2) |
| 1 | `packages/engine-adapter/src/registry.ts` | ready | 142 | 81 | napi-rs | Class inheritance (5); Callback-shaped APIs (4) |
| 2 | `packages/engine-adapter/src/index.ts` | ready | 6 | 100 | napi-rs | - |

### 50. @agent-control-stack/eval-harness (`packages/eval-harness`, node, 3 test files, uses agentos-contracts, @agent-control-stack/policy-gate, @agent-control-stack/sandbox, @agent-control-stack/shared, @agent-control-stack/temporal-memory, @agent-control-stack/work-items)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/eval-harness/src/promotion-gate.ts` | ready | 4 | 100 | napi-rs | - |
| 0 | `packages/eval-harness/src/replay.ts` | ready | 94 | 91 | napi-rs | Insertion-ordered maps and object keys (5); Exceptions (12) |
| 1 | `packages/eval-harness/src/sqlite-eval.ts` | ready | 287 | 88 | napi-rs | Insertion-ordered maps and object keys (2); Exceptions (14) |
| 2 | `packages/eval-harness/src/index.ts` | ready | 23 | 100 | napi-rs | Insertion-ordered maps and object keys (1) |
| 3 | `packages/eval-harness/src/cli.ts` | ready | 19 | 100 | napi-rs | JSON round-trips (2); Exceptions (1) |

### 51. @agent-control-stack/result-validation (`packages/result-validation`, node, 3 test files, uses @agent-control-stack/engine-adapter, @agent-control-stack/machine-controller)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/result-validation/src/index.ts` | caution | 117 | 95 | napi-rs | Async and promises (12); Insertion-ordered maps and object keys (1) |

### 52. @agent-control-stack/verification (`packages/verification`, node, 5 test files, uses @agent-control-stack/sandbox, @agent-control-stack/shared)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/verification/src/file-readback.ts` | caution | 80 | 100 | napi-rs | Callback-shaped APIs (1); Exceptions (7) |
| 0 | `packages/verification/src/types.ts` | ready | 91 | 100 | napi-rs | Callback-shaped APIs (1) |
| 0 | `packages/verification/src/verification-dispatch.ts` | ready | 93 | 96 | napi-rs | String offsets and slicing (2); Insertion-ordered maps and object keys (1) |
| 1 | `packages/verification/src/independent-verification.ts` | ready | 91 | 98 | napi-rs | Insertion-ordered maps and object keys (2); Async and promises (2) |
| 1 | `packages/verification/src/claude-verifier.ts` | ready | 318 | 83 | napi-rs | String offsets and slicing (1); Callback-shaped APIs (3) |
| 2 | `packages/verification/src/index.ts` | ready | 5 | 100 | napi-rs | - |

### 53. @agent-control-stack/coding-mission (`packages/coding-mission`, node, 35 test files, uses @agent-control-stack/actor-router, @agent-control-stack/advisory, @agent-control-stack/dc-tool-manifest, @agent-control-stack/publication, @agent-control-stack/shared, @agent-control-stack/verification, @agent-control-stack/work-items)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/coding-mission/src/recovery-policy.ts` | ready | 55 | 97 | napi-rs | Exceptions (1) |
| 0 | `packages/coding-mission/src/routing.ts` | caution | 28 | 96 | napi-rs | Async and promises (2); Exceptions (1) |
| 0 | `packages/coding-mission/src/authority.ts` | ready | 89 | 91 | napi-rs | Insertion-ordered maps and object keys (2) |
| 0 | `packages/coding-mission/src/budget.ts` | ready | 103 | 91 | napi-rs | Insertion-ordered maps and object keys (3); Reflection and prototypes (1) |
| 0 | `packages/coding-mission/src/mission-model.ts` | ready | 448 | 76 | napi-rs | Insertion-ordered maps and object keys (5); Exceptions (4) |
| 0 | `packages/coding-mission/src/flight-recorder.ts` | ready | 616 | 68 | napi-rs | String offsets and slicing (3); Insertion-ordered maps and object keys (8) |
| 1 | `packages/coding-mission/src/dc-tool-call.ts` | ready | 39 | 100 | napi-rs | Exceptions (2) |
| 1 | `packages/coding-mission/src/general-coding.ts` | ready | 71 | 100 | napi-rs | Exceptions (2) |
| 1 | `packages/coding-mission/src/mission-intelligence.ts` | ready | 147 | 98 | napi-rs | Insertion-ordered maps and object keys (6); Exceptions (1) |
| 1 | `packages/coding-mission/src/store.ts` | caution | 1988 | 10 | napi-rs | String offsets and slicing (11); Insertion-ordered maps and object keys (17) |
| 2 | `packages/coding-mission/src/authority-graph.ts` | ready | 106 | 95 | napi-rs | Insertion-ordered maps and object keys (1) |
| 2 | `packages/coding-mission/src/cua-evidence.ts` | ready | 219 | 95 | napi-rs | Callback-shaped APIs (3); Exceptions (2) |
| 2 | `packages/coding-mission/src/governed-runtime.ts` | caution | 118 | 92 | napi-rs | Callback-shaped APIs (4); Insertion-ordered maps and object keys (1) |
| 2 | `packages/coding-mission/src/controller.ts` | caution | 958 | 46 | napi-rs | String offsets and slicing (1); Async and promises (40) |
| 2 | `packages/coding-mission/src/worker-execution.ts` | caution | 918 | 41 | napi-rs | String offsets and slicing (3); Callback-shaped APIs (6) |
| 2 | `packages/coding-mission/src/child-work.ts` | caution | 1499 | 26 | napi-rs | String offsets and slicing (11); Insertion-ordered maps and object keys (14) |
| 3 | `packages/coding-mission/src/child-work-race-fixture.ts` | ready | 89 | 100 | napi-rs | Exceptions (2); JSON round-trips (1) |
| 3 | `packages/coding-mission/src/child-work-real-grants-fixture.ts` | ready | 139 | 100 | napi-rs | Callback-shaped APIs (1); Exceptions (1) |
| 3 | `packages/coding-mission/src/unit-runner.ts` | caution | 193 | 82 | napi-rs | String offsets and slicing (1); Async and promises (6) |
| 3 | `packages/coding-mission/src/execution-boundary.ts` | ready | 211 | 79 | napi-rs | String offsets and slicing (2); Async and promises (4) |
| 3 | `packages/coding-mission/src/verification-gate.ts` | caution | 567 | 71 | napi-rs | String offsets and slicing (6); Async and promises (2) |
| 3 | `packages/coding-mission/src/default-runtime.ts` | ready | 788 | 59 | napi-rs | String offsets and slicing (2); Async and promises (60) |
| 3 | `packages/coding-mission/src/cua-execution.ts` | caution | 1208 | 39 | napi-rs | Callback-shaped APIs (41); Async and promises (34) |
| 4 | `packages/coding-mission/src/general-coding-driver.ts` | caution | 101 | 98 | napi-rs | Async and promises (2); Insertion-ordered maps and object keys (1) |
| 4 | `packages/coding-mission/src/child-work-race-worker.ts` | ready | 39 | 97 | napi-rs | String offsets and slicing (1); Exceptions (2) |
| 4 | `packages/coding-mission/src/general-coding-adapter.ts` | caution | 180 | 89 | napi-rs | String offsets and slicing (2); Callback-shaped APIs (2) |
| 4 | `packages/coding-mission/src/dc-lane-adapter.ts` | caution | 197 | 85 | napi-rs | String offsets and slicing (2); Reflection and prototypes (3) |
| 5 | `packages/coding-mission/src/index.ts` | ready | 78 | 100 | napi-rs | - |
| 5 | `packages/coding-mission/src/general-coding-fixture.ts` | ready | 160 | 99 | napi-rs | Callback-shaped APIs (2); Async and promises (1) |

### 54. @agent-control-stack/gateway (`apps/gateway`, node, 60 test files, uses @agent-control-stack/control-ui, @agent-control-stack/acp-adapter, @agent-control-stack/advisory, @agent-control-stack/agent-cli, @agent-control-stack/coding-mission, @agent-control-stack/desktop-commander-adapter, @agent-control-stack/evidence, @agent-control-stack/execution-admission, @agent-control-stack/machine-controller, @agent-control-stack/moa-orchestrator, @agent-control-stack/policy-gate, @agent-control-stack/sandbox, @agent-control-stack/shared, @agent-control-stack/verification, @agent-control-stack/work-items)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `apps/gateway/src/change-set-execution.ts` | ready | 64 | 100 | napi-rs | Exceptions (1) |
| 0 | `apps/gateway/src/change-set-runtime-policy.ts` | ready | 151 | 100 | napi-rs | Exceptions (6) |
| 0 | `apps/gateway/src/change-set-verification.ts` | ready | 157 | 100 | napi-rs | Exceptions (9) |
| 0 | `apps/gateway/src/chatgpt-dashboard-widget.generated.ts` | ready | 2 | 100 | napi-rs | - |
| 0 | `apps/gateway/src/chatgpt-dashboard.ts` | caution | 59 | 100 | napi-rs | String offsets and slicing (1); Reflection and prototypes (1) |
| 0 | `apps/gateway/src/favicon.ts` | ready | 24 | 100 | napi-rs | Async and promises (2) |
| 0 | `apps/gateway/src/hermes-source-fixture.ts` | ready | 118 | 100 | napi-rs | Exceptions (4); JSON round-trips (2) |
| 0 | `apps/gateway/src/mission-control-web.ts` | ready | 97 | 100 | napi-rs | Async and promises (2); Callback-shaped APIs (1) |
| 0 | `apps/gateway/src/public-contract-compatibility.ts` | ready | 46 | 100 | napi-rs | Insertion-ordered maps and object keys (1) |
| 0 | `apps/gateway/src/rate-limit.ts` | ready | 71 | 100 | napi-rs | Insertion-ordered maps and object keys (1); Exceptions (3) |
| 0 | `apps/gateway/src/runtime-config.ts` | ready | 27 | 100 | napi-rs | Exceptions (3) |
| 0 | `apps/gateway/src/sandbox-readiness.ts` | ready | 55 | 100 | napi-rs | Callback-shaped APIs (1) |
| 0 | `apps/gateway/src/lease-reaper.ts` | ready | 69 | 98 | napi-rs | Callback-shaped APIs (6); Exceptions (2) |
| 0 | `apps/gateway/src/tools/` | caution | 130 | 98 | napi-rs | Async and promises (3); Callback-shaped APIs (2) |
| 0 | `apps/gateway/src/compression.ts` | ready | 100 | 97 | napi-rs | Regex features the `regex` crate lacks (1); Async and promises (3) |
| 0 | `apps/gateway/src/mcp-tool-allowlist.ts` | ready | 103 | 97 | napi-rs | Insertion-ordered maps and object keys (4); Exceptions (5) |
| 0 | `apps/gateway/src/production-config.ts` | ready | 197 | 94 | napi-rs | Class inheritance (1); Callback-shaped APIs (1) |
| 0 | `apps/gateway/src/dc-bootstrap-timing.ts` | ready | 153 | 90 | napi-rs | String offsets and slicing (1); Async and promises (3) |
| 0 | `apps/gateway/src/metrics.ts` | ready | 97 | 89 | napi-rs | String offsets and slicing (3); Insertion-ordered maps and object keys (5) |
| 0 | `apps/gateway/src/mission-dispatch-routes.ts` | caution | 71 | 89 | napi-rs | String offsets and slicing (1); Async and promises (2) |
| 0 | `apps/gateway/src/lifecycle.ts` | ready | 267 | 78 | napi-rs | Callback-shaped APIs (22); Async and promises (8) |
| 0 | `apps/gateway/src/portfolio-client.ts` | ready | 251 | 67 | napi-rs | String offsets and slicing (2); Async and promises (23) |
| 0 | `apps/gateway/src/mcp-clients.ts` | ready | 653 | 66 | napi-rs | String offsets and slicing (5); Insertion-ordered maps and object keys (7) |
| 0 | `apps/gateway/src/auth.ts` | ready | 477 | 62 | napi-rs | String offsets and slicing (3); Async and promises (8) |
| 0 | `apps/gateway/src/agent-runs.ts` | caution | 826 | 48 | napi-rs | String offsets and slicing (17); Async and promises (10) |
| 1 | `apps/gateway/src/credentials.ts` | ready | 413 | 78 | napi-rs | String offsets and slicing (4); Insertion-ordered maps and object keys (2) |
| 1 | `apps/gateway/src/public-contracts.ts` | ready | 1116 | 73 | napi-rs | - |
| 1 | `apps/gateway/src/device-auth-store.ts` | ready | 572 | 65 | napi-rs | String offsets and slicing (22); Insertion-ordered maps and object keys (4) |
| 1 | `apps/gateway/src/moa/` | ready | 807 | 56 | napi-rs | String offsets and slicing (2); Async and promises (27) |
| 2 | `apps/gateway/src/csrf-guard.ts` | ready | 36 | 100 | napi-rs | Insertion-ordered maps and object keys (1); Async and promises (1) |
| 2 | `apps/gateway/src/advisor-consultation.ts` | ready | 241 | 91 | napi-rs | Async and promises (4); Callback-shaped APIs (1) |
| 2 | `apps/gateway/src/mcp-client-routes.ts` | caution | 114 | 88 | napi-rs | Async and promises (5); Callback-shaped APIs (4) |
| 2 | `apps/gateway/src/agent-routes.ts` | caution | 335 | 71 | napi-rs | String offsets and slicing (1); Async and promises (19) |
| 2 | `apps/gateway/src/dashboard-routes.ts` | ready | 392 | 71 | napi-rs | Async and promises (12); Callback-shaped APIs (7) |
| 2 | `apps/gateway/src/open-items-summary.ts` | ready | 266 | 71 | napi-rs | String offsets and slicing (4); Async and promises (6) |
| 3 | `apps/gateway/src/mcp.ts` | caution | 733 | 73 | napi-rs | Async and promises (14); Callback-shaped APIs (9) |
| 4 | `apps/gateway/src/device-auth.ts` | caution | 352 | 77 | napi-rs | String offsets and slicing (1); Async and promises (5) |
| 4 | `apps/gateway/src/server.ts` | caution | 5402 | 0 | napi-rs | String offsets and slicing (7); Regexes built at runtime (1) |
| 5 | `apps/gateway/src/cli.ts` | ready | 37 | 100 | napi-rs | Async and promises (1); Exceptions (3) |
| 5 | `apps/gateway/src/index.ts` | ready | 30 | 100 | napi-rs | Async and promises (1); Exceptions (2) |
| 5 | `apps/gateway/src/mission-dispatch.test-support.ts` | ready | 130 | 98 | napi-rs | Async and promises (4) |

### 55. @agent-control-stack/workspace-manager (`packages/workspace-manager`, node, 3 test files, uses @agent-control-stack/shared, @agent-control-stack/work-items)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/workspace-manager/src/index.ts` | caution | 735 | 63 | napi-rs | String offsets and slicing (3); Async and promises (15) |

### 56. @agent-control-stack/worker (`apps/worker`, node, 12 test files, uses @agent-control-stack/advisory, @agent-control-stack/coding-mission, @agent-control-stack/desktop-commander-adapter, @agent-control-stack/evidence, @agent-control-stack/execution-admission, @agent-control-stack/policy-gate, @agent-control-stack/procedural-learning, @agent-control-stack/sandbox, @agent-control-stack/work-items, @agent-control-stack/workspace-manager)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `apps/worker/src/mission-runner.ts` | ready | 8 | 100 | napi-rs | - |
| 0 | `apps/worker/src/claim-client.ts` | ready | 168 | 91 | napi-rs | Async and promises (7); Callback-shaped APIs (1) |
| 1 | `apps/worker/src/mission-client.ts` | ready | 219 | 73 | napi-rs | String offsets and slicing (1); Async and promises (19) |
| 2 | `apps/worker/src/mission-dispatch.ts` | caution | 82 | 100 | napi-rs | Async and promises (3); Exceptions (5) |
| 3 | `apps/worker/src/index.ts` | ready | 1078 | 54 | napi-rs | Async and promises (23); Callback-shaped APIs (4) |
| 4 | `apps/worker/src/learning-worker-child.ts` | ready | 38 | 97 | napi-rs | Async and promises (3); JSON round-trips (2) |
| 4 | `apps/worker/src/worker-loop.ts` | ready | 61 | 95 | napi-rs | Async and promises (6); Callback-shaped APIs (4) |
| 5 | `apps/worker/src/cli.ts` | ready | 46 | 96 | napi-rs | Async and promises (3); JSON round-trips (5) |

### 57. @agent-control-stack/cli (`apps/cli`, node, 6 test files, uses @agent-control-stack/gateway, @agent-control-stack/mcp, @agent-control-stack/scheduler, @agent-control-stack/worker, @agent-control-stack/agent-cli, @agent-control-stack/integration-manager, @agent-control-stack/machine-controller, @agent-control-stack/outcome-engine, @agent-control-stack/policy-gate, @agent-control-stack/procedural-learning, @agent-control-stack/shared, @agent-control-stack/work-items)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `apps/cli/src/discover-actors.ts` | ready | 19 | 100 | napi-rs | - |
| 0 | `apps/cli/src/parse.ts` | ready | 313 | 87 | napi-rs | String offsets and slicing (2); Class inheritance (1) |
| 1 | `apps/cli/src/available-actors.ts` | ready | 76 | 100 | napi-rs | Exceptions (1) |
| 1 | `apps/cli/src/outcome.ts` | ready | 160 | 86 | napi-rs | String offsets and slicing (1); Callback-shaped APIs (7) |
| 2 | `apps/cli/src/dispatch.ts` | ready | 283 | 78 | napi-rs | String offsets and slicing (1); Async and promises (11) |
| 3 | `apps/cli/src/cli.ts` | ready | 3 | 98 | napi-rs | String offsets and slicing (1); Async and promises (1) |

### 58. @agent-control-stack/execution-controller (`packages/execution-controller`, node, 2 test files, uses @agent-control-stack/engine-adapter, @agent-control-stack/procedural-learning, @agent-control-stack/result-validation, @agent-control-stack/shared, @agent-control-stack/work-items, @agent-control-stack/workspace-manager)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `packages/execution-controller/src/index.ts` | ready | 286 | 87 | napi-rs | Callback-shaped APIs (6); Async and promises (4) |

### 59. @wonderwhy-er/desktop-commander (`vendor/desktop-commander`, node, 135 test files)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `vendor/desktop-commander/src/bootstrap.ts` | ready | 21 | 100 | napi-rs | - |
| 0 | `vendor/desktop-commander/src/config-field-definitions.ts` | ready | 44 | 98 | napi-rs | Insertion-ordered maps and object keys (1) |
| 0 | `vendor/desktop-commander/src/config.ts` | ready | 10 | 98 | napi-rs | - |
| 0 | `vendor/desktop-commander/src/runtime/` | caution | 45 | 96 | napi-rs | Class inheritance (1); Reflection and prototypes (1) |
| 0 | `vendor/desktop-commander/src/ui/file-preview/shared/` | ready | 60 | 93 | napi-rs | Insertion-ordered maps and object keys (4) |
| 0 | `vendor/desktop-commander/src/version.ts` | ready | 1 | 93 | napi-rs | - |
| 0 | `vendor/desktop-commander/src/remote-device/scripts/` | ready | 75 | 89 | napi-rs | String offsets and slicing (1); Async and promises (1) |
| 0 | `vendor/desktop-commander/src/ui/` | ready | 137 | 88 | napi-rs | Async and promises (7); Callback-shaped APIs (2) |
| 0 | `vendor/desktop-commander/test-listener-bug.js` | ready | 162 | 80 | napi-rs | String offsets and slicing (3); Async and promises (13) |
| 0 | `vendor/desktop-commander/src/runtime-identity.ts` | ready | 127 | 75 | napi-rs | Async and promises (13); Dynamic typing (4) |
| 0 | `vendor/desktop-commander/track-installation.js` | ready | 345 | 74 | napi-rs | String offsets and slicing (4); Async and promises (17) |
| 0 | `vendor/desktop-commander/src/session-store.ts` | ready | 221 | 73 | napi-rs | String offsets and slicing (1); Async and promises (19) |
| 0 | `vendor/desktop-commander/src/audit/` | ready | 579 | 62 | napi-rs | String offsets and slicing (5); Insertion-ordered maps and object keys (2) |
| 0 | `vendor/desktop-commander/src/executor-lock.ts` | ready | 460 | 61 | napi-rs | String offsets and slicing (3); Dynamic typing (7) |
| 0 | `vendor/desktop-commander/uninstall-claude-server.js` | blocked | 660 | 57 | napi-rs | String offsets and slicing (3); Dynamic code (eval, new Function, computed import) (1) |
| 0 | `vendor/desktop-commander/setup-claude-server.js` | blocked | 818 | 54 | napi-rs | String offsets and slicing (2); Dynamic code (eval, new Function, computed import) (1) |
| 0 | `vendor/desktop-commander/src/custom-stdio.ts` | ready | 502 | 50 | napi-rs | String offsets and slicing (6); Dynamic typing (14) |
| 0 | `vendor/desktop-commander/src/ui/shared/` | caution | 578 | 47 | napi-rs | String offsets and slicing (3); Callback-shaped APIs (21) |
| 0 | `vendor/desktop-commander/src/managed-acs.ts` | caution | 736 | 37 | napi-rs | String offsets and slicing (1); Reflection and prototypes (23) |
| 0 | `vendor/desktop-commander/scripts/` | caution | 1876 | 0 | napi-rs | String offsets and slicing (26); Async and promises (60) |
| 1 | `vendor/desktop-commander/src/break-glass.ts` | ready | 74 | 99 | napi-rs | Exceptions (1); JSON round-trips (1) |
| 1 | `vendor/desktop-commander/src/types.ts` | ready | 95 | 88 | napi-rs | Callback-shaped APIs (1) |
| 1 | `vendor/desktop-commander/src/managed-acs-runtime.ts` | ready | 108 | 83 | napi-rs | String offsets and slicing (1); Async and promises (10) |
| 1 | `vendor/desktop-commander/src/cancellation/` | ready | 206 | 82 | napi-rs | String offsets and slicing (2); Async and promises (4) |
| 1 | `vendor/desktop-commander/src/health/` | ready | 263 | 82 | napi-rs | Async and promises (21); Callback-shaped APIs (1) |
| 1 | `vendor/desktop-commander/src/local-runtime.ts` | ready | 428 | 64 | napi-rs | Async and promises (33); Dynamic typing (2) |
| 1 | `vendor/desktop-commander/src/ui/config-editor/src/` | caution | 1070 | 43 | napi-rs | String offsets and slicing (3); Async and promises (22) |
| 2 | `vendor/desktop-commander/src/error-handlers.ts` | ready | 66 | 99 | napi-rs | - |
| 2 | `vendor/desktop-commander/src/session-reconciliation.ts` | ready | 96 | 93 | napi-rs | Async and promises (5) |
| 2 | `vendor/desktop-commander/src/ui/file-preview/src/host/` | ready | 171 | 87 | napi-rs | String offsets and slicing (1); Callback-shaped APIs (5) |
| 2 | `vendor/desktop-commander/src/tools/pdf/lib/` | ready | 102 | 85 | napi-rs | Async and promises (5); Dynamic typing (3) |
| 2 | `vendor/desktop-commander/src/ui/file-preview/src/components/` | ready | 231 | 79 | napi-rs | String offsets and slicing (1); Callback-shaped APIs (6) |
| 2 | `vendor/desktop-commander/src/command-manager.ts` | ready | 228 | 75 | napi-rs | String offsets and slicing (6); Async and promises (2) |
| 2 | `vendor/desktop-commander/src/openclaw-bridge/` | ready | 448 | 72 | napi-rs | Async and promises (20); Class inheritance (2) |
| 2 | `vendor/desktop-commander/src/config-manager.ts` | ready | 312 | 68 | napi-rs | Async and promises (33); Dynamic typing (4) |
| 2 | `vendor/desktop-commander/src/harness/` | ready | 408 | 60 | napi-rs | String offsets and slicing (3); Async and promises (31) |
| 2 | `vendor/desktop-commander/src/enforcement/` | ready | 830 | 58 | napi-rs | String offsets and slicing (3); Insertion-ordered maps and object keys (3) |
| 2 | `vendor/desktop-commander/src/tools/pdf/` | caution | 616 | 38 | napi-rs | String offsets and slicing (1); Async and promises (52) |
| 2 | `vendor/desktop-commander/src/handlers/` | caution | 1003 | 34 | napi-rs | String offsets and slicing (9); Async and promises (58) |
| 2 | `vendor/desktop-commander/src/terminal-manager.ts` | caution | 987 | 34 | napi-rs | String offsets and slicing (12); Async and promises (17) |
| 2 | `vendor/desktop-commander/src/security/` | caution | 873 | 32 | napi-rs | String offsets and slicing (3); Regexes built at runtime (1) |
| 2 | `vendor/desktop-commander/src/search-manager.ts` | caution | 935 | 28 | napi-rs | String offsets and slicing (7); Regexes built at runtime (2) |
| 2 | `vendor/desktop-commander/src/server.ts` | caution | 2155 | 7 | napi-rs | String offsets and slicing (3); Async and promises (87) |
| 2 | `vendor/desktop-commander/src/ui/file-preview/src/` | caution | 1818 | 6 | napi-rs | String offsets and slicing (10); Async and promises (29) |
| 2 | `vendor/desktop-commander/src/execution/` | caution | 2993 | 0 | napi-rs | String offsets and slicing (46); Regexes built at runtime (2) |
| 2 | `vendor/desktop-commander/src/tools/` | caution | 4221 | 0 | napi-rs | String offsets and slicing (42); Async and promises (202) |
| 2 | `vendor/desktop-commander/src/ui/file-preview/src/markdown/` | caution | 3188 | 0 | napi-rs | String offsets and slicing (38); Callback-shaped APIs (40) |
| 2 | `vendor/desktop-commander/src/utils/` | caution | 3555 | 0 | napi-rs | String offsets and slicing (22); Regexes built at runtime (1) |
| 2 | `vendor/desktop-commander/src/utils/files/` | caution | 2104 | 0 | napi-rs | String offsets and slicing (40); Regex features the `regex` crate lacks (1) |
| 3 | `vendor/desktop-commander/src/jace-commander/` | caution | 9784 | 0 | napi-rs | String offsets and slicing (73); Regexes built at runtime (2) |
| 3 | `vendor/desktop-commander/src/remote-device/` | caution | 3641 | 0 | napi-rs | String offsets and slicing (4); Async and promises (325) |
| 4 | `vendor/desktop-commander/src/npm-scripts/` | blocked | 164 | 78 | napi-rs | Dynamic code (eval, new Function, computed import) (2); Async and promises (11) |
| 5 | `vendor/desktop-commander/src/index.ts` | ready | 193 | 86 | napi-rs | Async and promises (14); Dynamic typing (1) |

## npm dependencies

| Package | Units | Rust | Fit | Note |
| --- | ---: | --- | --- | --- |
| `@modelcontextprotocol/sdk` | 12 | ? | unknown |  |
| `@supabase/supabase-js` | 5 | ? | unknown |  |
| `isbinaryfile` | 4 | ? | unknown |  |
| `pizzip` | 4 | ? | unknown |  |
| `@modelcontextprotocol/ext-apps` | 3 | ? | unknown |  |
| `@simplewebauthn/server` | 3 | ? | unknown |  |
| `@vercel/queue` | 3 | ? | unknown |  |
| `esbuild` | 3 | ? | unknown |  |
| `exceljs` | 2 | ? | unknown |  |
| `jose` | 2 | ? | unknown |  |
| `unpdf` | 2 | ? | unknown |  |
| `vitest` | 2 | ? | unknown |  |
| `@opendocsg/pdf2md` | 1 | ? | unknown |  |
| `@puppeteer/browsers` | 1 | ? | unknown |  |
| `@tiptap/core` | 1 | ? | unknown |  |
| `@tiptap/extension-image` | 1 | ? | unknown |  |
| `@tiptap/extension-table` | 1 | ? | unknown |  |
| `@tiptap/extension-table-cell` | 1 | ? | unknown |  |
| `@tiptap/extension-table-header` | 1 | ? | unknown |  |
| `@tiptap/extension-table-row` | 1 | ? | unknown |  |
| `@tiptap/starter-kit` | 1 | ? | unknown |  |
| `@vscode/ripgrep` | 1 | ? | unknown |  |
| `async_hooks` | 1 | ? | unknown |  |
| `caffeinate` | 1 | ? | unknown |  |
| `cross-fetch` | 1 | ? | unknown |  |
| `fastest-levenshtein` | 1 | ? | unknown |  |
| `highlight.js` | 1 | ? | unknown |  |
| `js-tiktoken` | 1 | ? | unknown |  |
| `jsdom` | 1 | ? | unknown |  |
| `markdown-it` | 1 | ? | unknown |  |
| `md-to-pdf` | 1 | ? | unknown |  |
| `open` | 1 | ? | unknown |  |
| `pdf-lib` | 1 | ? | unknown |  |
| `prettier` | 1 | ? | unknown |  |
| `sharp` | 1 | ? | unknown |  |
| `tiptap-markdown` | 1 | ? | unknown |  |
| `yauzl` | 1 | ? | unknown |  |
| `zod` | 104 | serde, garde | partial | Schemas become types plus validation; error messages will differ. |
| `fastify` | 1 | axum | partial | Middleware ports by hand. |
| `undici` | 1 | reqwest | good |  |

## Blocked

- `scripts/`: Uses dynamic code (eval, new Function or computed imports).
- `vendor/desktop-commander/setup-claude-server.js`: Uses dynamic code (eval, new Function or computed imports).
- `vendor/desktop-commander/src/npm-scripts/`: Uses dynamic code (eval, new Function or computed imports).
- `vendor/desktop-commander/uninstall-claude-server.js`: Uses dynamic code (eval, new Function or computed imports).

## Risk guide

- **String offsets and slicing** (High): JS indexes strings in UTF-16 code units, Rust in UTF-8 bytes. Offsets that cross the boundary must be converted, or non-ASCII text gets wrong ranges silently.
- **Regex features the `regex` crate lacks** (High): Lookaround, backreferences and the `y` flag are not in the `regex` crate. Use `fancy-regex` for those patterns, or rewrite them, and test them on non-ASCII text: `\w`, `\b` and case-insensitive matching differ between engines even where a pattern compiles.
- **Regexes built at runtime** (High): Patterns come from data or config in JS syntax. Rust regex syntax differs, so user-visible behavior can change. Pin it with tests on real patterns.
- **Dynamic code (eval, new Function, computed import)** (High): eval, new Function and computed imports have no Rust equivalent. Keep this part in JS or replace it with an explicit registry.
- **Dynamic typing** (Medium): Values whose shape is checked at runtime need an explicit Rust enum or `serde_json::Value`.
- **Insertion-ordered maps and object keys** (Medium): JS Map, Set and object keys keep insertion order. `HashMap` does not: use `indexmap` wherever order reaches output. With serde_json's `preserve_order`, `Map::remove` swaps the last key into the hole: use `shift_remove` for JS `delete`. Sort with `js::sort` when a comparator can return NaN: the order then depends on V8's algorithm.
- **Exceptions** (Low): Thrown errors become `Result`. Errors crossing the bridge must map back to the same JS error shape.
- **Async and promises** (Medium): Promises become futures. Bridge with napi-rs `async fn` or `wasm-bindgen-futures`, or keep the async shell in JS and port the sync core.
- **Generators** (Medium): Lazy generators become iterators, or return a collected Vec across the bridge.
- **Class inheritance** (Medium): Class hierarchies become traits plus composition; `instanceof` checks become enums.
- **Reflection and prototypes** (Medium): Proxy, Reflect, Symbol and prototype tricks need a redesign, not a translation.
- **Callback-shaped APIs** (Medium): Function-typed parameters and methods cross the bridge on every call. Keep boundaries coarse: pass data in, get data out.
- **Number semantics** (Low): JS numbers are f64; bitwise ops truncate to i32; parseInt is lenient. Pick Rust integer types deliberately.
- **JSON round-trips** (Low): JSON.stringify key order and number formatting must match `serde_json` output if the result is user-visible.
