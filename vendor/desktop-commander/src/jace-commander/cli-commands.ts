/**
 * `jace-commander` CLI command table.
 *
 * Every tool-backed command maps argv to exactly one manifest tool and its
 * arguments, then calls it over /jc/mcp. The command's verb must be listed in
 * that tool's manifest `cliCommands` (the root drift test checks both
 * directions), so the CLI surface cannot silently diverge from the manifest.
 *
 * Paths are resolved here, client-side, to absolute paths before the call:
 * ACS signs the exact arguments and Jace Commander contains exactly those.
 */
import os from 'node:os';
import path from 'node:path';
import { JC_MANIFEST } from './manifest.generated.js';

export class CliUsageError extends Error {}

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | true>;
}

/** --flag value | --flag=value | boolean --flag; `--` ends flag parsing. */
export function parseArgs(argv: readonly string[], booleanFlags: readonly string[] = []): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = arg.slice(2, eq === -1 ? undefined : eq);
      if (eq !== -1) flags.set(name, arg.slice(eq + 1));
      else if (booleanFlags.includes(name)) flags.set(name, true);
      else {
        const value = argv[index + 1];
        if (value === undefined) throw new CliUsageError(`--${name} needs a value`);
        flags.set(name, value);
        index += 1;
      }
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, flags };
}

function flag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function intFlag(args: ParsedArgs, name: string): number | undefined {
  const value = flag(args, name);
  if (value === undefined) return undefined;
  if (!/^-?\d+$/u.test(value)) throw new CliUsageError(`--${name} must be an integer`);
  return Number(value);
}

/** `~`, relative and absolute paths → absolute, resolved against the CLI's cwd. */
export function absolutePath(input: string, cwd = process.cwd(), home = os.homedir()): string {
  if (input === '~') return home;
  if (input.startsWith('~/')) return path.join(home, input.slice(2));
  return path.resolve(cwd, input);
}

function requirePositional(args: ParsedArgs, index: number, name: string): string {
  const value = args.positionals[index];
  if (value === undefined) throw new CliUsageError(`missing <${name}>`);
  return value;
}

export interface CliCommand {
  verb: string;
  tool: string;
  usage: string;
  summary: string;
  booleanFlags?: readonly string[];
  toArguments(args: ParsedArgs): Record<string, unknown>;
  /** Human rendering of a successful structured result. */
  render(result: Record<string, unknown> | undefined, text: string | undefined): string;
}

const asJson = (value: unknown) => JSON.stringify(value, null, 2);

function renderListing(result: Record<string, unknown> | undefined): string {
  const entries = (result?.entries ?? []) as Array<{ path: string; type: string; size?: number }>;
  const lines = entries.map((entry) => {
    const suffix = entry.type === 'directory' ? '/' : entry.type === 'symlink' ? '@' : '';
    const size = entry.size !== undefined ? String(entry.size).padStart(10) : ''.padStart(10);
    return `${size}  ${entry.path}${suffix}`;
  });
  if (result?.truncated) lines.push(`… truncated after ${entries.length} entries`);
  return lines.join('\n');
}

export const CLI_COMMANDS: readonly CliCommand[] = Object.freeze([
  {
    verb: 'status',
    tool: 'jc_status',
    usage: 'status',
    summary: 'Runtime status reported by the Jace Commander server (via /jc/mcp)',
    toArguments: () => ({}),
    render: (result) => asJson(result),
  },
  {
    verb: 'ls',
    tool: 'list_directory',
    usage: 'ls [path] [--depth N]',
    summary: 'List a directory (default: current directory)',
    toArguments: (args) => {
      const depth = intFlag(args, 'depth');
      return { path: absolutePath(args.positionals[0] ?? '.'), ...(depth !== undefined ? { depth } : {}) };
    },
    render: (result) => renderListing(result),
  },
  {
    verb: 'stat',
    tool: 'get_file_info',
    usage: 'stat <path>',
    summary: 'File or directory metadata',
    toArguments: (args) => ({ path: absolutePath(requirePositional(args, 0, 'path')) }),
    render: (result) => Object.entries(result ?? {})
      .map(([key, value]) => `${key.padEnd(14)} ${String(value)}`)
      .join('\n'),
  },
  {
    verb: 'read',
    tool: 'read_file',
    usage: 'read <path> [--offset N] [--length N]',
    summary: 'Read a line window of a file (negative --offset reads from the end)',
    toArguments: (args) => {
      const offset = intFlag(args, 'offset');
      const length = intFlag(args, 'length');
      return {
        path: absolutePath(requirePositional(args, 0, 'path')),
        ...(offset !== undefined ? { offset } : {}),
        ...(length !== undefined ? { length } : {}),
      };
    },
    render: (result) => {
      const header = `# ${String(result?.path)}  lines ${String(result?.offset)}+${String(result?.returnedLines ?? '?')}` +
        (result?.totalLines !== undefined ? ` of ${String(result.totalLines)}` : '') +
        (result?.hasMore ? '  (more)' : '');
      return `${header}\n${String(result?.content ?? '')}`;
    },
  },
  {
    verb: 'cat',
    tool: 'read_file',
    usage: 'cat <path>',
    summary: 'Print a file (up to 10000 lines; use `read` to page further)',
    toArguments: (args) => ({ path: absolutePath(requirePositional(args, 0, 'path')), length: 10_000 }),
    render: (result) => String(result?.content ?? ''),
  },
  {
    verb: 'search',
    tool: 'start_search',
    usage: 'search <pattern> [path] [--files] [--content] [--regex] [--ignore-case] [--filter GLOB] [--limit N]',
    summary: 'Search file contents (default) or names under a directory',
    booleanFlags: ['files', 'content', 'regex', 'ignore-case'],
    toArguments: (args) => {
      if (args.flags.get('files') === true && args.flags.get('content') === true) {
        throw new CliUsageError('pass only one of --files or --content');
      }
      const limit = intFlag(args, 'limit');
      return {
        pattern: requirePositional(args, 0, 'pattern'),
        path: absolutePath(args.positionals[1] ?? '.'),
        mode: args.flags.get('files') === true ? 'filename' : 'content',
        ...(args.flags.get('regex') === true ? { regex: true } : {}),
        ...(args.flags.get('ignore-case') === true ? { caseSensitive: false } : {}),
        ...(flag(args, 'filter') ? { fileFilter: flag(args, 'filter') } : {}),
        ...(limit !== undefined ? { limit } : {}),
      };
    },
    render: (result) => {
      const hits = (result?.results ?? []) as Array<{ path: string; line?: number; text?: string }>;
      const lines = hits.map((hit) => (hit.line ? `${hit.path}:${hit.line}: ${hit.text ?? ''}` : hit.path));
      const tail = `search ${String(result?.searchId)}  matched ${String(result?.matched)}  scanned ${String(result?.scanned)}` +
        (result?.hasMore ? '  (more: search-results)' : '') +
        (result?.truncated ? '  truncated' : '');
      return [...lines, tail].join('\n');
    },
  },
  {
    verb: 'search-results',
    tool: 'get_more_search_results',
    usage: 'search-results <search-id> [--limit N]',
    summary: 'Next page of a search',
    toArguments: (args) => {
      const limit = intFlag(args, 'limit');
      return { searchId: requirePositional(args, 0, 'search-id'), ...(limit !== undefined ? { limit } : {}) };
    },
    render: (result) => {
      const hits = (result?.results ?? []) as Array<{ path: string; line?: number; text?: string }>;
      return hits.map((hit) => (hit.line ? `${hit.path}:${hit.line}: ${hit.text ?? ''}` : hit.path)).join('\n');
    },
  },
  {
    verb: 'search-status',
    tool: 'list_searches',
    usage: 'search-status',
    summary: 'List searches without their hit contents',
    toArguments: () => ({}),
    render: (result) => asJson(result),
  },
  {
    verb: 'search-stop',
    tool: 'stop_search',
    usage: 'search-stop <search-id>',
    summary: 'Cancel a search',
    toArguments: (args) => ({ searchId: requirePositional(args, 0, 'search-id') }),
    render: (result) => asJson(result),
  },
  {
    verb: 'acs read',
    tool: 'acs_read',
    usage: 'acs read <health|work-items|work-item> [--id ID] [--status STATUS]',
    summary: 'Read ACS health or work items',
    toArguments: (args) => ({
      view: requirePositional(args, 0, 'view'),
      ...(flag(args, 'id') ? { id: flag(args, 'id') } : {}),
      ...(flag(args, 'status') ? { status: flag(args, 'status') } : {}),
    }),
    render: (result, text) => (result ? asJson(result) : text ?? ''),
  },
  {
    verb: 'acs submit',
    tool: 'acs_submit_mission',
    usage: 'acs submit --title T --intent I --target JSON [--actions JSON] [--risk low|medium|high|critical]',
    summary: 'Submit a mission to ACS as a governed work item',
    toArguments: (args) => {
      const parseJson = (name: string) => {
        const raw = flag(args, name);
        if (raw === undefined) return undefined;
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          throw new CliUsageError(`--${name} must be JSON`);
        }
      };
      const title = flag(args, 'title');
      const intent = flag(args, 'intent');
      const target = parseJson('target');
      if (!title || !intent || target === undefined) throw new CliUsageError('--title, --intent and --target are required');
      const actions = parseJson('actions');
      return {
        title, intent, target,
        ...(actions !== undefined ? { requestedActions: actions } : {}),
        ...(flag(args, 'risk') ? { risk: flag(args, 'risk') } : {}),
      };
    },
    render: (result, text) => (result ? asJson(result) : text ?? ''),
  },
  {
    verb: 'swarm read',
    tool: 'swarm_read',
    usage: 'swarm read <health|mission-control|runs|status|task> [--task ID]',
    summary: 'Read-only codex-swarm views',
    toArguments: (args) => ({
      view: requirePositional(args, 0, 'view'),
      ...(flag(args, 'task') ? { taskId: flag(args, 'task') } : {}),
    }),
    render: (result, text) => (result ? asJson(result) : text ?? ''),
  },
  {
    verb: 'visualizer read',
    tool: 'visualizer_read',
    usage: 'visualizer read <system-status|runtimes|executions|approvals|alerts|agents>',
    summary: 'Read-only Agent Workflow Visualizer views',
    toArguments: (args) => ({ view: requirePositional(args, 0, 'view') }),
    render: (result, text) => (result ? asJson(result) : text ?? ''),
  },
  {
    verb: 'mission list',
    tool: 'mission_router_list',
    usage: 'mission list',
    summary: 'List Mission Router state (ids/states only)',
    toArguments: () => ({}),
    render: (result, text) => (result ? asJson(result) : text ?? ''),
  },
  {
    verb: 'looptrace verify',
    tool: 'looptrace_verify',
    usage: 'looptrace verify <trace.jsonl>',
    summary: 'Verify a LoopTrace hash chain',
    toArguments: (args) => ({ path: absolutePath(requirePositional(args, 0, 'path')) }),
    render: (result) => asJson(result),
  },
  {
    verb: 'sudo',
    tool: 'privileged_exec',
    usage: 'sudo [--cwd DIR] [--timeout MS] -- /abs/path/to/program [args...]',
    summary: 'Run ONE exact command as root after a human approves it in ACS',
    toArguments: (args) => {
      const argv = args.positionals;
      if (argv.length === 0) throw new CliUsageError('missing command');
      if (!path.isAbsolute(argv[0]!)) throw new CliUsageError('argv[0] must be an absolute path (no shell, no PATH lookup)');
      const timeoutMs = intFlag(args, 'timeout');
      return {
        argv,
        ...(flag(args, 'cwd') ? { cwd: absolutePath(flag(args, 'cwd')!) } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    },
    render: (result) => asJson(result),
  },
] satisfies readonly CliCommand[]);

/** Find the command for argv, longest (two-word) verb first. */
export function resolveCommand(argv: readonly string[]): { command: CliCommand; rest: string[] } | undefined {
  const two = argv.slice(0, 2).join(' ');
  const byTwo = CLI_COMMANDS.find((command) => command.verb === two);
  if (byTwo) return { command: byTwo, rest: argv.slice(2) };
  const byOne = CLI_COMMANDS.find((command) => command.verb === argv[0]);
  return byOne ? { command: byOne, rest: argv.slice(1) } : undefined;
}

const GROUP_TITLES: Record<string, string> = {
  system: 'System',
  filesystem: 'Filesystem',
  search: 'Search',
  acs: 'ACS',
  mission: 'Mission Router / LoopTrace',
  swarm: 'Swarm',
  visualizer: 'Visualizer',
  privileged: 'Privileged (always requires human approval in ACS)',
};

/** Local commands that never touch /jc/mcp. */
export const LOCAL_COMMANDS: ReadonlyArray<{ usage: string; summary: string }> = Object.freeze([
  { usage: 'connect [--mcp-url URL]', summary: 'Authorize this CLI against /jc/mcp (browser approval)' },
  { usage: 'disconnect', summary: 'Forget the stored /jc/mcp credential' },
  { usage: 'tools [--remote]', summary: 'List tools (manifest; --remote asks the server via tools/list)' },
  { usage: 'status --local', summary: 'Local readiness: config, credentials, sudo helper (no network)' },
  { usage: 'login | whoami | logout', summary: 'ACS device login used by the server for acs_submit_mission' },
  { usage: 'serve [--standalone]', summary: 'Run the stdio MCP server (spawned by the gateway bridge)' },
  { usage: 'version', summary: 'Print version and manifest hash' },
  { usage: 'help', summary: 'This help' },
]);

export function helpText(): string {
  const lines = [
    'Jace Commander',
    '',
    'Usage:',
    '  jace-commander <command> [options]      (alias: jc)',
    '',
    'Every tool command runs through the managed /jc/mcp lane: ACS authorizes',
    'it (and may require human approval) exactly as for any other MCP client.',
    '',
  ];
  const toolGroups = new Map<string, CliCommand[]>();
  for (const command of CLI_COMMANDS) {
    const group = JC_MANIFEST.tools.find((tool) => tool.name === command.tool)?.group ?? 'system';
    toolGroups.set(group, [...(toolGroups.get(group) ?? []), command]);
  }
  const width = 30;
  const row = (usage: string, summary: string) =>
    usage.length < width - 1 ? `  ${usage.padEnd(width)}${summary}` : `  ${usage}\n  ${''.padEnd(width)}${summary}`;
  for (const group of Object.keys(GROUP_TITLES)) {
    const commands = toolGroups.get(group);
    if (!commands) continue;
    lines.push(GROUP_TITLES[group]!);
    for (const command of commands) lines.push(row(command.usage, command.summary));
    lines.push('');
  }
  lines.push('Local');
  for (const command of LOCAL_COMMANDS) lines.push(row(command.usage, command.summary));
  lines.push(
    '',
    'Global options:',
    '  --json            Machine-readable output (structured result or error)',
    '',
    'Exit codes:',
    '  0 success   1 tool failure   2 invalid arguments   3 authorization denied',
    '  4 approval required   5 ACS/authority unavailable   6 not connected (run `connect`)',
    '',
    'Environment: JC_MCP_URL (default: the public /jc/mcp URL), JC_MCP_TOKEN (bearer override).',
  );
  return lines.join('\n');
}
