import fs from 'node:fs/promises';
import { commandManager } from '../command-manager.js';
import { authorizationArguments } from '../managed-acs.js';
import { DcToolError } from './errors.js';
import { normalizedArgumentsHash } from './context.js';
import { assertExecutableNotBlocked, realExecutable, whichExecutable } from './scope.js';
import { validatePath } from '../tools/filesystem.js';
import { TOOL_MECHANICS } from './tool-catalog.js';

/**
 * operation_preview: a LOCAL MECHANICAL preview of a proposed operation.
 *
 * It resolves what Desktop Commander would touch and how (paths, cwd, argv,
 * shell use, DC-level command restrictions, preconditions) without executing
 * anything. It is not a policy check and never returns `authorized`: the
 * output always says `authorization: "external"` (ACS decides).
 */
const SINGLE_PATH_KEYS = ['path', 'file_path', 'source', 'destination', 'repoPath'] as const;

export interface PathPreview {
  argument: string;
  requested: string;
  resolved: string | null;
  insideAllowedDirectories: boolean;
  exists: boolean;
  problem?: string;
}

async function previewPath(argument: string, requested: string): Promise<PathPreview> {
  try {
    const resolved = await validatePath(requested);
    const exists = await fs.stat(resolved).then(() => true, () => false);
    return { argument, requested, resolved, insideAllowedDirectories: true, exists };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      argument,
      requested,
      resolved: null,
      insideAllowedDirectories: !/^Path not allowed/.test(message) ? true : false,
      exists: false,
      problem: /^Path not allowed/.test(message) ? 'DC_PATH_OUTSIDE_ALLOWED_SCOPE' : 'DC_INVALID_ARGUMENT',
    };
  }
}

export async function operationPreview(input: { tool: unknown; arguments?: unknown }) {
  if (typeof input.tool !== 'string') throw new DcToolError('DC_INVALID_ARGUMENT', 'tool must be a string', { stage: 'validate' });
  const tool = input.tool.trim();
  const mechanics = TOOL_MECHANICS[tool];
  if (!mechanics) throw new DcToolError('DC_INVALID_ARGUMENT', `unknown tool: ${tool}`, { stage: 'validate' });
  const raw = input.arguments ?? {};
  const problems: string[] = [];
  let normalized: Record<string, unknown> = {};
  try {
    normalized = authorizationArguments(raw);
  } catch (error) {
    problems.push(`DC_INVALID_ARGUMENT: ${error instanceof Error ? error.message : String(error)}`);
  }

  const paths: PathPreview[] = [];
  for (const key of SINGLE_PATH_KEYS) {
    if (typeof normalized[key] === 'string') paths.push(await previewPath(key, normalized[key] as string));
  }
  if (Array.isArray(normalized.paths)) {
    for (const [i, entry] of (normalized.paths as unknown[]).entries()) {
      if (typeof entry === 'string') paths.push(await previewPath(`paths[${i}]`, entry));
    }
  }
  let cwd: PathPreview | null = null;
  if (typeof normalized.cwd === 'string') cwd = await previewPath('cwd', normalized.cwd);
  else if (mechanics.requiresCwd) problems.push('DC_INVALID_ARGUMENT: cwd is required');
  for (const p of [...paths, ...(cwd ? [cwd] : [])]) if (p.problem) problems.push(`${p.problem}: ${p.argument}`);

  let command: Record<string, unknown> | null = null;
  if (tool === 'run_command') {
    const argv = Array.isArray(normalized.argv) && normalized.argv.every((a) => typeof a === 'string') ? normalized.argv as string[] : null;
    if (!argv || argv.length === 0) problems.push('DC_INVALID_ARGUMENT: argv must be a non-empty string array');
    else {
      const resolvedExecutable = await whichExecutable(argv[0], cwd?.resolved ?? undefined);
      let restriction = 'not_blocked_by_dc_config';
      try {
        await assertExecutableNotBlocked(argv[0]);
        if (resolvedExecutable) {
          await assertExecutableNotBlocked(resolvedExecutable);
          await assertExecutableNotBlocked(await realExecutable(resolvedExecutable));
        }
      } catch (error) {
        restriction = error instanceof DcToolError ? error.dcCode : 'DC_INTERNAL_ERROR';
        problems.push(`${restriction}: ${argv[0]}`);
      }
      if (!resolvedExecutable) problems.push(`DC_COMMAND_NOT_FOUND: ${argv[0]}`);
      command = { normalizedArgv: argv, resolvedExecutable, usesShell: false, dcCommandRestriction: restriction };
    }
  } else if (tool === 'start_process' && typeof normalized.command === 'string') {
    const allowed = await commandManager.validateCommand(normalized.command);
    if (!allowed) problems.push('DC_COMMAND_FORBIDDEN: blocked by Desktop Commander blockedCommands');
    command = {
      commandLine: normalized.command,
      usesShell: true,
      shell: typeof normalized.shell === 'string' ? normalized.shell : 'configured defaultShell',
      dcCommandRestriction: allowed ? 'not_blocked_by_dc_config' : 'DC_COMMAND_FORBIDDEN',
    };
  }

  const preconditions = mechanics.supportedPreconditions.map((name) => ({ name, supplied: normalized[name] !== undefined }));
  return {
    schema: 'dc.operation-preview.v1',
    tool,
    mechanically_valid: problems.length === 0,
    authorization: 'external' as const,
    problems,
    normalizedArguments: normalized,
    normalizedArgumentsHash: normalizedArgumentsHash(raw),
    mutation: mechanics.mutating,
    riskClass: mechanics.riskClass,
    category: mechanics.category,
    usesShell: mechanics.shellExecution,
    cwd,
    paths,
    command,
    preconditions,
    notice: 'Mechanical preview only; no execution occurred and no authorization decision was made.',
    filesystemScope: mechanics.filesystemScope,
  };
}
