# ACS MCP tool exposure matrix — 2026-07-21

This matrix separates the local ACS registry from the current external ChatGPT action snapshot. The external column refers to the newly connected `ACS Secure Tunnel` app; the older `ACS` app remains a separate six-tool snapshot.

Evidence labels:

- `local-55`: authenticated local `tools/list` returned 55 unique names; the handler is registered in the gateway.
- `external-6`: observed in the older `ACS` ChatGPT app snapshot: the six legacy lifecycle tools.
- `external-55`: observed in the connected ChatGPT `ACS Secure Tunnel` action snapshot; all 55 canonical names were present.
- `schema-pass`: the local response has a valid object input schema, required keys are declared, descriptions are bounded, and the name matches the MCP 1–64 character convention.

Behavior legend: `L` is a gateway work-item lifecycle operation; `G-R` is an immediate bounded gateway read; `W-R` is a read work item executed by the registered worker with evidence; `W-M` is a mutation request that remains approval/worker/evidence gated; `F` is an intentional fail-closed or unsupported compatibility response.

| # | Tool | Source registration | Local | Current external | Scope | Schema / name | Governed behavior | Omission reason |
|---:|---|---|---|---|---|---|---|---|
| 1 | `create_work_item` | `policy-gate/workItemToolNames` | local-55 | external-55 | create | schema-pass | L: create and policy-evaluate | none |
| 2 | `get_work_item` | `policy-gate/workItemToolNames` | local-55 | external-55 | read | schema-pass | L: bounded work-item read | none |
| 3 | `list_work_items` | `policy-gate/workItemToolNames` | local-55 | external-55 | read | schema-pass | L: bounded work-item list | none |
| 4 | `unblock_work_item` | `policy-gate/workItemToolNames` | local-55 | external-55 | approve | schema-pass | L: policy transition | none |
| 5 | `reject_work_item` | `policy-gate/workItemToolNames` | local-55 | external-55 | approve | schema-pass | L: terminal rejection | none |
| 6 | `cancel_work_item` | `policy-gate/workItemToolNames` | local-55 | external-55 | approve | schema-pass | L: terminal cancellation | none |
| 7 | `work_item.create` | `gateway/connector.ts` | local-55 | external-55 | create | schema-pass | L: registered action plus policy receipt | none |
| 8 | `work_item.get` | `gateway/connector.ts` | local-55 | external-55 | read | schema-pass | G-R: policy, lease, result, evidence projection | none |
| 9 | `work_item.approve` | `gateway/connector.ts` | local-55 | external-55 | approve | schema-pass | L: exact hash and registered human required | none |
| 10 | `work_item.reject` | `gateway/connector.ts` | local-55 | external-55 | approve | schema-pass | L: governed rejection | none |
| 11 | `work_item.cancel` | `gateway/connector.ts` | local-55 | external-55 | approve | schema-pass | L: governed cancellation | none |
| 12 | `work_item.unblock` | `gateway/connector.ts` | local-55 | external-55 | approve | schema-pass | L: policy re-entry | none |
| 13 | `command.preview` | `gateway/connector.ts` + machine registry | local-55 | external-55 | create | schema-pass | W-R: fixed registered diagnostic preview | none |
| 14 | `command.run` | `gateway/connector.ts` + machine registry | local-55 | external-55 | create | schema-pass | W-R: fixed registered diagnostic | none |
| 15 | `filesystem.read_text` | `gateway/connector.ts` + machine registry | local-55 | external-55 | create | schema-pass | W-R: named root, bounded read, evidence | none |
| 16 | `filesystem.stat` | `gateway/connector.ts` + machine registry | local-55 | external-55 | create | schema-pass | W-R: named root metadata, evidence | none |
| 17 | `agent.preview` | `gateway/connector.ts` + machine registry | local-55 | external-55 | create | schema-pass | W-R: bounded read-only dispatch preview | none |
| 18 | `agent.run` | `gateway/connector.ts` + machine registry | local-55 | external-55 | create | schema-pass | W-M: approval/configured worker boundary | none |
| 19 | `result.get` | `gateway/connector.ts` + machine registry | local-55 | external-55 | read | schema-pass | G-R: governed result projection | none |
| 20 | `evidence.list` | `gateway/connector.ts` + machine registry | local-55 | external-55 | read | schema-pass | G-R: metadata only; content omitted | none |
| 21 | `evidence.get` | `gateway/connector.ts` + machine registry | local-55 | external-55 | read | schema-pass | G-R: bounded redacted evidence and access audit | none |
| 22 | `service.restart.preview` | `gateway/connector.ts` + machine registry | local-55 | external-55 | create | schema-pass | W-R: registered service preview | none |
| 23 | `service.restart` | `gateway/connector.ts` + machine registry | local-55 | external-55 | create | schema-pass | W-M: human approval, health evidence | none |
| 24 | `config.change.preview` | `gateway/connector.ts` + machine registry | local-55 | external-55 | create | schema-pass | W-R: registered target/hash preview | none |
| 25 | `config.change` | `gateway/connector.ts` + machine registry | local-55 | external-55 | create | schema-pass | W-M: approval, hash, backup, atomic write | none |
| 26 | `create_directory` | `gateway/connector.ts` + machine registry | local-55 | external-55 | create | schema-pass | W-M: approved bounded filesystem write | none |
| 27 | `edit_block` | `gateway/connector.ts` + machine registry | local-55 | external-55 | create | schema-pass | W-M: exact-match atomic patch | none |
| 28 | `force_terminate` | `gateway/connector.ts` + machine registry | local-55 | external-55 | create | schema-pass | W-M: ACS-started process only | none |
| 29 | `get_config` | `gateway/connector.ts` | local-55 | external-55 | read | schema-pass | G-R: redacted ACS summary only | none |
| 30 | `get_file_info` | `gateway/connector.ts` + machine registry | local-55 | external-55 | create | schema-pass | W-R: bounded named-root metadata | none |
| 31 | `get_more_search_results` | `gateway/connector.ts` | local-55 | external-55 | read | schema-pass | G-R: bounded completed-search page | none |
| 32 | `get_prompts` | `gateway/connector.ts` | local-55 | external-55 | read | schema-pass | G-R: fixed governed onboarding prompt | none |
| 33 | `get_recent_tool_calls` | `gateway/connector.ts` | local-55 | external-55 | read | schema-pass | G-R: redacted audit projection | none |
| 34 | `get_usage_stats` | `gateway/connector.ts` | local-55 | external-55 | read | schema-pass | G-R: bounded health/audit statistics | none |
| 35 | `give_feedback_to_desktop_commander` | `gateway/connector.ts` | local-55 | external-55 | read | schema-pass | F: reports unsupported external form | none |
| 36 | `interact_with_process` | `gateway/connector.ts` + machine registry | local-55 | external-55 | create | schema-pass | W-M: approved input to ACS-started process | none |
| 37 | `kill_process` | `gateway/connector.ts` + machine registry | local-55 | external-55 | create | schema-pass | W-M: approved ACS-started process termination | none |
| 38 | `list_devices` | `gateway/connector.ts` | local-55 | external-55 | read | schema-pass | G-R: ACS-local capability projection | none |
| 39 | `list_directory` | `gateway/connector.ts` + machine registry | local-55 | external-55 | create | schema-pass | W-R: bounded named-root listing | none |
| 40 | `list_processes` | `gateway/connector.ts` + machine registry | local-55 | external-55 | create | schema-pass | W-R: fixed bounded process diagnostic | none |
| 41 | `list_searches` | `gateway/connector.ts` | local-55 | external-55 | read | schema-pass | G-R: ACS-backed search sessions | none |
| 42 | `list_sessions` | `gateway/connector.ts` | local-55 | external-55 | read | schema-pass | G-R: ACS work-item sessions | none |
| 43 | `move_file` | `gateway/connector.ts` + machine registry | local-55 | external-55 | create | schema-pass | W-M: approved bounded move | none |
| 44 | `ping` | `gateway/connector.ts` | local-55 | external-55 | read | schema-pass | G-R: local ACS reachability | none |
| 45 | `read_file` | `gateway/connector.ts` + machine registry | local-55 | external-55 | create | schema-pass | W-R: bounded redacted named-root read | none |
| 46 | `read_multiple_files` | `gateway/connector.ts` + machine registry | local-55 | external-55 | create | schema-pass | W-R: bounded multi-file read and evidence | none |
| 47 | `read_process_output` | `gateway/connector.ts` + machine registry | local-55 | external-55 | create | schema-pass | W-R: bounded ACS process output | none |
| 48 | `set_config_value` | `gateway/connector.ts` + machine registry | local-55 | external-55 | create | schema-pass | W-M: allowlisted key and human approval | none |
| 49 | `shutdown` | `gateway/connector.ts` + machine registry | local-55 | external-55 | create | schema-pass | F: approval request; host shutdown disabled | none |
| 50 | `start_process` | `gateway/connector.ts` + machine registry | local-55 | external-55 | create | schema-pass | W-M: registered command only, approval | none |
| 51 | `start_search` | `gateway/connector.ts` + machine registry | local-55 | external-55 | create | schema-pass | W-R: bounded allowlisted search | none |
| 52 | `stop_search` | `gateway/connector.ts` | local-55 | external-55 | approve | schema-pass | L: governed search cancellation | none |
| 53 | `who_am_i` | `gateway/connector.ts` | local-55 | external-55 | read | schema-pass | G-R: authenticated actor projection | none |
| 54 | `write_file` | `gateway/connector.ts` + machine registry | local-55 | external-55 | create | schema-pass | W-M: bounded atomic write and evidence | none |
| 55 | `write_pdf` | `gateway/connector.ts` + machine registry | local-55 | external-55 | create | schema-pass | W-M: bounded PDF write and evidence | none |

## Current conclusion

The local gateway has one published remote inventory (`remoteMcpToolNames`) used by both JSON-RPC `tools/list` and the authenticated `/mcp/tools` compatibility route. Local bearer and OAuth test fixtures both return the same 55 names. The connected ChatGPT `ACS Secure Tunnel` app also exposes all 55 names and has completed read-only calls through the live tunnel. The older `ACS` app still contains only the six lifecycle names and should not be used as the current exposure proof.

Discovery does not grant unrestricted execution: scopes, default-deny policy, human approval, registered roots/commands, worker leases, redaction, evidence, and audit controls remain in force. The external app itself is currently `No Auth`; the gateway audit shows its injected local bearer rather than an OAuth JWT identity, so the strict OAuth-backed acceptance remains `PARTIAL`.

The current tunnel defaults to `acs:work:create` and `acs:work:read`; `acs:work:approve` remains a separate least-privilege scope. Discovering a tool does not grant that scope, and calls requiring approval scope must fail closed when it is absent.
