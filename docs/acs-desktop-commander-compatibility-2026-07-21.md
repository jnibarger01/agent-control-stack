# ACS Desktop Commander compatibility surface — 2026-07-21

ACS now publishes the requested Desktop Commander-shaped tool names through its authenticated gateway MCP. They are compatibility names, not a bypass around ACS.

## Boundary

The execution path is:

MCP auth → input schema → ACS work item → policy decision → human approval when required → worker lease → registered machine action → bounded redacted evidence

The filesystem root is the registered acs-repo root. Relative traversal, credential-like paths, arbitrary commands, arbitrary PIDs, and unregistered service/config targets fail closed.

## Published tools

The following names are available in tools/list:

create_directory, edit_block, force_terminate, get_config, get_file_info, get_more_search_results, get_prompts, get_recent_tool_calls, get_usage_stats, give_feedback_to_desktop_commander, interact_with_process, kill_process, list_devices, list_directory, list_processes, list_searches, list_sessions, move_file, ping, read_file, read_multiple_files, read_process_output, set_config_value, shutdown, start_process, start_search, stop_search, who_am_i, write_file, and write_pdf.

## ACS-specific behavior

- read_file, read_multiple_files, list_directory, get_file_info, and start_search create bounded read work items; their results are retrieved through the normal result/evidence path.
- write_file, create_directory, edit_block, move_file, write_pdf, and set_config_value require human approval and use atomic or exact-match operations.
- start_process accepts only a registered command ID, not a shell string. interact_with_process, read_process_output, kill_process, and force_terminate can address only a process previously started by the ACS worker.
- shutdown is exposed as an approval-gated compatibility request but the worker deliberately fails closed; ACS does not expose host shutdown.
- get_config returns a redacted ACS policy/registry summary. It never returns credentials or raw environment values.
- get_prompts returns ACS compatibility prompts. give_feedback_to_desktop_commander reports that ACS does not open an external browser feedback form.
- list_devices, ping, who_am_i, list_searches, list_sessions, get_recent_tool_calls, and get_usage_stats report ACS-local state only.

## Verification status

Full repository verification passes: 51 Vitest files with 390 tests, 48 AgentOS contract tests, public-site safety checks, typecheck, lint, production build, formatting, and secret scanning.

The restarted local ACS gateway and worker are healthy. Authenticated loopback tools/list returns 55 tools, including all 30 requested names. A live read_file request created an approved fs.read work item that the worker completed successfully.

A live ChatGPT-originated proof now exists through the connected `ACS Secure Tunnel` app: its action snapshot contains all 55 names, and read-only calls reached the registered actor and ACS worker boundary. The older `ACS` app still exposes only the six lifecycle names. The new app is configured as `No Auth`; its tunnel-injected local bearer is governed by ACS but is not OAuth-backed identity/scope provenance, so the strict external acceptance remains `PARTIAL`.
