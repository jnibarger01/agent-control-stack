/**
 * Jace Commander provider registry (ADR 0026, slice 1).
 *
 * Tools are grouped into providers. The canonical manifest stays the source of
 * truth for tool names, schemas and scopes; this module only adds the
 * provider mapping and derives each tool's risk class from its manifest
 * scopes. Nothing here changes what any tool is allowed to do: slice 1 is a
 * pure addition, asserted at startup and by the parity tests.
 *
 * Risk classes are DERIVED, never configured:
 *   read < mutate < network < exec < privileged  (most severe scope wins)
 */
import { JC_TOOL_POLICIES } from './contract.js';

export const JC_PROVIDER_IDS = Object.freeze([
  'jc.fs', 'jc.git', 'jc.process', 'jc.privileged', 'jc.meta', 'jc.integration', 'acs',
] as const);
export type JcProviderId = typeof JC_PROVIDER_IDS[number];

export const JC_RISK_CLASSES = Object.freeze(['read', 'mutate', 'network', 'exec', 'privileged'] as const);
export type JcRiskClass = typeof JC_RISK_CLASSES[number];

/** What a provider needs in order to work. Informational; drives health checks. */
export type JcProviderNeeds = 'local' | 'root-helper' | 'none' | 'optional-services' | 'acs';

export interface JcProviderDefinition {
  readonly id: JcProviderId;
  readonly tools: readonly string[];
  readonly needs: JcProviderNeeds;
  /** Whether the server's overall health depends on this provider by default. */
  readonly required: boolean;
}

export const JC_PROVIDERS: readonly JcProviderDefinition[] = Object.freeze([
  {
    id: 'jc.fs',
    needs: 'local',
    required: true,
    tools: [
      'list_directory', 'get_file_info', 'read_file', 'read_multiple_files',
      'start_search', 'get_more_search_results', 'list_searches', 'stop_search',
      'write_file', 'create_directory', 'move_file', 'edit_block',
    ],
  },
  {
    id: 'jc.git',
    needs: 'local',
    required: true,
    tools: [
      'git_status', 'git_diff', 'git_log', 'git_branch', 'git_show',
      'git_add', 'git_commit', 'git_fetch', 'git_push',
    ],
  },
  {
    id: 'jc.process',
    needs: 'local',
    required: true,
    tools: ['start_process', 'read_process_output', 'list_processes', 'kill_process'],
  },
  { id: 'jc.privileged', needs: 'root-helper', required: false, tools: ['privileged_exec'] },
  {
    id: 'jc.meta',
    needs: 'none',
    required: true,
    tools: ['ping', 'get_config', 'jc_status', 'jc_doctor', 'looptrace_verify'],
  },
  {
    id: 'jc.integration',
    needs: 'optional-services',
    required: false,
    tools: ['swarm_read', 'visualizer_read', 'mission_router_list'],
  },
  { id: 'acs', needs: 'acs', required: false, tools: ['acs_read', 'acs_submit_mission'] },
].map((provider) => Object.freeze({ ...provider, tools: Object.freeze([...provider.tools]) })) as JcProviderDefinition[]);

const PROVIDER_BY_ID: ReadonlyMap<string, JcProviderDefinition> = new Map(JC_PROVIDERS.map((provider) => [provider.id, provider]));

const PROVIDER_OF_TOOL: ReadonlyMap<string, JcProviderId> = new Map(
  JC_PROVIDERS.flatMap((provider) => provider.tools.map((tool) => [tool, provider.id] as const)),
);

export function isJcProviderId(value: unknown): value is JcProviderId {
  return typeof value === 'string' && PROVIDER_BY_ID.has(value);
}

export function jcProvider(id: JcProviderId): JcProviderDefinition {
  return PROVIDER_BY_ID.get(id) as JcProviderDefinition;
}

/** The provider that owns `tool`, or undefined for an unknown tool (fail closed at callers). */
export function jcProviderOf(tool: string): JcProviderId | undefined {
  return PROVIDER_OF_TOOL.get(tool);
}

const SEVERITY: Readonly<Record<JcRiskClass, number>> = Object.freeze({ read: 0, mutate: 1, network: 2, exec: 3, privileged: 4 });

/** Scope -> class. A scope outside this table is a hard error, never silently `read`. */
function classOfScope(scope: string): JcRiskClass {
  switch (scope) {
    case 'fs.read': case 'git.read': case 'process.read': case 'integration.read': return 'read';
    case 'fs.write': case 'git.write': return 'mutate';
    case 'git.network': case 'integration.write': return 'network';
    case 'process.exec': return 'exec';
    case 'process.privileged': return 'privileged';
    default: throw new Error(`jace-commander: scope ${scope} has no risk class`);
  }
}

/** Risk class of a manifest tool (most severe of its scopes); undefined for an unknown tool. */
export function jcRiskClassOf(tool: string): JcRiskClass | undefined {
  const policy = Object.prototype.hasOwnProperty.call(JC_TOOL_POLICIES, tool) ? JC_TOOL_POLICIES[tool] : undefined;
  if (!policy || policy.scopes.length === 0) return undefined;
  return policy.scopes.map(classOfScope).reduce((worst, next) => (SEVERITY[next] > SEVERITY[worst] ? next : worst));
}

/**
 * Every manifest tool has exactly one provider, and no provider names a tool
 * the manifest does not have. Extends the existing tool/policy/handler
 * coverage assertions to providers.
 */
export function assertProviderCoverage(manifestToolNames: readonly string[] = Object.keys(JC_TOOL_POLICIES)): void {
  const seen = new Map<string, JcProviderId>();
  for (const provider of JC_PROVIDERS) {
    for (const tool of provider.tools) {
      const previous = seen.get(tool);
      if (previous) throw new Error(`jace-commander provider drift: ${tool} is in both ${previous} and ${provider.id}`);
      seen.set(tool, provider.id);
    }
  }
  const expected = [...manifestToolNames].sort();
  const actual = [...seen.keys()].sort();
  if (expected.join(',') !== actual.join(',')) {
    const missing = expected.filter((name) => !seen.has(name));
    const extra = actual.filter((name) => !expected.includes(name));
    throw new Error(`jace-commander tool/provider drift: no provider for [${missing}]; not in manifest [${extra}]`);
  }
  for (const tool of expected) {
    if (jcRiskClassOf(tool) === undefined) throw new Error(`jace-commander: ${tool} has no risk class`);
  }
}

export type JcProviderState = 'ok' | 'degraded' | 'unavailable' | 'disabled';

export interface JcProviderHealth {
  id: JcProviderId;
  required: boolean;
  state: JcProviderState;
  detail: string;
  toolCount: number;
}

export type JcProviderProbe = () => Promise<{ state: JcProviderState; detail: string }>;

const PROBE_TIMEOUT_MS = 3_000;

/**
 * Runs every provider's probe independently. A probe that throws, rejects or
 * hangs marks only ITS provider `unavailable`; it can never fail another
 * provider's health or any tool call (ADR 0026 invariant 4).
 */
export async function collectProviderHealth(
  probes: Partial<Record<JcProviderId, JcProviderProbe>>,
  options: { requiredOverrides?: Partial<Record<JcProviderId, boolean>>; timeoutMs?: number } = {},
): Promise<JcProviderHealth[]> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  return Promise.all(JC_PROVIDERS.map(async (provider): Promise<JcProviderHealth> => {
    const base = {
      id: provider.id,
      required: options.requiredOverrides?.[provider.id] ?? provider.required,
      toolCount: provider.tools.length,
    };
    const probe = probes[provider.id];
    if (!probe) return { ...base, state: 'ok', detail: 'no external dependency probed' };
    let timer: NodeJS.Timeout | undefined;
    try {
      const outcome = await Promise.race([
        probe(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('probe timed out')), timeoutMs);
        }),
      ]);
      return { ...base, ...outcome };
    } catch (error) {
      return { ...base, state: 'unavailable', detail: error instanceof Error ? error.message : 'probe failed' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }));
}
