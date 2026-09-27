import { execFileSync } from 'node:child_process';
import { TOOL_MECHANICS, type ToolMechanics } from './tool-catalog.js';
import { listManagedToolDispositions } from '../managed-acs.js';
import { desktopCommanderExecutionMode } from '../managed-acs-runtime.js';

/**
 * capability_manifest: machine-readable MECHANICAL capability description.
 *
 * Desktop Commander mechanical capability does not imply caller
 * authorization. `mechanicallyAvailable` means this runtime can execute the
 * tool (it is registered, served in the current execution mode, and its
 * dependencies are present). Whether a given caller may execute it is decided
 * externally by ACS; this manifest never reports "authorized".
 */
export interface ToolCapability {
  tool: string;
  category: string;
  riskClass: ToolMechanics['riskClass'];
  mutating: boolean;
  mechanicallyAvailable: boolean;
  availabilityReason: string;
  supportedPreconditions: readonly string[];
  requiresCwd: boolean;
  filesystemScope: ToolMechanics['filesystemScope'];
  processScope: ToolMechanics['processScope'] | null;
  shellExecution: boolean;
  emitsExecutionEvidence: true;
  authorization: 'external';
  managedDisposition: 'capability' | 'unsupported' | 'none';
  legacy: string | null;
}

let gitAvailable: boolean | undefined;
function hasGit(): boolean {
  if (gitAvailable === undefined) {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore', timeout: 3_000 });
      gitAvailable = true;
    } catch {
      gitAvailable = false;
    }
  }
  return gitAvailable;
}

export function capabilityManifest(registeredTools: readonly string[], filter?: string) {
  const mode = desktopCommanderExecutionMode();
  const dispositions = listManagedToolDispositions();
  const tools: ToolCapability[] = [];
  for (const tool of [...registeredTools].sort()) {
    if (filter && tool !== filter) continue;
    const m = TOOL_MECHANICS[tool];
    if (!m) continue;
    const disposition = dispositions[tool]?.managed ?? 'none';
    let available = true;
    let reason = 'registered and served';
    if (mode === 'managed' && disposition !== 'capability') {
      available = false;
      reason = 'not served in managed mode (no ACS capability disposition)';
    } else if (m.category === 'git' && !hasGit()) {
      available = false;
      reason = 'git executable not found';
    }
    tools.push({
      tool,
      category: m.category,
      riskClass: m.riskClass,
      mutating: m.mutating,
      mechanicallyAvailable: available,
      availabilityReason: reason,
      supportedPreconditions: m.supportedPreconditions,
      requiresCwd: m.requiresCwd,
      filesystemScope: m.filesystemScope,
      processScope: m.processScope ?? null,
      shellExecution: m.shellExecution,
      emitsExecutionEvidence: true,
      authorization: 'external',
      managedDisposition: disposition,
      legacy: m.legacy ?? null,
    });
  }
  return {
    schema: 'dc.capability-manifest.v1',
    executionMode: mode,
    notice: 'Mechanical capability only. Desktop Commander mechanical capability does not imply caller authorization; ACS decides.',
    tools,
  };
}
