/** Dependency-free MCP tools/list descriptors for Jace Commander. */
const str = (description: string) => ({ type: 'string', description });

export const JC_TOOLS = [
  {
    name: 'jc_status',
    description: 'Report Jace Commander mode, configured endpoints, reachability of ACS / codex-swarm / visualizer, and whether the privileged helper is installed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'acs_read',
    description: 'Read from the Agent Control Stack gateway: health, work-items (optionally by status), or one work-item with its events, attempts and leases.',
    inputSchema: {
      type: 'object',
      properties: { view: { type: 'string', enum: ['health', 'work-items', 'work-item'] }, id: str('Work item id (view=work-item)'), status: str('Status filter (view=work-items)') },
      required: ['view'],
      additionalProperties: false,
    },
  },
  {
    name: 'acs_submit_mission',
    description: 'Submit a mission to ACS as a governed work item. ACS policy decides allow / deny / require_approval; nothing executes here.',
    inputSchema: {
      type: 'object',
      properties: {
        title: str('Short title'),
        intent: str('What should happen and why'),
        target: { type: 'object', description: 'ACS target {repo?, cwd?, files?, services?}' },
        requestedActions: { type: 'array', items: { type: 'object' } },
        risk: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        correlationId: str('Caller correlation id'),
      },
      required: ['title', 'intent', 'target'],
      additionalProperties: false,
    },
  },
  {
    name: 'swarm_read',
    description: 'Read-only codex-swarm views: health, mission-control, runs, status (by taskId), task (by taskId).',
    inputSchema: {
      type: 'object',
      properties: { view: { type: 'string', enum: ['health', 'mission-control', 'runs', 'status', 'task'] }, taskId: str('codex-swarm task id') },
      required: ['view'],
      additionalProperties: false,
    },
  },
  {
    name: 'visualizer_read',
    description: 'Read-only Agent Workflow Visualizer views (loopback, same OS user): system-status, runtimes, executions, approvals, alerts, agents.',
    inputSchema: {
      type: 'object',
      properties: { view: { type: 'string', enum: ['system-status', 'runtimes', 'executions', 'approvals', 'alerts', 'agents'] } },
      required: ['view'],
      additionalProperties: false,
    },
  },
  {
    name: 'mission_router_list',
    description: 'List retired Mission Router local state (~/.mission-router): mission ids/states only, plus LoopTrace chain verification of its JSONL audit files.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'looptrace_verify',
    description: 'Verify a LoopTrace JSONL hash chain under an allowed trace root. Returns event count and the first tamper point, if any.',
    inputSchema: {
      type: 'object',
      properties: { path: str('Absolute path to a .jsonl trace') },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'privileged_exec',
    description: 'Run ONE exact command as root via the jc-privileged-helper. Requires an ACS acs.jc.v1 capability carrying a human approvalId bound to this exact argv/cwd/timeoutMs/stdin. The first call returns an ACS approval challenge (workItemId, actionHash, argv); after a human approves it in ACS, retry the identical call. Each approval authorizes one run. No shell: argv[0] must be an absolute path.',
    inputSchema: {
      type: 'object',
      properties: {
        argv: { type: 'array', items: { type: 'string' }, minItems: 1 },
        cwd: str('Absolute working directory (default /)'),
        timeoutMs: { type: 'integer', minimum: 1, maximum: 600000 },
        stdin: str('Optional stdin (<= 64 KiB)'),
      },
      required: ['argv'],
      additionalProperties: false,
    },
  },
] as const;
