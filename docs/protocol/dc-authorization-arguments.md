# Desktop Commander `authorizationArguments` contract (acs.dc.v1)

Status: normative. Fixtures: `contracts/desktop-commander/authorization-arguments.v1.json`
and `contracts/desktop-commander/managed-tool-coverage.v1.json` (pinned byte-identically
in the Desktop Commander and desktop-commander-mcp-gateway repositories).

## Invariant

> The exact normalized arguments ACS binds into a capability are the exact
> normalized arguments Desktop Commander verifies for the corresponding delivered request.

ACS is the sole authorization/control plane. Desktop Commander (DC) is the execution plane.
The managed gateway only transports.

## Definition

`authorizationArguments(tool, raw)` is what ACS signs as `payload.normalizedArguments`
and what `payload.invocationHash` covers. ACS computes it in `normalizeInvocation`:

1. **Transport metadata removed first.** Keys in `transportMetadataKeys` (currently only
   `origin`) are validated (`origin ∈ {"ui","llm"}`; anything else is a deterministic
   `desktop_commander_argument_invalid` denial) and removed. They are telemetry, never
   authorization-relevant, never bound.
2. **Strict per-tool schema** (`tool-policy.ts`). Unknown keys are rejected. No type coercion:
   `"5000"` is not `5000`, `"true"` is not `true`.
3. **Semantic normalization by ACS only.**
   - Paths (`pathArgs`, `multiPathArgs`, `cwdArgs`): resolved against the first allow root
     (or the contained `cwd`), trailing separators removed, and canonicalized with `realpath` on
     the deepest existing ancestor, so **symlinks resolve to their target**. Containment is
     evaluated on the canonical path.
   - Commands (`commandArgs`): validated, then the executable is bound as its absolute path in the
     fixed system dirs (`/usr/bin`, `/bin`, `/usr/local/bin`), e.g. `git status` →
     `/usr/bin/git status`.
4. **Canonical form.** `undefined` means absent. Absent optional properties stay absent, and
   **defaults are never materialized**: no ACS schema uses `default()` (a test enforces this).
   `null` is a value, not absence, and schemas that do not allow it reject it. Numbers and booleans
   are kept exactly. Arrays keep their order and each element is normalized. Object key order is
   irrelevant: signing and comparison use strict canonical JSON (sorted keys).

## Delivery

The gateway that requested the capability delivers **exactly** `payload.normalizedArguments`,
plus the client's validated transport metadata (`deliveredArguments` in
`desktop-commander-mcp-gateway/managed.js`). It never normalizes anything itself. What executes
is therefore what ACS evaluated, including canonical paths and the resolved executable. This
matches ACS's own stdio executor, which sends `validatedArguments`.

## Verification in Desktop Commander

`authorizationArguments(delivered)` in DC (`src/managed-acs.ts`) validates and removes transport
metadata, drops `undefined`, and does **nothing else**: no path resolution, no defaults, no
coercion. The result must be strictly canonically equal to `payload.normalizedArguments`
(`ManagedAcsGuard.authorize` and the enforcement pipeline's `verifyAcsCapability`). Any drift
yields `ACS_CAPABILITY_ARGUMENTS_MISMATCH`. DC applies its own zod defaults only after
verification, at execution.

ACS normalization is intentionally not idempotent for command arguments (an absolute executable
is rejected as input). That is safe because DC never re-normalizes.

## Managed tool-policy coverage

Every tool DC registers has an explicit disposition (`desktopCommanderManagedToolDispositions`):

| class                  | managed       | tools                                                                                                                                                                                                                                   |
| ---------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| read_only              | capability    | get_config, get_runtime_identity, get_file_info, list_directory, read_file, read_multiple_files, start_search, get_more_search_results, list_searches, list_sessions, list_processes, read_process_output, get_usage_stats |
| filesystem_mutation    | capability + approval | create_directory, write_file, edit_block, move_file                                                                                                                                                                             |
| filesystem_mutation    | unsupported   | write_pdf                                                                                                                                                                                                                               |
| process_execution      | capability + approval | start_process                                                                                                                                                                                                                   |
| process_execution      | unsupported   | interact_with_process, acpx_list_sessions, acpx_get_session, acpx_exec, acpx_prompt                                                                                                                                                     |
| process_control        | unsupported   | kill_process, force_terminate, stop_search, acpx_cancel                                                                                                                                                                                 |
| configuration_mutation | unsupported   | set_config_value                                                                                                                                                                                                                        |
| unsupported            | unsupported   | get_recent_tool_calls, get_prompts, give_feedback_to_desktop_commander, track_ui_event                                                                                                                                                  |

Unsupported tools are denied with `403 {decision:"deny", reason/code:"managed_tool_unsupported", detail}`.
Tools absent from the table are denied with `unknown_tool`. DC's coverage test fails when a newly
registered DC tool has no disposition.

`get_runtime_identity` is a read-only identity primitive (scope `process.exec`, like
`get_usage_stats`). It returns only the stable runtime identity and redacted device state. DC keeps
it callable without a capability for local identity discovery, but it verifies any capability that
is presented for it.

## Error transport (gateway)

A managed `tools/call` that is not forwarded is answered with HTTP 200 and a JSON-RPC error that
preserves the request `id`:

| kind                                 | JSON-RPC code | retryable | source                                                   |
| ------------------------------------ | ------------- | --------- | -------------------------------------------------------- |
| `managed_authorization_denied`       | -32001        | false     | ACS `decision: "deny"`                                   |
| `managed_authorization_required`     | -32002        | true      | ACS `decision: "require_approval"` (workItemId, actionHash) |
| `managed_authorization_unavailable`  | -32003        | true      | unreachable / timeout / 5xx / 429 / malformed            |

`error.data` carries `kind`, `acsCode`, `retryable` and the allowlisted ACS string fields `reason`,
`detail`, `workItemId`, `actionHash` and `approvalInstructions`.
