/**
 * Mechanical tool catalog: what each Desktop Commander tool DOES, not whether
 * any caller may use it. Desktop Commander mechanical capability does not
 * imply caller authorization; every entry reports authorization "external"
 * (ACS decides).
 */
export type ToolRiskClass = 'read' | 'write' | 'process' | 'process_control' | 'admin' | 'network_read';
export type Precondition = 'expectedSha256' | 'expectedHeadSha' | 'expectedCurrentSha256' | 'snapshotId' | 'owned_process';

export interface ToolMechanics {
  readonly category: string;
  readonly riskClass: ToolRiskClass;
  readonly mutating: boolean;
  readonly shellExecution: boolean;
  readonly requiresCwd: boolean;
  /** Where the tool may touch the filesystem. */
  readonly filesystemScope: 'allowed_directories' | 'dc_state' | 'allowed_directories+dc_state' | 'none';
  readonly supportedPreconditions: readonly Precondition[];
  readonly processScope?: 'dc_owned_sessions' | 'spawns' | 'arbitrary_pid';
  readonly legacy?: string;
}

const t = (m: Partial<ToolMechanics> & Pick<ToolMechanics, 'category' | 'riskClass'>): ToolMechanics => Object.freeze({
  mutating: false,
  shellExecution: false,
  requiresCwd: false,
  filesystemScope: 'none',
  supportedPreconditions: [],
  ...m,
});

export const TOOL_MECHANICS: Readonly<Record<string, ToolMechanics>> = Object.freeze({
  // configuration / identity / diagnostics
  get_config: t({ category: 'config', riskClass: 'read' }),
  set_config_value: t({ category: 'config', riskClass: 'admin', mutating: true, filesystemScope: 'dc_state' }),
  get_runtime_identity: t({ category: 'identity', riskClass: 'read', filesystemScope: 'dc_state' }),
  health: t({ category: 'diagnostics', riskClass: 'read' }),
  last_error: t({ category: 'diagnostics', riskClass: 'read' }),
  capability_manifest: t({ category: 'diagnostics', riskClass: 'read' }),
  operation_preview: t({ category: 'diagnostics', riskClass: 'read', filesystemScope: 'allowed_directories' }),
  get_usage_stats: t({ category: 'diagnostics', riskClass: 'read' }),
  get_recent_tool_calls: t({ category: 'diagnostics', riskClass: 'read' }),
  // filesystem
  read_file: t({ category: 'filesystem', riskClass: 'read', filesystemScope: 'allowed_directories' }),
  read_multiple_files: t({ category: 'filesystem', riskClass: 'read', filesystemScope: 'allowed_directories' }),
  list_directory: t({ category: 'filesystem', riskClass: 'read', filesystemScope: 'allowed_directories' }),
  get_file_info: t({ category: 'filesystem', riskClass: 'read', filesystemScope: 'allowed_directories' }),
  write_file: t({ category: 'filesystem', riskClass: 'write', mutating: true, filesystemScope: 'allowed_directories' }),
  write_pdf: t({ category: 'filesystem', riskClass: 'write', mutating: true, filesystemScope: 'allowed_directories' }),
  create_directory: t({ category: 'filesystem', riskClass: 'write', mutating: true, filesystemScope: 'allowed_directories' }),
  move_file: t({ category: 'filesystem', riskClass: 'write', mutating: true, filesystemScope: 'allowed_directories' }),
  edit_block: t({ category: 'filesystem', riskClass: 'write', mutating: true, filesystemScope: 'allowed_directories', legacy: 'prefer apply_patch (hash-guarded, atomic)' }),
  apply_patch: t({ category: 'filesystem', riskClass: 'write', mutating: true, filesystemScope: 'allowed_directories', supportedPreconditions: ['expectedSha256', 'expectedHeadSha'] }),
  snapshot_path: t({ category: 'snapshot', riskClass: 'write', mutating: true, filesystemScope: 'allowed_directories+dc_state' }),
  restore_snapshot: t({ category: 'snapshot', riskClass: 'write', mutating: true, filesystemScope: 'allowed_directories+dc_state', supportedPreconditions: ['snapshotId', 'expectedCurrentSha256'] }),
  // search
  start_search: t({ category: 'search', riskClass: 'read', filesystemScope: 'allowed_directories' }),
  get_more_search_results: t({ category: 'search', riskClass: 'read' }),
  stop_search: t({ category: 'search', riskClass: 'process_control', mutating: true }),
  list_searches: t({ category: 'search', riskClass: 'read' }),
  secret_scan: t({ category: 'security', riskClass: 'read', filesystemScope: 'allowed_directories' }),
  // git
  git_state: t({ category: 'git', riskClass: 'read', filesystemScope: 'allowed_directories' }),
  verify_head: t({ category: 'git', riskClass: 'read', filesystemScope: 'allowed_directories', supportedPreconditions: ['expectedHeadSha'] }),
  // process
  start_process: t({ category: 'process', riskClass: 'process', mutating: true, shellExecution: true, processScope: 'spawns', legacy: 'prefer run_command for bounded non-interactive commands' }),
  run_command: t({ category: 'process', riskClass: 'process', mutating: true, requiresCwd: true, filesystemScope: 'allowed_directories', processScope: 'spawns', supportedPreconditions: ['expectedHeadSha'] }),
  read_process_output: t({ category: 'process', riskClass: 'read', processScope: 'dc_owned_sessions', legacy: 'prefer wait_for_process (no polling)' }),
  wait_for_process: t({ category: 'process', riskClass: 'read', processScope: 'dc_owned_sessions', supportedPreconditions: ['owned_process'] }),
  interact_with_process: t({ category: 'process', riskClass: 'process', mutating: true, processScope: 'dc_owned_sessions' }),
  terminate_process: t({ category: 'process', riskClass: 'process_control', mutating: true, processScope: 'dc_owned_sessions', supportedPreconditions: ['owned_process'] }),
  force_terminate: t({ category: 'process', riskClass: 'process_control', mutating: true, processScope: 'dc_owned_sessions', legacy: 'prefer terminate_process (explicit ownership + escalation result)' }),
  kill_process: t({ category: 'process', riskClass: 'process_control', mutating: true, processScope: 'arbitrary_pid', legacy: 'LEGACY: signals any pid; prefer terminate_process' }),
  list_sessions: t({ category: 'process', riskClass: 'read', processScope: 'dc_owned_sessions' }),
  list_processes: t({ category: 'process', riskClass: 'read' }),
  // services
  service_status: t({ category: 'service', riskClass: 'network_read' }),
  // acpx
  acpx_list_sessions: t({ category: 'acpx', riskClass: 'process', processScope: 'spawns' }),
  acpx_get_session: t({ category: 'acpx', riskClass: 'process', processScope: 'spawns' }),
  acpx_exec: t({ category: 'acpx', riskClass: 'process', mutating: true, processScope: 'spawns' }),
  acpx_prompt: t({ category: 'acpx', riskClass: 'process', mutating: true, processScope: 'spawns' }),
  acpx_cancel: t({ category: 'acpx', riskClass: 'process_control', mutating: true, processScope: 'spawns' }),
  // product
  get_prompts: t({ category: 'product', riskClass: 'read' }),
  give_feedback_to_desktop_commander: t({ category: 'product', riskClass: 'network_read' }),
  track_ui_event: t({ category: 'product', riskClass: 'read' }),
});

export function toolMechanics(tool: string): ToolMechanics | undefined {
  return TOOL_MECHANICS[tool];
}

export function operationClass(tool: string): string {
  const m = TOOL_MECHANICS[tool];
  return m ? `${m.category}.${m.riskClass}` : 'unknown';
}
