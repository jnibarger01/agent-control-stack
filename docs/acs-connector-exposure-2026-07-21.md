# ACS governed connector exposure — 2026-07-21

## Verdict

`PARTIAL`: the gateway MCP exposes the governed command, filesystem, result/evidence, service-request, configuration-preview, and Codex-dispatch surfaces. The command, filesystem, evidence, service-restart, and configuration-preview paths passed live localhost MCP acceptance. A successful Codex response is not claimed: the installed CLI stalled inside the deliberately credentialless, no-network Bubblewrap profile and the approved work item was cancelled. No sandbox or credential boundary was weakened to force a green result.

## Baseline

The pre-change snapshot is [`acs-connector-baseline-2026-07-21.md`](./acs-connector-baseline-2026-07-21.md). It records branch `repair/acs-production-readiness`, commit `648946225bbfcc68d75c0fbd47055d218de692f9`, the clean starting worktree, gateway/tunnel-only service state, the original six gateway MCP tools, and the baseline build/test results. It contains variable names and protected-source paths only; it does not contain credential values.

## Architecture

Every connector request follows:

`MCP → schema → registered work item → policy → human approval when required → authenticated worker lease → machine-controller or Bubblewrap boundary → bounded redacted evidence → audit/result persistence → MCP retrieval`

The gateway creates and reads work items only. It does not invoke host commands, read files, restart services, apply configuration, or invoke Codex. The remote worker authenticates with a separate worker token and submits results against its lease token. The action registry metadata remains in the canonical action and action hash; the worker projects only executor-approved fields into the strict Codex request schema.

## Exposed MCP tools

- Work-item lifecycle: `work_item.create`, `work_item.get`, `work_item.approve`, `work_item.reject`, `work_item.cancel`, `work_item.unblock`
- Diagnostics: `command.preview`, `command.run`
- Filesystem: `filesystem.read_text`, `filesystem.stat`
- Agent: `agent.preview`, `agent.run`
- Retrieval: `result.get`, `evidence.list`, `evidence.get`
- Mutations by request: `service.restart.preview`, `service.restart`, `config.change.preview`, `config.change`

The command registry contains fixed read-only diagnostics only. The filesystem registry contains the `acs-repo` root. The service registry contains ACS-owned units plus the stopped `acs-connector-test` acceptance fixture. The configuration registry contains only `storage/acs-connector-settings.json` and its bounded integer keys.

## Deployment

Tracked deployment references are in [`deploy/systemd/acs-gateway.service`](../deploy/systemd/acs-gateway.service), [`deploy/systemd/acs-worker.service`](../deploy/systemd/acs-worker.service), [`deploy/systemd/acs-tunnel.service`](../deploy/systemd/acs-tunnel.service), [`deploy/systemd/acs-connector-test.service`](../deploy/systemd/acs-connector-test.service), and [`deploy/tunnel-client/agent-control-stack.example.json`](../deploy/tunnel-client/agent-control-stack.example.json).

The live user units are active for `acs-gateway.service`, `acs-worker.service`, and `acs-tunnel.service`; the worker is enabled and polls the gateway over loopback. The fixture unit is installed as a static unit and stopped after its acceptance run. The gateway and worker use the protected environment source `/home/jacen/.agent-control-stack/secrets/local-gateway.env`. Referenced secret names include `ACS_GATEWAY_TOKEN`, `ACS_MCP_BEARER_TOKEN`, `ACS_OPENAI_API_KEY`, and `ACS_WORKER_TOKEN`; the tunnel wrapper also consumes its configured control-plane and MCP-header environment names. Values are intentionally absent from this repository and report.

## Live acceptance evidence

All calls below were made through `http://127.0.0.1:3000/mcp` with the configured local bearer and returned persisted work-item envelopes.

- `command.run` `os.metadata`: final post-restart acceptance `wrk_122426cc-3ad4-4456-a24b-ca99c8890ee2` succeeded through the worker with fixed `uname -a` execution, `controlled_action` mode, lease release, and evidence `ev_bf8e8a2624a2e2e245520512`.
- `filesystem.read_text` `acs-repo/package.json`: `wrk_334d78b2-2e8c-45ea-a960-e91c3f69a8db` succeeded with bounded content, canonical path metadata, hash, byte counts, and truncation state. Evidence retrieval used `ev_84b58899bcaf71ac0e11941d`; an `evidence.accessed` audit event was recorded.
- `filesystem.stat` `acs-repo/package.json`: `wrk_87faa708-8695-44ec-90a2-7626cb49c493` succeeded with file metadata.
- Approved restart of the harmless fixture: final acceptance `wrk_d240129e-9122-46cb-9c81-da7a0da30d40` succeeded after the worker-side user-D-Bus environment was corrected. It captured active pre/post health, `controlled_action` mode, lease release, and fixed-unit evidence. Evidence: `ev_c48ff5b813ee19733ac00047`.
- Configuration preview: `wrk_aa66a318-7e58-468c-ade4-7f0018607da3` succeeded without changing the target file; it captured current and proposed hashes, bounded diff state, backup requirement, and atomic-write metadata. The file remained `{ "worker_poll_interval_ms": 5000, "max_evidence_bytes": 200000 }`.
- Codex dispatch: the first live attempt exposed and fixed a worker projection bug. The fresh approved attempt `wrk_c0ef5840-c3e9-413d-8ccb-86ba0dbab1d5` reached the worker and Bubblewrap but produced no response under the no-network/no-credential profile, so it was cancelled. The sandbox process showed read-only mounts, `--unshare-net`, cleared environment, temporary home, and no TCP sockets. A successful Codex result remains unverified.

The live gateway health checks are green for read/write, integrity, foreign keys, migrations, audit chain, liveness, and reconciliation. The tunnel service is active and probes the gateway MCP locally. A ChatGPT-originated external call is not proven by these localhost tests.

## Controls and rollback

Unknown action IDs, raw commands, arbitrary roots, path traversal, unregistered services, unregistered configuration targets, non-human approvals, altered approval hashes, expired leases, and invalid worker results fail closed. Result/evidence retrieval is limited to the requesting actor or a registered human; evidence content is omitted from list responses and access is audited. Service restarts require exact approval and capture pre/post health with a rollback attempt on failure. Configuration changes require registered keys, a current-hash match, backup, atomic replacement, and bounded validation.

The prior known-good commit is `648946225bbfcc68d75c0fbd47055d218de692f9`. Rollback should restore that build plus the pre-change gateway/worker/tunnel unit definitions recorded in the baseline report, stop/disable the worker if connector execution must be withdrawn, and recheck gateway health, the original MCP inventory, listener state, database integrity, and audit-chain validity. Work items, audit events, and evidence must be retained.

## Remaining limitations

The contained Codex profile has no provider credential and no local inference broker by design. Enabling network access, mounting the host Codex credential store, or routing around Bubblewrap would violate the required control boundary. The separate standalone `apps/mcp` process is not the live gateway surface. Public tunnel transport is active locally, but external ChatGPT-originated invocation and a successful Codex model response remain unverified.
