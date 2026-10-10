/**
 * Jace Commander local policy (ADR 0026, slice 3).
 *
 * Trust model (D3): the model must not be able to widen its own authority.
 *  - The SYSTEM policy may loosen anything above the built-in defaults only if
 *    the JC process cannot modify it: the file and every parent directory are
 *    not symlinks, not group/world-writable, and access(W_OK) FAILS for this
 *    process's effective uid (so a root-run JC is also rejected).
 *  - The optional USER policy (<stateDir>/policy.user.json) may only TIGHTEN.
 *    Anything that loosens is rejected, so a model that can write the state
 *    directory still cannot gain authority.
 *  - A configured policy that is missing, unreadable, malformed or mutable
 *    yields state `invalid`: the server then denies everything except
 *    jc.meta (so an operator can still run jc_doctor). Defaults are used only
 *    when NO policy was ever configured.
 *  - The effective policy has a canonical SHA-256 recorded in every trace
 *    record. It is loaded once at startup, never re-read per call.
 *
 * Constraints (fs roots, command patterns, git remotes) are guardrails; an
 * allowed interpreter still runs arbitrary code. They are not a sandbox.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  JC_CLASS_DECISION_VALUES,
  JC_DEFAULT_CLASS_DECISIONS,
  createAuthorizerResolver,
  validateAuthorizerTable,
  type JcAuthorizerTable,
  type JcClassDecision,
  type JcClassDecisions,
} from './authorizers.js';
import { canonical } from './looptrace.js';
import { JC_ACS_MODES, JC_PROVIDER_IDS, JC_RISK_CLASSES, isJcProviderId, jcProviderOf, type JcAcsMode, type JcProviderId, type JcRiskClass } from './providers.js';

export const JC_POLICY_VERSION = 'jc.policy.v1' as const;
export const DEFAULT_SYSTEM_POLICY_PATH = '/etc/jace-commander/policy.json';
const MAX_POLICY_BYTES = 256 * 1024;
const POLICY_HASH_DOMAIN = 'jc.policy.v1';

export interface JcEffectivePolicy {
  /** Undefined means "uniform local" (the `local` preset's own table). */
  authorizerTable: JcAuthorizerTable | undefined;
  classDecisions: JcClassDecisions;
  /** Undefined: use the configured JC_FS_ROOTS. */
  fsRoots: string[] | undefined;
  fsDeniedRoots: string[];
  /** Undefined: any executable not denied. */
  allowCommands: string[] | undefined;
  denyCommands: string[];
  /** Undefined: any configured remote. */
  gitRemotes: string[] | undefined;
  /** Per-provider ACS relationship. Defaults: `acs` optional, providers routed to ACS required, others off. */
  acsModes: Readonly<Record<JcProviderId, JcAcsMode>>;
}

export type JcPolicyState = 'builtin-default' | 'loaded' | 'invalid';

export interface JcPolicyLoad {
  state: JcPolicyState;
  effective: JcEffectivePolicy;
  hash: string;
  sources: string[];
  /** The system policy passed the cannot-modify-it check (or none was loaded). */
  immutable: boolean;
  unsafeDev: boolean;
  errors: string[];
}

export interface JcPolicyOptions {
  systemPath: string;
  /** True when the operator named the path (JC_POLICY_PATH): a missing file is then invalid, not "no policy". */
  systemPathExplicit: boolean;
  userPath: string;
  unsafeDev?: boolean;
  /** Tests only: skip the cannot-modify-it check. Production always checks. */
  requireImmutable?: boolean;
  /** Roots from JC_FS_ROOTS, the base a user layer may narrow when the system layer sets none. */
  baseFsRoots?: readonly string[];
}

class PolicyError extends Error {}

const DECISION_RANK: Readonly<Record<JcClassDecision, number>> = Object.freeze({ deny: 0, approve: 1, allow: 2 });

export function builtinDefaultPolicy(): JcEffectivePolicy {
  return {
    authorizerTable: undefined,
    classDecisions: JC_DEFAULT_CLASS_DECISIONS,
    fsRoots: undefined,
    fsDeniedRoots: [],
    allowCommands: undefined,
    denyCommands: [],
    gitRemotes: undefined,
    acsModes: defaultAcsModes(undefined),
  };
}

/** `acs` is optional; a provider whose tools are routed to ACS authorizers needs ACS (required); the rest are off. */
export function defaultAcsModes(table: JcAuthorizerTable | undefined): Readonly<Record<JcProviderId, JcAcsMode>> {
  const routed = new Set<JcProviderId>();
  if (table) {
    for (const route of createAuthorizerResolver('local', table).routes()) {
      if (route.authorizer === 'acs-capability' || route.authorizer === 'admin-delegated') routed.add(route.provider);
    }
  }
  return Object.freeze(Object.fromEntries(JC_PROVIDER_IDS.map((id) => [id, id === 'acs' ? 'optional' : routed.has(id) ? 'required' : 'off'])) as Record<JcProviderId, JcAcsMode>);
}

export function hashEffectivePolicy(effective: JcEffectivePolicy): string {
  const body = canonical({
    authorizerTable: effective.authorizerTable ?? null,
    classDecisions: effective.classDecisions,
    fsRoots: effective.fsRoots ?? null,
    fsDeniedRoots: [...effective.fsDeniedRoots].sort(),
    allowCommands: effective.allowCommands ? [...effective.allowCommands].sort() : null,
    denyCommands: [...effective.denyCommands].sort(),
    gitRemotes: effective.gitRemotes ? [...effective.gitRemotes].sort() : null,
    acsModes: effective.acsModes,
  });
  return crypto.createHash('sha256').update(`${POLICY_HASH_DOMAIN}\n${body}`, 'utf8').digest('hex');
}

interface ParsedDocument {
  authorizers?: unknown;
  classes?: Partial<Record<JcRiskClass, JcClassDecision>>;
  fsRoots?: string[];
  fsDeniedRoots?: string[];
  allowCommands?: string[];
  denyCommands?: string[];
  gitRemotes?: string[];
  acs?: { default?: JcAcsMode; providers: Partial<Record<JcProviderId, JcAcsMode>> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireKeys(label: string, record: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new PolicyError(`${label}: unknown key ${key}`);
}

function stringList(label: string, value: unknown, check: (entry: string) => void): string[] {
  if (!Array.isArray(value) || value.length > 256) throw new PolicyError(`${label} must be an array of at most 256 strings`);
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 4096 || entry.includes('\0')) throw new PolicyError(`${label}: invalid entry`);
    check(entry);
    return entry;
  });
}

const requireAbsolute = (label: string) => (entry: string) => {
  if (!path.isAbsolute(entry) || path.normalize(entry) !== entry.replace(/(.)\/$/, '$1')) throw new PolicyError(`${label}: ${entry} must be a normalized absolute path`);
};
const requireCommand = (entry: string) => {
  if (entry.includes('/') && (!path.isAbsolute(entry) || path.normalize(entry) !== entry)) throw new PolicyError(`command ${entry} must be a bare name or a normalized absolute path`);
};
const requireRemote = (entry: string) => {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(entry)) throw new PolicyError(`remote ${entry} is not a valid remote name`);
};

function parseDocument(raw: string, layer: 'system' | 'user'): ParsedDocument {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new PolicyError(`${layer} policy is not valid JSON`);
  }
  if (!isRecord(json)) throw new PolicyError(`${layer} policy must be an object`);
  requireKeys('policy', json, ['version', 'authorizers', 'classes', 'constraints', 'acs']);
  if (json.version !== JC_POLICY_VERSION) throw new PolicyError(`policy.version must be ${JC_POLICY_VERSION}`);
  const out: ParsedDocument = {};
  if (json.authorizers !== undefined) {
    if (layer === 'user') throw new PolicyError('the user policy may not set authorizers');
    out.authorizers = validateAuthorizerTable(json.authorizers);
  }
  if (json.classes !== undefined) {
    if (!isRecord(json.classes)) throw new PolicyError('policy.classes must be an object');
    requireKeys('classes', json.classes, JC_RISK_CLASSES);
    out.classes = {};
    for (const [cls, decision] of Object.entries(json.classes)) {
      if (!(JC_CLASS_DECISION_VALUES as readonly unknown[]).includes(decision)) throw new PolicyError(`classes.${cls}: must be allow, approve or deny`);
      out.classes[cls as JcRiskClass] = decision as JcClassDecision;
    }
  }
  if (json.acs !== undefined) {
    if (layer === 'user') throw new PolicyError('the user policy may not set acs modes');
    if (!isRecord(json.acs)) throw new PolicyError('policy.acs must be an object');
    requireKeys('acs', json.acs, ['default', 'providers']);
    const modes = JC_ACS_MODES as readonly unknown[];
    const parsed: NonNullable<ParsedDocument['acs']> = { providers: {} };
    if (json.acs.default !== undefined) {
      if (!modes.includes(json.acs.default)) throw new PolicyError('acs.default must be off, optional or required');
      parsed.default = json.acs.default as JcAcsMode;
    }
    if (json.acs.providers !== undefined) {
      if (!isRecord(json.acs.providers)) throw new PolicyError('acs.providers must be an object');
      for (const [id, mode] of Object.entries(json.acs.providers)) {
        if (!isJcProviderId(id)) throw new PolicyError(`acs.providers: unknown provider ${id}`);
        if (!modes.includes(mode)) throw new PolicyError(`acs.providers.${id}: must be off, optional or required`);
        parsed.providers[id] = mode as JcAcsMode;
      }
    }
    out.acs = parsed;
  }
  if (json.constraints !== undefined) {
    if (!isRecord(json.constraints)) throw new PolicyError('policy.constraints must be an object');
    requireKeys('constraints', json.constraints, ['fs', 'exec', 'git']);
    const { fs: fsC, exec, git } = json.constraints;
    if (fsC !== undefined) {
      if (!isRecord(fsC)) throw new PolicyError('constraints.fs must be an object');
      requireKeys('constraints.fs', fsC, ['roots', 'deniedRoots']);
      if (fsC.roots !== undefined) out.fsRoots = stringList('constraints.fs.roots', fsC.roots, requireAbsolute('fs.roots')).map((entry) => path.resolve(entry));
      if (fsC.deniedRoots !== undefined) out.fsDeniedRoots = stringList('constraints.fs.deniedRoots', fsC.deniedRoots, requireAbsolute('fs.deniedRoots')).map((entry) => path.resolve(entry));
    }
    if (exec !== undefined) {
      if (!isRecord(exec)) throw new PolicyError('constraints.exec must be an object');
      requireKeys('constraints.exec', exec, ['allowCommands', 'denyCommands']);
      if (exec.allowCommands !== undefined) out.allowCommands = stringList('constraints.exec.allowCommands', exec.allowCommands, requireCommand);
      if (exec.denyCommands !== undefined) out.denyCommands = stringList('constraints.exec.denyCommands', exec.denyCommands, requireCommand);
    }
    if (git !== undefined) {
      if (!isRecord(git)) throw new PolicyError('constraints.git must be an object');
      requireKeys('constraints.git', git, ['remotes']);
      if (git.remotes !== undefined) out.gitRemotes = stringList('constraints.git.remotes', git.remotes, requireRemote);
    }
  }
  return out;
}

/**
 * Canonical path, failing closed. A root that does not exist yet is resolved through its deepest
 * existing ancestor (so a symlink anywhere in the chain is followed); any other error rejects.
 */
function canonicalRoot(root: string): string {
  const rest: string[] = [];
  let current = path.resolve(root);
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...rest);
    } catch (error) {
      const parent = path.dirname(current);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === current) {
        throw new PolicyError(`fs root ${root} cannot be resolved to a canonical path`);
      }
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * Throws unless nothing in the file's path chain can be modified by this
 * process. Uses lstat + mode bits + access(W_OK) for the effective uid.
 */
export function assertPolicyImmutable(filePath: string): void {
  let current = path.resolve(filePath);
  for (;;) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new PolicyError(`${current} is a symlink`);
    // An owner can always chmod the path writable again, so a read-only mode on a path the
    // JC account owns proves nothing. Every component must belong to someone else.
    const me = process.geteuid?.();
    if (me !== undefined && me !== 0 && stat.uid === me) throw new PolicyError(`${current} is owned by the JC account (uid ${me}); it could make it writable again`);
    if ((stat.mode & 0o022) !== 0) throw new PolicyError(`${current} is group/world-writable`);
    try {
      fs.accessSync(current, fs.constants.W_OK);
      throw new PolicyError(`${current} is writable by the JC process (uid ${process.geteuid?.() ?? '?'}); a policy the process can edit cannot loosen anything`);
    } catch (error) {
      if (error instanceof PolicyError) throw error;
      // EACCES / EROFS: not writable by us, which is what we require.
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function readPolicyFile(file: string): string {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new PolicyError(`${file} is not a regular file`);
  if (stat.size > MAX_POLICY_BYTES) throw new PolicyError(`${file} exceeds ${MAX_POLICY_BYTES} bytes`);
  return fs.readFileSync(file, 'utf8');
}

function applySystem(doc: ParsedDocument): JcEffectivePolicy {
  const decisions: Record<JcRiskClass, JcClassDecision> = { ...JC_DEFAULT_CLASS_DECISIONS };
  for (const [cls, decision] of Object.entries(doc.classes ?? {})) decisions[cls as JcRiskClass] = decision;
  if (decisions.privileged === 'allow') throw new PolicyError('classes.privileged may not be allow');
  const table = doc.authorizers as JcAuthorizerTable | undefined;
  const derived = defaultAcsModes(table);
  const acsModes: Record<JcProviderId, JcAcsMode> = { ...derived };
  if (doc.acs?.default !== undefined) for (const id of JC_PROVIDER_IDS) acsModes[id] = doc.acs.default;
  for (const [id, mode] of Object.entries(doc.acs?.providers ?? {})) acsModes[id as JcProviderId] = mode;
  // A provider with ACS switched off cannot also be authorized by ACS.
  for (const route of createAuthorizerResolver('local', table ?? validateAuthorizerTable({ default: 'local' })).routes()) {
    if ((route.authorizer === 'acs-capability' || route.authorizer === 'admin-delegated') && acsModes[route.provider] === 'off') {
      throw new PolicyError(`${route.tool} is routed to ${route.authorizer} but acs is off for ${route.provider}`);
    }
  }
  return {
    authorizerTable: doc.authorizers as JcAuthorizerTable | undefined,
    classDecisions: Object.freeze(decisions),
    fsRoots: doc.fsRoots,
    fsDeniedRoots: doc.fsDeniedRoots ?? [],
    allowCommands: doc.allowCommands,
    denyCommands: doc.denyCommands ?? [],
    gitRemotes: doc.gitRemotes,
    acsModes: Object.freeze(acsModes),
  };
}

/** The user layer may only tighten; any loosening throws. */
function applyUser(base: JcEffectivePolicy, doc: ParsedDocument, baseFsRoots: readonly string[]): JcEffectivePolicy {
  const decisions: Record<JcRiskClass, JcClassDecision> = { ...base.classDecisions };
  for (const [cls, decision] of Object.entries(doc.classes ?? {})) {
    const key = cls as JcRiskClass;
    if (DECISION_RANK[decision] > DECISION_RANK[base.classDecisions[key]]) {
      throw new PolicyError(`user policy loosens classes.${cls} from ${base.classDecisions[key]} to ${decision}`);
    }
    decisions[key] = decision;
  }
  let fsRoots = base.fsRoots;
  if (doc.fsRoots) {
    const limit = (base.fsRoots ?? [...baseFsRoots]).map(canonicalRoot);
    // Compare (and keep) canonical paths: a symlink under an allowed root must not widen it.
    const resolved = doc.fsRoots.map(canonicalRoot);
    for (const [index, root] of resolved.entries()) {
      if (!limit.some((allowed) => inside(allowed, root))) throw new PolicyError(`user policy fs root ${doc.fsRoots[index]} is outside the permitted roots`);
    }
    fsRoots = resolved;
  }
  let allowCommands = base.allowCommands;
  if (doc.allowCommands) {
    if (base.allowCommands && !doc.allowCommands.every((entry) => base.allowCommands!.includes(entry))) {
      throw new PolicyError('user policy allowCommands adds a command the system policy does not allow');
    }
    allowCommands = doc.allowCommands;
  }
  let gitRemotes = base.gitRemotes;
  if (doc.gitRemotes) {
    if (base.gitRemotes && !doc.gitRemotes.every((entry) => base.gitRemotes!.includes(entry))) {
      throw new PolicyError('user policy git remotes add a remote the system policy does not allow');
    }
    gitRemotes = doc.gitRemotes;
  }
  return {
    ...base,
    classDecisions: Object.freeze(decisions),
    fsRoots,
    fsDeniedRoots: [...new Set([...base.fsDeniedRoots, ...(doc.fsDeniedRoots ?? [])])],
    allowCommands,
    denyCommands: [...new Set([...base.denyCommands, ...(doc.denyCommands ?? [])])],
    gitRemotes,
  };
}

function invalid(errors: string[], unsafeDev: boolean): JcPolicyLoad {
  const effective = builtinDefaultPolicy();
  return { state: 'invalid', effective, hash: hashEffectivePolicy(effective), sources: [], immutable: false, unsafeDev, errors };
}

/** Loads the effective policy. Never throws: a bad policy is `state: 'invalid'`. */
export function loadJcPolicy(options: JcPolicyOptions): JcPolicyLoad {
  const unsafeDev = options.unsafeDev === true;
  const requireImmutable = options.requireImmutable !== false;
  const sources: string[] = [];
  let effective = builtinDefaultPolicy();
  let immutable = true;
  let anyConfigured = false;
  try {
    let raw: string | undefined;
    try {
      raw = readPolicyFile(options.systemPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' && !options.systemPathExplicit) raw = undefined;
      else if (code === 'ENOENT') throw new PolicyError(`configured policy ${options.systemPath} does not exist`);
      else if (error instanceof PolicyError) throw error;
      else throw new PolicyError(`policy ${options.systemPath} is unreadable`);
    }
    if (raw !== undefined) {
      anyConfigured = true;
      const doc = parseDocument(raw, 'system');
      if (requireImmutable && !unsafeDev) {
        try {
          assertPolicyImmutable(options.systemPath);
        } catch (error) {
          immutable = false;
          throw error;
        }
      } else if (requireImmutable && unsafeDev) {
        try {
          assertPolicyImmutable(options.systemPath);
        } catch {
          immutable = false; // accepted only because JC_POLICY_UNSAFE_DEV is set; surfaced everywhere
        }
      }
      effective = applySystem(doc);
      sources.push(options.systemPath);
    }
    let userRaw: string | undefined;
    try {
      userRaw = readPolicyFile(options.userPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error instanceof PolicyError ? error : new PolicyError(`user policy ${options.userPath} is unreadable`);
    }
    if (userRaw !== undefined) {
      anyConfigured = true;
      effective = applyUser(effective, parseDocument(userRaw, 'user'), options.baseFsRoots ?? []);
      sources.push(options.userPath);
    }
  } catch (error) {
    return invalid([error instanceof PolicyError ? error.message : 'policy could not be loaded'], unsafeDev);
  }
  return {
    state: anyConfigured ? 'loaded' : 'builtin-default',
    effective,
    hash: hashEffectivePolicy(effective),
    sources,
    immutable,
    unsafeDev,
    errors: [],
  };
}

/** Constraint check for one call. Returns a refusal reason, or undefined when permitted. */
export function checkPolicyConstraints(effective: JcEffectivePolicy, tool: string, args: Record<string, unknown>): string | undefined {
  if (tool === 'start_process') {
    const argv = Array.isArray(args.argv) ? args.argv : [];
    const executable = typeof argv[0] === 'string' ? argv[0] : '';
    const base = path.basename(executable);
    const matches = (entry: string) => (entry.includes('/') ? entry === executable : entry === base);
    if (effective.denyCommands.some(matches)) return `command ${base || executable} is denied by policy`;
    if (effective.allowCommands && !effective.allowCommands.some(matches)) return `command ${base || executable} is not in the policy allowlist`;
  }
  if (tool === 'git_fetch' || tool === 'git_push') {
    const remote = typeof args.remote === 'string' ? args.remote : 'origin';
    if (effective.gitRemotes && !effective.gitRemotes.includes(remote)) return `remote ${remote} is not in the policy allowlist`;
  }
  return undefined;
}
