/**
 * Jace Commander authorizer resolution (ADR 0026, slice 2).
 *
 * For each call the effective authorizer is the first match of
 *   per-tool override -> provider -> server default.
 *
 *   local            JC decides itself from the class decision (allow/approve/deny).
 *   acs-capability   today's managed behavior: a signed acs.jc.v1 capability.
 *   admin-delegated  an ACS capability as well, opt-in per tool or provider,
 *                    never a global override, never degraded to `local`.
 *
 * `refused` is an internal result used only by the `standalone` preset for
 * tools it has never served; it is not a value an operator can configure.
 *
 * Presets are the only way to obtain a table without a policy file:
 *   managed     every tool acs-capability (default, identical to before)
 *   standalone  the 24 read-only tools local; the other 12 refused (identical)
 *   local       every provider local (new); decisions come from class policy
 */
import { JC_TOOL_POLICIES } from './contract.js';
import {
  JC_PROVIDERS,
  isJcProviderId,
  jcProviderOf,
  jcRiskClassOf,
  type JcProviderId,
  type JcRiskClass,
} from './providers.js';

export const JC_AUTHORIZER_IDS = Object.freeze(['local', 'acs-capability', 'admin-delegated'] as const);
export type JcAuthorizerId = typeof JC_AUTHORIZER_IDS[number];
export type JcResolvedAuthorizer = JcAuthorizerId | 'refused';

export const JC_PRESETS = Object.freeze(['managed', 'standalone', 'local'] as const);
export type JcPreset = typeof JC_PRESETS[number];

export interface JcAuthorizerTable {
  default: JcAuthorizerId;
  providers: Readonly<Partial<Record<JcProviderId, JcAuthorizerId>>>;
  tools: Readonly<Record<string, JcAuthorizerId>>;
}

export type JcRouteSource = 'tool' | 'provider' | 'default' | 'preset';

export interface JcRoute {
  tool: string;
  provider: JcProviderId;
  riskClass: JcRiskClass;
  authorizer: JcResolvedAuthorizer;
  source: JcRouteSource;
}

export type JcClassDecision = 'allow' | 'approve' | 'deny';
export type JcClassDecisions = Readonly<Record<JcRiskClass, JcClassDecision>>;

export const JC_CLASS_DECISION_VALUES = Object.freeze(['allow', 'approve', 'deny'] as const);

/** Built-in defaults for the `local` authorizer (ADR 0026 D2). */
export const JC_DEFAULT_CLASS_DECISIONS: JcClassDecisions = Object.freeze({
  read: 'allow',
  mutate: 'approve',
  exec: 'approve',
  network: 'approve',
  privileged: 'approve',
});

export class JcConfigError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'JcConfigError';
  }
}

export function isJcAuthorizerId(value: unknown): value is JcAuthorizerId {
  return typeof value === 'string' && (JC_AUTHORIZER_IDS as readonly string[]).includes(value);
}

export function isJcPreset(value: unknown): value is JcPreset {
  return typeof value === 'string' && (JC_PRESETS as readonly string[]).includes(value);
}

/**
 * Whether `name` may be served by the `standalone` preset (no ACS capability,
 * no approval). Fail closed: unknown tools, approval-gated tools, and any tool
 * with a non-read scope are refused.
 */
export function jcStandaloneToolAllowed(name: string): boolean {
  const policy = Object.prototype.hasOwnProperty.call(JC_TOOL_POLICIES, name) ? JC_TOOL_POLICIES[name] : undefined;
  if (!policy || policy.requiresApproval || policy.scopes.length === 0) return false;
  return policy.scopes.every((scope) => scope.endsWith('.read'));
}

function uniformTable(authorizer: JcAuthorizerId): JcAuthorizerTable {
  return Object.freeze({ default: authorizer, providers: Object.freeze({}), tools: Object.freeze({}) });
}

/** Validates an operator-supplied table. Unknown keys are errors, never ignored. */
export function validateAuthorizerTable(raw: unknown): JcAuthorizerTable {
  const fail = (message: string): never => {
    throw new JcConfigError('JC_POLICY_INVALID', `authorizer table: ${message}`);
  };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail('must be an object');
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!['default', 'providers', 'tools'].includes(key)) fail(`unknown key ${key}`);
  }
  if (!isJcAuthorizerId(record.default)) fail(`default must be one of ${JC_AUTHORIZER_IDS.join(', ')}`);
  // A global admin-delegated default would convert every tool at once: opt-in only.
  if (record.default === 'admin-delegated') fail('admin-delegated may not be the server default; opt in per provider or tool');
  const providers: Partial<Record<JcProviderId, JcAuthorizerId>> = {};
  if (record.providers !== undefined) {
    if (record.providers === null || typeof record.providers !== 'object' || Array.isArray(record.providers)) fail('providers must be an object');
    for (const [id, value] of Object.entries(record.providers as Record<string, unknown>)) {
      if (!isJcProviderId(id)) fail(`unknown provider ${id}`);
      if (!isJcAuthorizerId(value)) fail(`provider ${id}: unknown authorizer ${String(value)}`);
      providers[id as JcProviderId] = value as JcAuthorizerId;
    }
  }
  const tools: Record<string, JcAuthorizerId> = {};
  if (record.tools !== undefined) {
    if (record.tools === null || typeof record.tools !== 'object' || Array.isArray(record.tools)) fail('tools must be an object');
    for (const [name, value] of Object.entries(record.tools as Record<string, unknown>)) {
      if (jcProviderOf(name) === undefined) fail(`unknown tool ${name}`);
      if (!isJcAuthorizerId(value)) fail(`tool ${name}: unknown authorizer ${String(value)}`);
      tools[name] = value as JcAuthorizerId;
    }
  }
  return Object.freeze({ default: record.default as JcAuthorizerId, providers: Object.freeze(providers), tools: Object.freeze(tools) });
}

export interface JcAuthorizerResolver {
  readonly preset: JcPreset;
  readonly table: JcAuthorizerTable;
  resolve(tool: string): JcRoute | undefined;
  /** Every manifest tool's route, in manifest order. */
  routes(): readonly JcRoute[];
  /** True when at least one tool is authorized by an ACS capability (so a verifier is needed). */
  usesAcs(): boolean;
}

export function createAuthorizerResolver(preset: JcPreset, table?: JcAuthorizerTable): JcAuthorizerResolver {
  if (!isJcPreset(preset)) throw new JcConfigError('JC_POLICY_INVALID', `unknown preset ${String(preset)}`);
  if (table !== undefined && preset === 'managed') {
    throw new JcConfigError('JC_POLICY_INVALID', 'the managed preset is fixed and takes no authorizer table');
  }
  if (table !== undefined && preset === 'standalone') {
    throw new JcConfigError('JC_POLICY_INVALID', 'the standalone preset is fixed and takes no authorizer table');
  }
  const effective: JcAuthorizerTable = table
    ?? uniformTable(preset === 'managed' ? 'acs-capability' : 'local');

  const resolveOne = (tool: string): JcRoute | undefined => {
    const provider = jcProviderOf(tool);
    const riskClass = jcRiskClassOf(tool);
    if (!provider || !riskClass) return undefined; // unknown tool: callers fail closed
    if (preset === 'standalone') {
      return { tool, provider, riskClass, authorizer: jcStandaloneToolAllowed(tool) ? 'local' : 'refused', source: 'preset' };
    }
    if (Object.prototype.hasOwnProperty.call(effective.tools, tool)) {
      return { tool, provider, riskClass, authorizer: effective.tools[tool], source: 'tool' };
    }
    const providerChoice = effective.providers[provider];
    if (providerChoice !== undefined) return { tool, provider, riskClass, authorizer: providerChoice, source: 'provider' };
    return { tool, provider, riskClass, authorizer: effective.default, source: table === undefined ? 'preset' : 'default' };
  };

  const toolNames = JC_PROVIDERS.flatMap((provider) => [...provider.tools]);
  const all = Object.freeze(toolNames.map((tool) => Object.freeze(resolveOne(tool) as JcRoute)));
  const byTool = new Map(all.map((route) => [route.tool, route]));
  const acs = all.some((route) => route.authorizer === 'acs-capability' || route.authorizer === 'admin-delegated');
  return Object.freeze({
    preset,
    table: effective,
    resolve: (tool: string) => byTool.get(tool),
    routes: () => all,
    usesAcs: () => acs,
  });
}
