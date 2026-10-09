/**
 * Edge routing for the Jace Commander `local` preset (ADR 0026 D6).
 *
 * The OAuth edge stays the AUTHENTICATION boundary for every call. This module
 * only decides whether a tools/call still needs an ACS capability ISSUED. For
 * tools whose effective authorizer is `local` it does not; the JC server is the
 * authority and enforces the class decision itself.
 *
 * Fail toward ACS, never toward local:
 *  - preset is not `local`                      -> everything is issued by ACS (today)
 *  - policy missing/invalid/unreadable (explicit path) -> everything is issued by ACS
 *  - a tool the policy routes to acs-capability / admin-delegated -> issued by ACS
 * If the edge ever skips issuance for a tool the server resolves to
 * acs-capability, the server denies it (JC_CAPABILITY_MISSING); an edge/server
 * mismatch is therefore a denial, never an escalation.
 *
 * TOOL -> PROVIDER mirrors vendor/desktop-commander/src/jace-commander/providers.ts.
 * tests/e2e/jc-tool-contract-drift.test.ts fails if the two diverge.
 */
import fs from 'node:fs';

export const JC_TOOL_PROVIDERS = Object.freeze({
  list_directory: 'jc.fs', get_file_info: 'jc.fs', read_file: 'jc.fs', read_multiple_files: 'jc.fs',
  start_search: 'jc.fs', get_more_search_results: 'jc.fs', list_searches: 'jc.fs', stop_search: 'jc.fs',
  write_file: 'jc.fs', create_directory: 'jc.fs', move_file: 'jc.fs', edit_block: 'jc.fs',
  git_status: 'jc.git', git_diff: 'jc.git', git_log: 'jc.git', git_branch: 'jc.git', git_show: 'jc.git',
  git_add: 'jc.git', git_commit: 'jc.git', git_fetch: 'jc.git', git_push: 'jc.git',
  start_process: 'jc.process', read_process_output: 'jc.process', list_processes: 'jc.process', kill_process: 'jc.process',
  privileged_exec: 'jc.privileged',
  ping: 'jc.meta', get_config: 'jc.meta', jc_status: 'jc.meta', jc_doctor: 'jc.meta', looptrace_verify: 'jc.meta',
  swarm_read: 'jc.integration', visualizer_read: 'jc.integration', mission_router_list: 'jc.integration',
  acs_read: 'acs', acs_submit_mission: 'acs',
});

const PROVIDER_IDS = new Set(Object.values(JC_TOOL_PROVIDERS));
const AUTHORIZERS = new Set(['local', 'acs-capability', 'admin-delegated']);
export const DEFAULT_SYSTEM_POLICY_PATH = '/etc/jace-commander/policy.json';
const MAX_POLICY_BYTES = 256 * 1024;

function parseTable(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('authorizers must be an object');
  for (const key of Object.keys(raw)) if (!['default', 'providers', 'tools'].includes(key)) throw new Error(`unknown key ${key}`);
  if (!AUTHORIZERS.has(raw.default) || raw.default === 'admin-delegated') throw new Error('invalid default authorizer');
  const providers = {};
  for (const [id, value] of Object.entries(raw.providers ?? {})) {
    if (!PROVIDER_IDS.has(id) || !AUTHORIZERS.has(value)) throw new Error(`invalid provider entry ${id}`);
    providers[id] = value;
  }
  const tools = {};
  for (const [name, value] of Object.entries(raw.tools ?? {})) {
    if (!Object.hasOwn(JC_TOOL_PROVIDERS, name) || !AUTHORIZERS.has(value)) throw new Error(`invalid tool entry ${name}`);
    tools[name] = value;
  }
  return { default: raw.default, providers, tools };
}

/** per-tool override, then provider, then default. Unknown tools are never local. */
export function resolveAuthorizer(table, tool) {
  if (!Object.hasOwn(JC_TOOL_PROVIDERS, tool)) return undefined;
  if (Object.hasOwn(table.tools, tool)) return table.tools[tool];
  const provider = JC_TOOL_PROVIDERS[tool];
  if (Object.hasOwn(table.providers, provider)) return table.providers[provider];
  return table.default;
}

export function localRoutingFromEnv(env = process.env) {
  const none = { enabled: false, isLocal: () => false };
  if (env.JC_PRESET !== 'local') return none;
  const explicit = env.JC_POLICY_PATH !== undefined;
  const file = env.JC_POLICY_PATH || DEFAULT_SYSTEM_POLICY_PATH;
  let table = { default: 'local', providers: {}, tools: {} };
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_POLICY_BYTES) throw new Error('policy is not a bounded regular file');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('policy must be an object');
    if (doc.authorizers !== undefined) table = parseTable(doc.authorizers);
  } catch (error) {
    if (!(error && error.code === 'ENOENT' && !explicit)) {
      return { enabled: true, isLocal: () => false, error: `policy unusable at the edge (${error.message}); issuing through ACS` };
    }
  }
  return { enabled: true, isLocal: (tool) => resolveAuthorizer(table, tool) === 'local' };
}

/**
 * Anti-spoof for calls that skip ACS issuance: drop every client-supplied
 * authority field (_meta.capability, _meta.acs*), exactly as capabilityTransport
 * does for issued calls, so nothing a client sends can look like authority.
 */
export function stripAuthorityMeta(parsed) {
  const params = parsed && typeof parsed === 'object' ? parsed.params : undefined;
  if (!params || typeof params !== 'object') return parsed;
  const meta = params._meta && typeof params._meta === 'object' ? params._meta : {};
  const kept = Object.fromEntries(Object.entries(meta).filter(([key]) => key !== 'capability' && !key.startsWith('acs')));
  const next = { ...params };
  if (Object.keys(kept).length > 0) next._meta = kept;
  else delete next._meta;
  return { ...parsed, params: next };
}
