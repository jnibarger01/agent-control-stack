/** Standalone policy loader. Never fall back to permissive execution.
 * Configuration is read-only at runtime. Operator policy must be root-controlled
 * for host mutation/exec. Symlinks and user-controlled ancestor directories fail.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { JC_MANIFEST } from './manifest.generated.js';
import { JC_PROVIDER_IDS } from './providers.js';
import type { JcAuthorizer, JcAuthorizerOverrides } from './authorizers.js';

export type JcRiskClass = 'read' | 'mutate' | 'exec' | 'network' | 'privileged';
export type JcPolicyDecision = 'allow' | 'approve';
export interface JcLocalPolicy {
  version: 'jc.policy.v1';
  classes: Record<JcRiskClass, JcPolicyDecision>;
  roots: string[];
  deniedRoots: string[];
  authorizers: JcAuthorizerOverrides;
}
const CLASSES = ['read', 'mutate', 'exec', 'network', 'privileged'] as const;
const AUTHORIZERS = ['local', 'acs-capability', 'admin-delegated'] as const;
export const JC_DEFAULT_CLASS_POLICY: Readonly<Record<JcRiskClass, JcPolicyDecision>> = Object.freeze({
  read: 'allow', mutate: 'approve', exec: 'approve', network: 'approve', privileged: 'approve',
});
export const JC_POLICY_FILE_DEFAULT = '/etc/jace-commander/local-policy.json';

function object(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}
function keys(v: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(v)) if (!allowed.includes(key)) throw new Error('JC_POLICY_INVALID');
}
function paths(v: unknown): string[] {
  if (!Array.isArray(v) || !v.every(x => typeof x === 'string' && path.isAbsolute(x) && path.normalize(x) === x))
    throw new Error('JC_POLICY_INVALID');
  return [...new Set(v)];
}
export function parseJcLocalPolicy(input: unknown): JcLocalPolicy {
  if (!object(input)) throw new Error('JC_POLICY_INVALID');
  keys(input, ['version', 'classes', 'roots', 'deniedRoots', 'authorizers']);
  if (input.version !== 'jc.policy.v1' || !object(input.classes) || !object(input.authorizers)) throw new Error('JC_POLICY_INVALID');
  keys(input.classes, CLASSES);
  const classes = { ...JC_DEFAULT_CLASS_POLICY };
  for (const risk of CLASSES) {
    const v = input.classes[risk];
    if (v !== undefined && v !== 'allow' && v !== 'approve') throw new Error('JC_POLICY_INVALID');
    if (v) classes[risk] = v;
  }
  if (classes.privileged !== 'approve') throw new Error('JC_POLICY_PRIVILEGED_REQUIRES_APPROVAL');
  const roots = paths(input.roots);
  const deniedRoots = paths(input.deniedRoots);
  const raw = input.authorizers;
  keys(raw, ['perTool', 'perProvider', 'defaultAuthorizer']);
  const perTool: Record<string, JcAuthorizer> = {};
  if (raw.perTool !== undefined) {
    if (!object(raw.perTool)) throw new Error('JC_POLICY_INVALID');
    const known = new Set(JC_MANIFEST.tools.map(t => t.name));
    for (const [name, value] of Object.entries(raw.perTool)) {
      if (!known.has(name) || !AUTHORIZERS.includes(value as JcAuthorizer)) throw new Error('JC_POLICY_INVALID');
      perTool[name] = value as JcAuthorizer;
    }
  }
  const perProvider: Record<string, JcAuthorizer> = {};
  if (raw.perProvider !== undefined) {
    if (!object(raw.perProvider)) throw new Error('JC_POLICY_INVALID');
    for (const [name, value] of Object.entries(raw.perProvider)) {
      if (!JC_PROVIDER_IDS.includes(name as typeof JC_PROVIDER_IDS[number]) || !AUTHORIZERS.includes(value as JcAuthorizer))
        throw new Error('JC_POLICY_INVALID');
      perProvider[name] = value as JcAuthorizer;
    }
  }
  if (raw.defaultAuthorizer !== undefined && !['local', 'acs-capability'].includes(raw.defaultAuthorizer as string))
    throw new Error('JC_POLICY_INVALID');
  return {
    version: 'jc.policy.v1', classes, roots, deniedRoots,
    authorizers: {
      perTool, perProvider,
      ...(raw.defaultAuthorizer ? { defaultAuthorizer: raw.defaultAuthorizer as 'local' | 'acs-capability' } : {}),
    },
  };
}
/** Checks every component including file, forbidding symlinks and non-root ownership.
 * Fail-closed on platforms unable to expose POSIX uid/mode. */
export function loadRootControlledJcPolicy(filename = JC_POLICY_FILE_DEFAULT): { policy: JcLocalPolicy; hash: string } {
  if (!path.isAbsolute(filename)) throw new Error('JC_POLICY_INVALID');
  let part = path.parse(filename).root;
  for (const segment of filename.slice(part.length).split(path.sep).filter(Boolean)) {
    part = path.join(part, segment);
    const stat = fs.lstatSync(part);
    if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new Error('JC_POLICY_UNTRUSTED_PATH');
  }
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size > 65536)
      throw new Error('JC_POLICY_UNTRUSTED_FILE');
    const contents = fs.readFileSync(fd, 'utf8');
    const policy = parseJcLocalPolicy(JSON.parse(contents));
    return { policy, hash: crypto.createHash('sha256').update(contents).digest('hex') };
  } finally { fs.closeSync(fd); }
}
export function riskClassForJcTool(toolName: string): JcRiskClass {
  const tool = JC_MANIFEST.tools.find(x => x.name === toolName);
  if (!tool) throw new Error('JC_POLICY_UNKNOWN_TOOL');
  if (tool.scopes.includes('process.privileged')) return 'privileged';
  if (tool.scopes.some(x => x === 'git.network' || x === 'integration.write')) return 'network';
  if (tool.scopes.includes('process.exec')) return 'exec';
  if (tool.scopes.some(x => x.endsWith('.write'))) return 'mutate';
  if (tool.scopes.every(x => x.endsWith('.read'))) return 'read';
  throw new Error('JC_POLICY_UNKNOWN_CLASS');
}
