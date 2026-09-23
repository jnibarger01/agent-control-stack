import type { ZodTypeAny, infer as ZodInfer } from 'zod';
import type { ServerResult } from '../types.js';
import {
  ApplyPatchArgsSchema,
  CapabilityManifestArgsSchema,
  GitStateArgsSchema,
  HealthArgsSchema,
  LastErrorArgsSchema,
  OperationPreviewArgsSchema,
  RestoreSnapshotArgsSchema,
  RunCommandArgsSchema,
  SecretScanArgsSchema,
  ServiceStatusArgsSchema,
  SnapshotPathArgsSchema,
  TerminateProcessArgsSchema,
  VerifyHeadArgsSchema,
  WaitForProcessArgsSchema,
  toolArgSchemas,
} from '../tools/schemas.js';
import { DcToolError } from '../execution/errors.js';
import { errorResult, runTool } from '../execution/tool-result.js';
import { collectHealth } from '../execution/health.js';
import { lastErrors } from '../execution/last-error.js';
import { runCommand } from '../execution/run-command.js';
import { terminateOwnedProcess, waitForProcess } from '../execution/process-control.js';
import { applyPatch } from '../execution/apply-patch.js';
import { gitState, verifyHead } from '../execution/git.js';
import { restoreSnapshot, snapshotPath } from '../execution/snapshot.js';
import { capabilityManifest } from '../execution/capability-manifest.js';
import { operationPreview } from '../execution/operation-preview.js';
import { secretScan } from '../execution/secret-scan-tool.js';
import { serviceStatus } from '../execution/service-status.js';
import { configManager } from '../config-manager.js';
import { getRuntimeIdentityState } from '../runtime-identity.js';
import { terminalManager } from '../terminal-manager.js';
import { searchManager } from '../search-manager.js';
import { getRipgrepPath } from '../utils/ripgrep-resolver.js';
import { desktopCommanderExecutionMode, managedAcsIdentityStatus } from '../managed-acs-runtime.js';

function parse<S extends ZodTypeAny>(schema: S, args: unknown): ZodInfer<S> {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    throw new DcToolError('DC_INVALID_ARGUMENT', parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; '), { stage: 'validate' });
  }
  return parsed.data;
}

function withArgs<S extends ZodTypeAny>(schema: S, fn: (args: ZodInfer<S>) => Promise<unknown>) {
  return (args: unknown): Promise<ServerResult> => runTool(async () => fn(parse(schema, args)));
}

export const handleHealth = withArgs(HealthArgsSchema, async () => collectHealth({
  getConfig: async () => (await configManager.getConfig()) as Record<string, unknown>,
  runtimeIdentity: async () => getRuntimeIdentityState(),
  processManager: async () => ({ active: terminalManager.listActiveSessions().length, completed: terminalManager.listCompletedSessions().length }),
  searchEngine: async () => ({ ripgrepPath: await getRipgrepPath(), activeSearches: searchManager.getActiveSessionCount() }),
  managedTransport: async () => ({ mode: desktopCommanderExecutionMode(), identity: await managedAcsIdentityStatus() }),
}));

export const handleLastError = withArgs(LastErrorArgsSchema, async (args) => {
  const records = lastErrors({ limit: args.limit ?? 1, tool: args.tool, requestId: args.requestId, correlationId: args.correlationId });
  return {
    schema: 'dc.last-error.v1',
    count: records.length,
    errors: records,
    notice: 'Sanitized diagnostics: secrets redacted, arguments reported only as normalized hashes, no stack traces.',
  };
});

export const handleRunCommand = withArgs(RunCommandArgsSchema, (args) => runCommand(args));
export const handleWaitForProcess = withArgs(WaitForProcessArgsSchema, (args) => waitForProcess(args));
export const handleTerminateProcess = withArgs(TerminateProcessArgsSchema, (args) => terminateOwnedProcess(args));
export const handleApplyPatch = withArgs(ApplyPatchArgsSchema, (args) => applyPatch(args));
export const handleGitState = withArgs(GitStateArgsSchema, (args) => gitState(args.repoPath));

export const handleVerifyHead = withArgs(VerifyHeadArgsSchema, async (args) => {
  const result = await verifyHead(args.repoPath, args.expectedSha);
  // A mismatch is an explicit, successful answer (not a tool failure).
  return { ...result, ...(result.match ? {} : { code: 'DC_HEAD_MISMATCH' }) };
});

export const handleSnapshotPath = withArgs(SnapshotPathArgsSchema, (args) => snapshotPath(args));
export const handleRestoreSnapshot = withArgs(RestoreSnapshotArgsSchema, (args) => restoreSnapshot(args));

export const handleCapabilityManifest = withArgs(CapabilityManifestArgsSchema, async (args) => {
  if (args.tool && !toolArgSchemas[args.tool]) throw new DcToolError('DC_INVALID_ARGUMENT', `unknown tool: ${args.tool}`, { stage: 'validate' });
  return capabilityManifest(Object.keys(toolArgSchemas), args.tool);
});

export const handleOperationPreview = withArgs(OperationPreviewArgsSchema, (args) => operationPreview({ tool: args.tool, arguments: args.arguments }));
export const handleSecretScan = withArgs(SecretScanArgsSchema, (args) => secretScan(args));
export const handleServiceStatus = withArgs(ServiceStatusArgsSchema, (args) => serviceStatus(args));

export { errorResult };
