# Integration Manager native graph runbook

## Local build and use

Default installs use TypeScript. The pilot was built on Linux x86-64 with glibc and tested on Node 24.16.0. The crate uses Node-API 6 through napi-rs 3 and ACS graph ABI version 1. The measured ELF references glibc symbol versions through 2.34. [Verification evidence](rust-pilot-evidence.md)

Build with the committed Cargo lockfile and the pinned toolchain in `rust-toolchain.toml`. Run from the repository root. The build is explicit and never runs on install.

```sh
npm ci
npm run build:native
ACS_TEST_INTEGRATION_GRAPH_NATIVE=1 ACS_INTEGRATION_GRAPH_BACKEND=rust npm run test:vitest -- packages/integration-manager
node rust/integration-graph/package-smoke.mjs
```

`npm run build:native` builds `rust/integration-graph`, copies the addon into `packages/integration-manager/native/`, and verifies its ABI against the TypeScript bridge before reporting success. It fails on any platform other than Linux x64 glibc. The Rust Anything CLI is no longer required.

For a local or staging canary, launch the ACS command that uses the Integration Manager with `ACS_INTEGRATION_GRAPH_BACKEND=rust`. The selector applies to the package exports and reconciliation. The result remains a read-only assessment.

Behavior with `ACS_INTEGRATION_GRAPH_BACKEND=rust` (fail closed):

- A missing, unreadable or ABI-mismatched addon throws `ACS_INTEGRATION_GRAPH_ADDON_UNAVAILABLE`. There is no TypeScript substitute. Every call fails until the process is fixed or the variable is unset.
- A native call that throws raises `ACS_INTEGRATION_GRAPH_CALL_FAILED`. No result is substituted.
- Duplicate or out-of-range PR numbers and unsupported shapes return no native result by design. They use TypeScript, and that is recorded as the documented domain boundary, not as a failure.
- Any value other than `typescript`, `rust` or empty throws `ACS_INTEGRATION_GRAPH_BACKEND_INVALID`.

## Artifact layout and portability

Package the target-built `acs_integration_graph.node` alongside `native/bridge.cjs` inside `packages/integration-manager`. Keep `dist/` at the same depth. The binary is ignored in Git. Build on the oldest compatible glibc baseline for the intended target. Record the target triple, toolchain and checksum. Verify the checksum and smoke-test load and batch parity from the installed layout. Build and verify separately for each CPU, OS and libc. The pilot covers Linux x86-64 glibc. Other targets use the default TypeScript backend until they have verification evidence. [napi-rs build reference](https://github.com/napi-rs/napi-rs/blob/main/crates/napi/README.md)

Node needs to map the addon's executable segments from its filesystem. In a container with a `noexec` temporary directory, point `TMPDIR` at a dedicated writable scratch mount that permits executable mappings when running the package smoke test. The installed addon can live on a read-only filesystem that permits those mappings.

Rust Anything scaffolded the crate and manifest. The crate uses a source-owned, typed binding and JS adapter to avoid sending unused PR metadata through the generated generic wire. `index.cjs` calls that same adapter and throws on unsupported fixtures. Running `rust-anything refresh` would replace the source-owned binding. Generate new scaffolds in scratch directories.

## Replay and performance

```sh
rust_pilot_inputs=$(mktemp)
node rust/integration-graph/record-inputs.mjs > "$rust_pilot_inputs"
rust-anything record rust/integration-graph --count 0 --inputs "$rust_pilot_inputs"
rust-anything diff rust/integration-graph
rust-anything bench rust/integration-graph
node rust/integration-graph/benchmark.mjs
```

The corpus uses synthetic PR projections to cover the supported native domain. Vitest exercises unsupported inputs separately. Those inputs return no native result by design and use the TypeScript domain boundary described above, not a failure path. Keep ordered comparisons enabled. Generated shadow output is for synthetic QA because its default reporter can include input data.

## Rollback

Unset `ACS_INTEGRATION_GRAPH_BACKEND` and restart the affected process through its normal service procedure. The fresh process selects TypeScript. No state migration is required. The addon is required only while `ACS_INTEGRATION_GRAPH_BACKEND=rust` is set. With the variable unset, the process never loads it, so a missing addon is not an error. A native process abort follows the existing supervisor restart and recovery process.
