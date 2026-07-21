# ACS MCP tool exposure matrix — 2026-07-21

This matrix separates the local ACS registry from the current external ChatGPT action snapshot.

Evidence labels:

- `local-55`: authenticated local `tools/list` returned 55 unique names; the handler is registered in the gateway.
- `external-6`: observed in the current ChatGPT connector snapshot: the six legacy lifecycle tools.
- `refresh-required`: not present in that external snapshot; this is not evidence that the local definition is absent.
- `schema-pass`: the local response has a valid object input schema, required keys are declared, descriptions are bounded, and the name matches the MCP 1–64 character convention.

Behavior legend: `L` is a gateway work-item lifecycle operation; `G-R` is an immediate bounded gateway read; `W-R` is a read work item executed by the registered worker with evidence; `W-M` is a mutation request that remains approval/worker/evidence gated; `F` is an intentional fail-closed or unsupported compatibility response.

| # | Tool | Source registration | Local | Current external | Scope | Schema / name | Governed behavior | Omission reason |
|---:|---|---|---|---|---|---|---|---|
| 1 | `create_work_item` | `policy-gate/workItemToolNames` | local-55 | external-6 | create | schema-pass | L: create and policy-evaluate | none |
| 2 | `get_work_item` | `policy-gate/workItemToolNames` | local-55 | external-6 | read | schema-pass | L: bounded work-item read | none |
| 3 | `list_work_items` | `policy-gate/workItemToolNames` | local-55 | external-6 | read | schema-pass | L: bounded work-item list | none |
| 4 | `unblock_work_item` | `policy-gate/workItemToolNames` | local-55 | external-6 | approve | schema-pass | L: policy transition | none |
| 5 | `reject_work_item` | `policy-gate/workItemToolNames` | local-55 | external-6 | approve | schema-pass | L: terminal rejection | none |
| 6 | `cancel_work_item` | `policy-gate/workItemToolNames` | local-55 | external-6 | approve | schema-pass | L: terminal cancellation | none |
| 7 | `work_item.create` | `gateway/connector.ts` | local-55 | refresh-required | create | schema-pass | L: registered action plus policy receipt | frozen external snapshot |
| 8 | `work_item.get` | `gateway/connector.ts` | local-55 | refresh-required | read | schema-pass | G-R: policy, lease, result, evidence projection | frozen external snapshot |
| 9 | `work_item.approve` | `gateway/connector.ts` | local-55 | refresh-required | approve | schema-pass | L: exact hash and registered human required | frozen external snapshot |
| 10 | `work_item.reject` | `gateway/connector.ts` | local-55 | refresh-required | approve | schema-pass | L: governed rejection | frozen external snapshot |
| 11 | `work_item.cancel` | `gateway/connector.ts` | local-55 | refresh-required | approve | schema-pass | L: governed cancellation | frozen external snapshot |
| 12 | `work_item.unblock` | `gateway/connector.ts` | local-55 | refresh-required | approve | schema-pass | L: policy re-entry | frozen external snapshot |
| 13 | `command.preview` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | create | schema-pass | W-R: fixed registered diagnostic preview | frozen external snapshot |
| 14 | `command.run` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | create | schema-pass | W-R: fixed registered diagnostic | frozen external snapshot |
| 15 | `filesystem.read_text` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | create | schema-pass | W-R: named root, bounded read, evidence | frozen external snapshot |
| 16 | `filesystem.stat` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | create | schema-pass | W-R: named root metadata, evidence | frozen external snapshot |
| 17 | `agent.preview` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | create | schema-pass | W-R: bounded read-only dispatch preview | frozen external snapshot |
| 18 | `agent.run` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | create | schema-pass | W-M: approval/configured worker boundary | frozen external snapshot |
| 19 | `result.get` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | read | schema-pass | G-R: governed result projection | frozen external snapshot |
| 20 | `evidence.list` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | read | schema-pass | G-R: metadata only; content omitted | frozen external snapshot |
| 21 | `evidence.get` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | read | schema-pass | G-R: bounded redacted evidence and access audit | frozen external snapshot |
| 22 | `service.restart.preview` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | create | schema-pass | W-R: registered service preview | frozen external snapshot |
| 23 | `service.restart` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | create | schema-pass | W-M: human approval, health evidence | frozen external snapshot |
| 24 | `config.change.preview` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | create | schema-pass | W-R: registered target/hash preview | frozen external snapshot |
| 25 | `config.change` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | create | schema-pass | W-M: approval, hash, backup, atomic write | frozen external snapshot |
| 26 | `create_directory` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | create | schema-pass | W-M: approved bounded filesystem write | frozen external snapshot |
| 27 | `edit_block` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | create | schema-pass | W-M: exact-match atomic patch | frozen external snapshot |
| 28 | `force_terminate` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | create | schema-pass | W-M: ACS-started process only | frozen external snapshot |
| 29 | `get_config` | `gateway/connector.ts` | local-55 | refresh-required | read | schema-pass | G-R: redacted ACS summary only | frozen external snapshot |
| 30 | `get_file_info` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | create | schema-pass | W-R: bounded named-root metadata | frozen external snapshot |
| 31 | `get_more_search_results` | `gateway/connector.ts` | local-55 | refresh-required | read | schema-pass | G-R: bounded completed-search page | frozen external snapshot |
| 32 | `get_prompts` | `gateway/connector.ts` | local-55 | refresh-required | read | schema-pass | G-R: fixed governed onboarding prompt | frozen external snapshot |
| 33 | `get_recent_tool_calls` | `gateway/connector.ts` | local-55 | refresh-required | read | schema-pass | G-R: redacted audit projection | frozen external snapshot |
| 34 | `get_usage_stats` | `gateway/connector.ts` | local-55 | refresh-required | read | schema-pass | G-R: bounded health/audit statistics | frozen external snapshot |
| 35 | `give_feedback_to_desktop_commander` | `gateway/connector.ts` | local-55 | refresh-required | read | schema-pass | F: reports unsupported external form | frozen external snapshot |
| 36 | `interact_with_process` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | create | schema-pass | W-M: approved input to ACS-started process | frozen external snapshot |
| 37 | `kill_process` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | create | schema-pass | W-M: approved ACS-started process termination | frozen external snapshot |
| 38 | `list_devices` | `gateway/connector.ts` | local-55 | refresh-required | read | schema-pass | G-R: ACS-local capability projection | frozen external snapshot |
| 39 | `list_directory` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | create | schema-pass | W-R: bounded named-root listing | frozen external snapshot |
| 40 | `list_processes` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | create | schema-pass | W-R: fixed bounded process diagnostic | frozen external snapshot |
| 41 | `list_searches` | `gateway/connector.ts` | local-55 | refresh-required | read | schema-pass | G-R: ACS-backed search sessions | frozen external snapshot |
| 42 | `list_sessions` | `gateway/connector.ts` | local-55 | refresh-required | read | schema-pass | G-R: ACS work-item sessions | frozen external snapshot |
| 43 | `move_file` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | create | schema-pass | W-M: approved bounded move | frozen external snapshot |
| 44 | `ping` | `gateway/connector.ts` | local-55 | refresh-required | read | schema-pass | G-R: local ACS reachability | frozen external snapshot |
| 45 | `read_file` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | create | schema-pass | W-R: bounded redacted named-root read | frozen external snapshot |
| 46 | `read_multiple_files` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | create | schema-pass | W-R: bounded multi-file read and evidence | frozen external snapshot |
| 47 | `read_process_output` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | create | schema-pass | W-R: bounded ACS process output | frozen external snapshot |
| 48 | `set_config_value` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | create | schema-pass | W-M: allowlisted key and human approval | frozen external snapshot |
| 49 | `shutdown` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | create | schema-pass | F: approval request; host shutdown disabled | frozen external snapshot |
| 50 | `start_process` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | create | schema-pass | W-M: registered command only, approval | frozen external snapshot |
| 51 | `start_search` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | create | schema-pass | W-R: bounded allowlisted search | frozen external snapshot |
| 52 | `stop_search` | `gateway/connector.ts` | local-55 | refresh-required | approve | schema-pass | L: governed search cancellation | frozen external snapshot |
| 53 | `who_am_i` | `gateway/connector.ts` | local-55 | refresh-required | read | schema-pass | G-R: authenticated actor projection | frozen external snapshot |
| 54 | `write_file` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | create | schema-pass | W-M: bounded atomic write and evidence | frozen external snapshot |
| 55 | `write_pdf` | `gateway/connector.ts` + machine registry | local-55 | refresh-required | create | schema-pass | W-M: bounded PDF write and evidence | frozen external snapshot |

## Current conclusion

The local gateway has one published remote inventory (`remoteMcpToolNames`) used by both JSON-RPC `tools/list` and the authenticated `/mcp/tools` compatibility route. Local bearer and OAuth test fixtures both return the same 55 names. The tunnel is healthy and has forwarded MCP traffic to the gateway, but the current ChatGPT action snapshot still contains only the six lifecycle names. ChatGPT must rescan/refresh the app actions, or the app must be recreated and republished where the workspace plan requires that, before external discovery can be accepted.

The current tunnel defaults to `acs:work:create` and `acs:work:read`; `acs:work:approve` remains a separate least-privilege scope. Discovering a tool does not grant that scope, and calls requiring approval scope must fail closed when it is absent.
