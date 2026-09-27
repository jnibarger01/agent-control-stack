# ADR 0019: Consolidate the ACS / Desktop Commander execution chain into this monorepo

## Status

Proposed (phase one). Accepted on merge of the phase-one migration PR.

## Context

The privileged execution chain for ChatGPT/MCP-driven machine operations was
split across three GitHub repositories plus a relay that lived inside one of
them:

| Component                                  | Former source of truth                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| ACS (issuer, policy, work items, approval) | `jnibarger01/agent-control-stack` (this repo)                                |
| Desktop Commander MCP gateway              | `jnibarger01/desktop-commander-mcp-gateway`                                  |
| Desktop Commander (execution engine)       | `jnibarger01/desktop-commander` (fork of `wonderwhy-er/DesktopCommanderMCP`) |
| Self-hosted relay / control plane          | `src/control-plane` inside the Desktop Commander fork                        |

The tool contract between these layers (tool names, ACS scope mapping,
managed disposition, strict argument schemas, transport-only metadata such as
`origin`) was kept in sync by hand-copied JSON fixtures pinned by SHA-256 in
each repository, plus a cross-repo test that only ran when the checkouts
happened to sit side by side on one machine. The observed failure class was
**one layer accepts a tool that another layer does not recognize** (for
example the `get_runtime_identity` scope regression fixed in
`desktop-commander@c93f0b3`, where DC mapped the tool to `fs.read` while ACS
issued `process.exec`). Cross-repo drift was only caught when someone ran the
side-by-side test locally.

## Decision

Consolidate the execution chain into `agent-control-stack` while **retaining
every service boundary**. Consolidation changes where code lives and which
tests run in CI; it does not merge processes, trust domains, or authority.

Phase-one layout:

```text
apps/dc-mcp-gateway/            # imported with full history (git subtree)
apps/dc-relay/                  # relay extracted from the DC fork (git mv, history followable)
packages/dc-tool-manifest/      # canonical DC tool contract (@agent-control-stack/dc-tool-manifest)
packages/desktop-commander-adapter/  # existing ACS adapter, now consumes the manifest
vendor/desktop-commander/       # the DC fork as a git subtree (full history)
tests/e2e/                      # root-level execution-chain tests
contracts/desktop-commander/    # generated from the manifest; checked in CI
```

Package naming follows the repository's existing `@agent-control-stack/*`
convention (there is no `@acs/*` scope in this repository).

`vendor/desktop-commander` is **not** an npm workspace. It keeps its own
`package.json`/lockfile and build so that upstream Desktop Commander changes
can still be merged with `git subtree pull` (see
`docs/runbooks/desktop-commander-subtree.md`). The monorepo stays on npm
workspaces and `tsc -b` project references; no package-manager or build-system
change is part of this decision.

## Security invariants

These invariants override convenience. A change that weakens one of them needs
a superseding ADR.

1. **ACS is the sole authorization authority.** ACS owns authorization, work
   items, approval decisions, capability issuance, and policy. Only ACS holds
   the `acs.dc.v1` Ed25519 signing key.
2. **Desktop Commander is the final enforcement boundary.** ACS authorizes,
   but Desktop Commander independently validates every privileged capability
   immediately before execution. The required model is:

   ```text
   ACS authorizes -> transport carries capability -> DC independently validates -> executor runs
   ```

   In code, the Desktop Commander process validates in
   `handleCallToolRequest` (`vendor/desktop-commander/src/server.ts`) via
   `authorizeManagedToolCall` -> `ManagedAcsGuard.authorize`
   (`src/managed-acs.ts`), followed by the fail-closed execution kernel
   `preExecuteEnforcement` (`src/enforcement/pipeline.ts`), before any tool
   handler is dispatched. The only managed-mode exception is
   `get_runtime_identity` called **without** a capability (local identity
   discovery); a capability presented for it is still verified.

3. **Successful validation by a gateway, relay, router, or any other upstream
   component never substitutes for Desktop Commander's final enforcement.**
   DC never trusts the gateway's judgement. The design
   `gateway validated capability -> DC trusts gateway` is rejected.
4. **No transport is an authority.** The MCP gateway and the relay may
   transport requests, normalize explicitly permitted metadata, invoke ACS,
   and route responses. They must not decide whether a privileged action is
   authorized. The gateway forwards exactly the argument object ACS normalized
   and signed; it strips client-supplied `_meta.acs*`/`_meta.capability`
   (anti-spoof) and fails closed when ACS does not return a well-formed
   envelope.
5. **Mission Router, Visualizer, and Looptrace never gain direct OS execution
   authority.** They are phase-two components and are not imported by this
   decision.
6. **No execution path bypasses ACS + DC enforcement.** Managed mode has no
   standalone fallback.
7. **Defense in depth.** A mistake in the gateway or the ACS integration layer
   must still be caught by Desktop Commander's child-side capability
   validation (signature, key id, runtime binding, tool/scope binding,
   argument binding via `actionHash`, expiry, single-use nonce).
8. **Generated schemas derive from canonical contracts.** The DC tool contract
   has one source: `packages/dc-tool-manifest`. The JSON contracts under
   `contracts/desktop-commander/` and the pinned fixtures inside
   `vendor/desktop-commander/test/fixtures/` are derived artifacts; CI fails
   when they differ from what the manifest generates, and when Desktop
   Commander's in-process tables disagree with the manifest.
9. **Deployed artifacts should eventually be attributable to immutable Git
   commits.** Phase one makes GitHub the source of truth; binding the running
   systemd services to a release directory keyed by commit SHA is a follow-up
   that requires the host (see Consequences).

## Capability validation extraction (deliberately deferred)

The prompt for this migration proposed extracting the capability primitives
(envelope schema, canonical JSON, `actionHash`, signature, expiry, nonce) into
a shared `@agent-control-stack/acs-capability` package imported by both ACS
and DC.

Phase one does **not** do this. `vendor/desktop-commander` is built with its
own toolchain so it can keep following upstream; making it import a workspace
package would couple the vendored build to the monorepo's workspace graph and
make the enforcement boundary depend on a package that ACS (the issuer) also
edits. Issuer and verifier stay independent implementations, and three things
pin them together:

- the frozen interop vector `vendor/desktop-commander/test/fixtures/acs-dc-v1.json`,
  which DC's own suite verifies;
- the root drift test (`tests/e2e/dc-tool-contract-drift.test.ts`), which
  imports DC's `managed-acs.ts` and ACS's adapter and checks the canonical
  JSON and invocation hash on shared inputs;
- the root E2E tests, which send ACS-minted capabilities to a real DC child
  process.

Revisit this once DC can consume workspace packages without losing the
upstream merge path. Even after extraction, DC must import and run the
validation in-process.

## Relay path and the relay boundary

The relay (`apps/dc-relay`) routes a remote `call_device_tool` to a paired
device over Supabase Realtime/RPC. It never calls ACS and never executes
anything. On the device, Desktop Commander's managed client
(`src/remote-device/desktop-commander-integration.ts`) attaches only through
the OAuth/ACS edge (it refuses the raw bridge port), so a relayed call follows
the same chain as the MCP path from the edge onward:

```text
remote client -> dc-relay -> device -> dc-mcp-gateway edge -> ACS -> capability -> bridge -> DC validates -> executor
```

The relay protocol (the `/api/mcp-info` contract and the claim/complete RPCs)
is a real shared boundary with Desktop Commander's device client. It is not
extracted into a package in phase one, for the same reason as the capability
primitives: DC is built outside the workspace graph. The root E2E suite covers
it instead.

## Implementation status (phase-one PR)

| Item                                                            | State                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `apps/dc-mcp-gateway` with history                              | Done (`git subtree`, 22 upstream commits).                                      |
| `vendor/desktop-commander` with history                         | Done (`git subtree`, 647 upstream commits).                                     |
| `apps/dc-relay` extraction                                      | Done (`git mv`, then an npm workspace built by `tsc -b`).                       |
| `@agent-control-stack/dc-tool-manifest`                         | Done. ACS consumes it directly; DC and the gateway are drift-tested against it. |
| Capability-primitive extraction                                 | Deferred (see above).                                                           |
| Root E2E: MCP path, DC final enforcement, relay path, reconnect | Done (`tests/e2e`, `ACS_DC_E2E=1`, CI job `dc-execution-chain`).                |
| Relay↔device Supabase pipe in E2E                               | Simulated with the same store transitions; no live Supabase in CI.              |

Findings recorded while implementing:

- ACS keeps one outstanding runtime-bootstrap challenge per runtime (issuing a
  challenge expires pending ones). Truly concurrent managed session attaches
  therefore race; the losers fail closed with `runtime_bootstrap_rejected` and
  succeed on retry. This is safe but an availability race. Changing it is a
  security decision for a separate ADR.
- Each fail-closed managed initialize leaked one bridge session, because the
  bridge does not evict idle sessions. Fixed in the edge, which now closes the
  upstream session on every fail-closed initialize path.
- After an executor crash, DC refuses to take over the dead holder's lease for
  10 s (PID-reuse grace), and the bridge respawns without backoff during that
  window. Recovery is bounded; the respawn loop is noisy.
- Desktop Commander's `test-managed-authorization-contract.js` cross-component
  block expects a gateway fixture and `DC_TRANSPORT_METADATA_ARGUMENT_KEYS` /
  `deliveredArguments` exports that no GitHub revision of the gateway has ever
  contained. Either unpushed gateway work exists on the host, or the test
  anticipated a change that never landed. The root drift test now covers that
  chain against the committed gateway.

## Migration phases

- **Phase one (this ADR):** ACS, DC MCP gateway, relay, Desktop Commander,
  the canonical tool manifest, and root E2E tests.
- **Phase two:** Mission Router, Looptrace, Visualizer. They are not imported
  here and gain no execution authority by being colocated later.
- **Phase three, only if justified:** build acceleration (for example
  Turborepo), in a separate ADR and PR driven by measured build times.

## Rejected alternatives

- **Git submodule for Desktop Commander.** Rejected: submodules pin a commit in
  another repository, so GitHub would still have two sources of truth, and CI
  would need a second credential to fetch a private repository. A subtree keeps
  one tree and still supports `git subtree pull` from upstream.
- **Flattening Desktop Commander into ACS packages.** Rejected: DC is an
  upstream-derived execution engine; flattening it would make every upstream
  merge a manual port and blur the enforcement boundary.
- **Gateway-side capability verification that DC trusts.** Rejected by the
  invariants above.
- **Switching to pnpm or Turborepo during the migration.** Rejected: an
  unrelated risk multiplier. npm workspaces plus `tsc -b` already work.

## Consequences

- One PR can change the issuer, the transport, the relay, and the enforcer
  together, and CI proves they agree.
- The source repositories (`desktop-commander`, `desktop-commander-mcp-gateway`)
  must not be archived until this migration is merged and validated.
- GitHub cannot establish local host state. Dirty or unpushed working trees,
  systemd unit definitions, which checkout a running service came from, service
  restarts, and live relay verification all need the host and are out of scope
  for the phase-one PR.
- Host-specific defaults that were committed in the source repositories (for
  example `/home/jacen/projects/desktop-commander/dist/index.js` as the default
  `ACS_DC_ENTRYPOINT` in the gateway) are imported unchanged and must be
  repointed at the release directory during the systemd cutover.
