# ACS governed connector exposure — 2026-07-21

## Verdict

`PARTIAL` for the end-to-end ChatGPT acceptance: the local governed ACS surface passes, and the newly connected ChatGPT `ACS Secure Tunnel` app exposes all 55 canonical remote tools. ChatGPT-originated read-only calls reached ACS and completed, but the app is configured as `No Auth`/`Authorization used: None` because this tunnel deployment does not advertise OAuth metadata. The external path therefore has transport and local ACS enforcement proof, not the required OAuth identity/scope proof.

## Baseline

The pre-change snapshot is [`acs-connector-baseline-2026-07-21.md`](./acs-connector-baseline-2026-07-21.md). It records branch `repair/acs-production-readiness`, commit `648946225bbfcc68d75c0fbd47055d218de692f9`, the clean starting worktree, gateway/tunnel-only service state, the original six gateway MCP tools, and the baseline build/test results. It contains variable names and protected-source paths only; it does not contain credential values.

## Architecture

Every connector request follows:

`MCP → schema → registered work item → policy → human approval when required → authenticated worker lease → machine-controller or Bubblewrap boundary → bounded redacted evidence → audit/result persistence → MCP retrieval`

The gateway creates and reads work items only. It does not invoke host commands, read files, restart services, apply configuration, or invoke Codex. The remote worker authenticates with a separate worker token and submits results against its lease token. The action registry metadata remains in the canonical action and action hash; the worker projects only executor-approved fields into the strict Codex request schema.

The Codex profile uses the installed `qwen2.5-coder:7b` model through Codex OSS/Ollama mode. The worker exposes only a per-run Unix socket to the Bubblewrap namespace; a host-side relay has a fixed destination of `127.0.0.1:11434`, and the in-sandbox HTTP filter allowlists only model discovery and `POST /v1/responses`. Bubblewrap still uses `--unshare-net`, cleared environment, read-only workspace mounts, and a temporary home; no OpenAI credential is mounted.

## Exposed MCP tools

- Work-item lifecycle: `work_item.create`, `work_item.get`, `work_item.approve`, `work_item.reject`, `work_item.cancel`, `work_item.unblock`
- Diagnostics: `command.preview`, `command.run`
- Filesystem: `filesystem.read_text`, `filesystem.stat`
- Agent: `agent.preview`, `agent.run`
- Retrieval: `result.get`, `evidence.list`, `evidence.get`
- Mutations by request: `service.restart.preview`, `service.restart`, `config.change.preview`, `config.change`

The command registry contains fixed read-only diagnostics only. The filesystem registry contains the `acs-repo` root. The service registry contains ACS-owned units plus the stopped `acs-connector-test` acceptance fixture. The configuration registry contains only `storage/acs-connector-settings.json` and its bounded integer keys.

Desktop Commander compatibility tools are listed in docs/acs-desktop-commander-compatibility-2026-07-21.md. They remain bounded by the same registry, approval, worker, path, and evidence controls described above.

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
- Codex dispatch: the earlier approved attempt `wrk_c0ef5840-c3e9-413d-8ccb-86ba0dbab1d5` reached Bubblewrap but was cancelled after the credentialless cloud path produced no response. The final post-commit acceptance passed with approved work item `wrk_2030d142-4138-4a3d-84d6-6c30a45c0a88`, action hash `6bb874c969148a5ffeaa4c1f7917b77bf7e6a16626980c14d171fbda46f73b3e`, commit `b9c4a5c5a9fb5cb4c881ebd40c8304a33914a081`, succeeded status, `execution_mode=sandboxed_agent`, `executor_id=acs-worker`, released lease, clean repository worktree state, equal workspace before/after hashes, and evidence `ev_373937667141d853df2844bf`. Retrieved evidence contains the non-empty Codex response `ACS-POSTCOMMIT-CODEX-OK`; the sandbox identity is `bubblewrap:read-only-workspace,no-network,local-ollama-unix-socket`.

The live gateway health checks are green for read/write, integrity, foreign keys, migrations, audit chain, liveness, and reconciliation. The tunnel service is active and probes the gateway MCP locally. These localhost checks are supplemented by the external ChatGPT evidence below; they are not substituted for it.

## External discovery and invocation

The tunnel's `main` route points at the authenticated gateway `/mcp`, whose local `tools/list` and `/mcp/tools` responses use the same canonical 55-name inventory. On 2026-07-21, the connected ChatGPT app `ACS Secure Tunnel` (`asdk_app_6a5f22ebaa008191a2e0472b95e96b4e`, version `asdk_app_v_6a5f22ee374081919fca273f7ccbe499`) showed all 55 names with zero missing entries. The older `ACS` app remains a separate stale six-tool snapshot and was not used for this result.

The fresh ChatGPT conversation `ACS Secure Tunnel Access` reached the live tunnel and invoked read-only ACS tools. The resulting response identified the registered human actor, `acs-local`, and `acs-worker`; reported default-deny policy, redaction, one registered `acs-repo` root, and registered-only commands; and recorded successful `get_config`, `who_am_i`, `ping`, `list_devices`, and governed filesystem-read activity. A `list_directory` probe returned HTTP 400 because its root-directory arguments did not satisfy the relative-path schema; ACS rejected it without creating a work item. That is expected fail-closed behavior, not direct host access.

The external app metadata reported `Authorization supported: None` and `Authorization used: None`. The gateway audit for the ChatGPT-originated requests records the injected local bearer path (`auth.method=local_bearer`, resolved ACS actor `user`, all three ACS scopes), not an OAuth JWT subject. The app is therefore externally callable through the Secure MCP Tunnel, but the strict OAuth identity/scope acceptance remains open.

The complete per-tool evidence table is [`acs-mcp-tool-exposure-matrix-2026-07-21.md`](./acs-mcp-tool-exposure-matrix-2026-07-21.md).

## Controls and rollback

Unknown action IDs, raw commands, arbitrary roots, path traversal, unregistered services, unregistered configuration targets, non-human approvals, altered approval hashes, expired leases, and invalid worker results fail closed. Result/evidence retrieval is limited to the requesting actor or a registered human; evidence content is omitted from list responses and access is audited. Service restarts require exact approval and capture pre/post health with a rollback attempt on failure. Configuration changes require registered keys, a current-hash match, backup, atomic replacement, and bounded validation.

The prior known-good commit is `648946225bbfcc68d75c0fbd47055d218de692f9`. Rollback should restore that build plus the pre-change gateway/worker/tunnel unit definitions recorded in the baseline report, stop/disable the worker if connector execution must be withdrawn, and recheck gateway health, the original MCP inventory, listener state, database integrity, and audit-chain validity. Work items, audit events, and evidence must be retained.

## Remaining limitations

The contained Codex profile is local-only and has no provider credential. Enabling network access, mounting the host Codex credential store, or routing around Bubblewrap would violate the required control boundary. The separate standalone `apps/mcp` process is not the live gateway surface. ChatGPT external discovery and read-only invocation are proven, but OAuth-backed external identity/scope provenance and a successful valid-argument directory listing remain unverified.
