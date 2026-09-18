/**
 * Risk-aware approval policy (kernel issue #5).
 *
 * Maps a command class to an approval policy, classifies operations with
 * conservative heuristics, and produces approval requests that carry the
 * EXACT mutation scope (resolved paths, command string, network targets) so
 * an approver never approves a redacted summary. Includes an in-memory
 * ApprovalStore with a hook interface the parent can wire to Telegram/UI.
 */
import crypto from 'node:crypto';
import type { CommandClass, NetworkProfile } from './capability.js';

export { isCommandClass, isNetworkProfile } from './capability.js';

export type ApprovalDecision = 'approved' | 'denied' | 'expired' | 'pending';

export type ApprovalPolicyMode = 'auto-approve' | 'require-approval' | 'deny';

export interface ApprovalPolicy {
  readonly commandClass: CommandClass;
  readonly mode: ApprovalPolicyMode;
  readonly reason: string;
}

export function getApprovalPolicy(commandClass: CommandClass): ApprovalPolicy {
  if (commandClass === 'read-only') {
    return { commandClass, mode: 'auto-approve', reason: 'read-only operations cannot mutate state' };
  }
  if (commandClass === 'local-write') {
    const env = process.env.DC_APPROVE_LOCAL_WRITES;
    const mode: ApprovalPolicyMode = env === 'deny' ? 'require-approval' : 'auto-approve';
    return {
      commandClass,
      mode,
      reason: mode === 'require-approval'
        ? 'DC_APPROVE_LOCAL_WRITES=deny requires approval for local writes'
        : 'local writes auto-approve by default (DC_APPROVE_LOCAL_WRITES not set to deny)',
    };
  }
  return {
    commandClass,
    mode: 'require-approval',
    reason: `${commandClass} operations always require explicit approval`,
  };
}

export interface ClassifiedOperation {
  tool: string;
  args: Record<string, unknown>;
  commandClass: CommandClass;
  network: NetworkProfile;
  paths: string[];
  command?: string;
  networkTargets: string[];
  reason: string;
}

export interface OperationInput {
  tool: string;
  args: Record<string, unknown>;
}

const DESTRUCTIVE_PATTERNS: readonly RegExp[] = Object.freeze([
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/,
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f/,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\s+.*\bof=/,
  /\bchmod\s+(-R\s+)?777\b/,
  /\bsudo\b/,
  /\bgit\s+push\s+(.*\s)?--force\b/,
  /\b:\(\)\{.*\};\s*:/,
  /\bshutdown\b/,
  /\breboot\b/,
]);

const NETWORK_FETCH_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bcurl\b/,
  /\bwget\b/,
  /\bnc\b/,
  /\bnetcat\b/,
  /\bssh\b/,
  /\bscp\b/,
  /\bftp\b/,
  /\bgit\s+clone\b/,
  /\bgit\s+push\b/,
  /\bgit\s+pull\b/,
  /\bgit\s+fetch\b/,
  /\bnpm\s+(install|i|add|update)\b/,
  /\bpip\s+install\b/,
]);

const SECRET_READ_PATTERNS: readonly RegExp[] = Object.freeze([
  /\benv\b/i,
  /\bprintenv\b/,
  /\bexport\s+.*KEY|.*TOKEN|.*SECRET|.*PASSWORD/i,
  /\bcat\b.*\.(env|pem|key)\b/,
  /\bcredentials?\b/i,
  /\.ssh\b/,
  /\b\.aws\b/,
  /\b\.gnupg\b/,
  /\bsecrets?\b/i,
]);

const WRITE_TOOLS = new Set(['write_file', 'edit_block', 'create_directory', 'move_file']);
const READ_TOOLS = new Set([
  'read_file', 'read_multiple_files', 'list_directory', 'get_file_info',
  'search_files', 'get_config', 'list_processes', 'read_process_output',
]);
const PATH_KEYS = ['path', 'paths', 'source', 'destination', 'file', 'target', 'directory'] as const;
const NETWORK_TARGET_KEYS = ['url', 'host', 'hostname', 'endpoint', 'server'] as const;

function asStringArray(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  return [];
}

export function classifyOperation(input: OperationInput): ClassifiedOperation {
  const { tool, args } = input;
  const paths: string[] = [];
  for (const key of PATH_KEYS) {
    for (const entry of asStringArray(args[key])) paths.push(entry);
  }
  const networkTargets: string[] = [];
  for (const key of NETWORK_TARGET_KEYS) {
    for (const entry of asStringArray(args[key])) networkTargets.push(entry);
  }
  const command = typeof args.command === 'string' ? args.command : undefined;

  let commandClass: CommandClass = 'read-only';
  let reason = 'default conservative classification';

  if (command !== undefined) {
    if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command))) {
      commandClass = 'destructive';
      reason = 'terminal command matches a destructive pattern (rm -rf, mkfs, dd, chmod 777, sudo, force push, ...)';
    } else if (SECRET_READ_PATTERNS.some((pattern) => pattern.test(command))) {
      commandClass = 'secret';
      reason = 'terminal command reads environment or credential-like material';
    } else if (NETWORK_FETCH_PATTERNS.some((pattern) => pattern.test(command))) {
      commandClass = 'external';
      reason = 'terminal command invokes a network-capable binary (curl, wget, git push, package installs, ...)';
    } else {
      commandClass = 'local-write';
      reason = 'terminal command spawns a local process with unknown side effects';
    }
  } else if (networkTargets.length > 0 && !READ_TOOLS.has(tool)) {
    commandClass = 'external';
    reason = 'arguments contain explicit network targets on a non-read tool';
  } else if (tool === 'start_process') {
    commandClass = 'destructive';
    reason = 'process spawn with no command string is treated as destructive (conservative)';
  } else if (WRITE_TOOLS.has(tool)) {
    commandClass = 'local-write';
    reason = `tool '${tool}' mutates the filesystem`;
  } else if (SECRET_READ_PATTERNS.some((pattern) => pattern.test(tool))) {
    commandClass = 'secret';
    reason = `tool name '${tool}' matches a credential-read pattern`;
  } else if (READ_TOOLS.has(tool)) {
    commandClass = 'read-only';
    reason = `tool '${tool}' is a known read-only tool`;
  }

  const network: NetworkProfile = networkTargets.length > 0 ? 'restricted' : 'none';

  return {
    tool,
    args,
    commandClass,
    network,
    paths,
    command,
    networkTargets,
    reason,
  };
}

export interface ApprovalRequest {
  approvalId: string;
  tool: string;
  commandClass: CommandClass;
  command?: string;
  resolvedPaths: string[];
  networkTargets: string[];
  network: NetworkProfile;
  classificationReason: string;
  createdAt: number;
  expiresAt: number;
}

export function buildApprovalRequest(op: ClassifiedOperation, now: number = Date.now()): ApprovalRequest {
  return {
    approvalId: crypto.randomUUID(),
    tool: op.tool,
    commandClass: op.commandClass,
    command: op.command,
    resolvedPaths: [...op.paths],
    networkTargets: [...op.networkTargets],
    network: op.network,
    classificationReason: op.reason,
    createdAt: now,
    expiresAt: now + 5 * 60 * 1000,
  };
}

export type ApprovalRequiredHook = (request: ApprovalRequest) => void | Promise<void>;

export interface ApprovalStore {
  onApprovalRequired: ApprovalRequiredHook | undefined;
  submit(request: ApprovalRequest): string;
  pending(): ApprovalRequest[];
  resolve(approvalId: string, decision: 'approved' | 'denied'): boolean;
  decision(approvalId: string): ApprovalDecision | undefined;
}

/**
 * In-memory approval store. `submit` records a pending request and invokes
 * the optional onApprovalRequired hook (the parent wires Telegram/UI here).
 */
export class InMemoryApprovalStore implements ApprovalStore {
  onApprovalRequired: ApprovalRequiredHook | undefined;
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly decisions = new Map<string, Exclude<ApprovalDecision, 'pending'>>();

  submit(request: ApprovalRequest): string {
    this.requests.set(request.approvalId, request);
    if (this.onApprovalRequired) {
      const result = this.onApprovalRequired(request);
      if (result instanceof Promise) {
        result.catch(() => {
          // Hook failures must not crash the approval path; the request stays pending.
        });
      }
    }
    return request.approvalId;
  }

  pending(): ApprovalRequest[] {
    const now = Date.now();
    const result: ApprovalRequest[] = [];
    for (const [id, request] of this.requests) {
      if (this.decisions.has(id)) continue;
      if (request.expiresAt <= now) {
        this.decisions.set(id, 'expired');
        continue;
      }
      result.push(request);
    }
    return result;
  }

  resolve(approvalId: string, decision: 'approved' | 'denied'): boolean {
    if (!this.requests.has(approvalId) || this.decisions.has(approvalId)) return false;
    this.decisions.set(approvalId, decision);
    return true;
  }

  decision(approvalId: string): ApprovalDecision | undefined {
    const recorded = this.decisions.get(approvalId);
    if (recorded) return recorded;
    const request = this.requests.get(approvalId);
    if (request && request.expiresAt <= Date.now()) {
      this.decisions.set(approvalId, 'expired');
      return 'expired';
    }
    return this.requests.has(approvalId) ? 'pending' : undefined;
  }
}
