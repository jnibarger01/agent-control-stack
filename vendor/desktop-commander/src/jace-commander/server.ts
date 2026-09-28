/**
 * Jace Commander MCP server (stdio).
 *
 * Deployment shape mirrors Desktop Commander on jacen-ubuntu:
 *   ChatGPT/Claude ─HTTPS─► Tailscale Funnel ─► gateway OAuth (server.js)
 *     ─► bridge.js ─stdio─► jace-commander serve
 *
 * Authorization:
 *   managed (default)  every tools/call must carry an ACS-issued acs.jc.v1
 *                      capability at params._meta.acsCapability.
 *   --standalone       local development: no per-call capability for the
 *                      integration tools.
 *   privileged_exec    in BOTH modes the capability is verified by the root
 *                      helper, not here; this process cannot grant sudo.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { JcConfig } from './config.js';
import { FileNonceStore, JC_TOOL_POLICIES, JcAuthorizationError, JcCapabilityVerifier, type JcAuthorization } from './contract.js';
import { acsAccessToken } from './device-login.js';
import {
  IntegrationError,
  acsReadUrl,
  listMissionRouterState,
  missionWorkItemBody,
  requestJson,
  resolveTracePath,
  swarmReadUrl,
  visualizerReadUrl,
  type AcsView,
  type MissionInput,
  type SwarmView,
  type VisualizerView,
} from './integrations.js';
import { JsonlTraceChain, readTraceFile, verifyChain } from './looptrace.js';
import { jcConfigView, jcDoctor, jcPing } from './doctor.js';
import { defaultDeniedRoots, getFileInfo, listDirectory, readFile, readMultipleFiles, type JcFsPolicy } from './filesystem.js';
import { gitAdd, gitBranch, gitCommit, gitDiff, gitFetch, gitLog, gitPush, gitShow, gitStatus } from './git-ops.js';
import { createDirectory, editBlock, moveFile, writeFile } from './mutations.js';
import { createProcessRegistry } from './processes.js';
import { createSearchRegistry } from './search.js';
import { invokePrivilegedHelper, privilegedHelperAvailable } from './privileged-client.js';
import { JC_TOOLS } from './tool-descriptors.js';
export { JC_TOOLS };
import { VERSION } from '../version.js';

export type JcMode = 'managed' | 'standalone';

export interface JcServerDeps {
  fetchImpl?: typeof fetch;
  invokeHelper?: typeof invokePrivilegedHelper;
  helperAvailable?: typeof privilegedHelperAvailable;
  now?: () => number;
}


type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ok(value: unknown, meta?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    // Machine-readable copy: the CLI's --json and MCP clients read this
    // instead of parsing the text block.
    ...(isPlainRecord(value) ? { structuredContent: value } : {}),
    ...(meta ? { _meta: meta } : {}),
  };
}

function fail(code: string, message: string, meta?: Record<string, unknown>): ToolResult {
  const error = { code, message };
  return { content: [{ type: 'text', text: JSON.stringify({ error }) }], structuredContent: { error }, isError: true, ...(meta ? { _meta: meta } : {}) };
}

function argsHash(args: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(args ?? {}), 'utf8').digest('hex');
}

export function assertToolPolicyCoverage(): void {
  const registered = JC_TOOLS.map((tool) => tool.name).sort();
  const governed = Object.keys(JC_TOOL_POLICIES).sort();
  if (registered.join(',') !== governed.join(',')) {
    throw new Error(`jace-commander tool/policy drift: tools=[${registered}] policies=[${governed}]`);
  }
}

/** Every manifest tool must have exactly one handler, and nothing else may. */
export function assertHandlerCoverage(handlerNames: readonly string[]): void {
  const expected = JC_TOOLS.map((tool) => tool.name).sort();
  const actual = [...handlerNames].sort();
  if (expected.join(',') !== actual.join(',')) {
    throw new Error(`jace-commander tool/handler drift: tools=[${expected}] handlers=[${actual}]`);
  }
}

export function createJcServer(config: JcConfig, mode: JcMode, deps: JcServerDeps = {}): Server {
  assertToolPolicyCoverage();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const invokeHelper = deps.invokeHelper ?? invokePrivilegedHelper;
  const helperAvailable = deps.helperAvailable ?? privilegedHelperAvailable;
  const helperOptions = { sudoPath: config.sudoPath, helperPath: config.privilegedHelperPath };
  const verifier = mode === 'managed'
    ? new JcCapabilityVerifier({
      publicKey: config.acsPublicKey,
      keyId: config.acsKeyId,
      runtimeId: config.runtimeId,
      nonceStore: new FileNonceStore(path.join(config.stateDir, 'nonces')),
      now: deps.now,
    })
    : undefined;
  const runId = `jc-mcp-${process.pid}-${Date.now()}`;
  const trace = new JsonlTraceChain(path.join(config.stateDir, 'traces', `${runId}.jsonl`), runId);

  const acsGet = async (url: string) => requestJson(url, {
    timeoutMs: config.requestTimeoutMs,
    token: await acsAccessToken(config.acsUrl, config.stateDir, process.env, fetchImpl),
    fetchImpl,
  });
  const swarmToken = process.env.JC_SWARM_TOKEN ?? process.env.SWARM_OPERATOR_TOKEN;

  const server = new Server({ name: 'jace-commander', version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: JC_TOOLS.map((tool) => ({ ...tool })) as any }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const capability = (request.params._meta as Record<string, unknown> | undefined)?.acsCapability;
    if (!Object.prototype.hasOwnProperty.call(JC_TOOL_POLICIES, name)) return fail('unknown_tool', `unknown tool: ${name}`);

    let authorization: JcAuthorization | undefined;
    if (verifier && name !== 'privileged_exec') {
      try {
        authorization = verifier.verify(name, args, capability);
      } catch (error) {
        const code = error instanceof JcAuthorizationError ? error.code : 'JC_CAPABILITY_MALFORMED';
        recordTrace(trace, name, args, { ok: false, code });
        return fail(code, 'Jace Commander managed authorization rejected', { acsAuthorization: { version: 'acs.jc.v1', decision: 'denied', code } });
      }
    }

    let result: ToolResult;
    try {
      result = await dispatch(name, args, capability);
    } catch (error) {
      result = error instanceof IntegrationError
        ? fail(error.code, error.message)
        : fail('internal_error', 'tool failed');
    }
    const meta = {
      jaceCommanderMode: mode,
      acsAuthorization: authorization
        ? { ...authorization, decision: 'granted' }
        : { decision: name === 'privileged_exec' ? 'delegated-to-privileged-helper' : 'not-required' },
    };
    recordTrace(trace, name, args, { ok: !result.isError, workItemId: authorization?.workItemId });
    return { ...result, _meta: { ...(result._meta ?? {}), ...meta } };
  });

  type Handler = (args: Record<string, unknown>, capability: unknown) => Promise<ToolResult>;
  const fsPolicy: JcFsPolicy = {
    roots: config.fsRoots,
    deniedRoots: [...defaultDeniedRoots(config.stateDir, config.homeDir), ...config.fsDeniedRoots],
  };

  // One handler per manifest tool. The same handlers serve every caller:
  // MCP clients and the jace-commander CLI (itself an MCP client of /jc/mcp).
  const search = createSearchRegistry();
  const processes = createProcessRegistry();
  const handlers: Readonly<Record<string, Handler>> = Object.freeze({
    jc_status: async () => ok(await status()),
    acs_read: async (args) => {
      const response = await acsGet(acsReadUrl(config, args.view as AcsView, args.id as string | undefined, args.status as string | undefined));
      return response.status < 400 ? ok(response.body) : fail(`acs_http_${response.status}`, 'ACS rejected the request', { upstream: response.body });
    },
    acs_submit_mission: async (args) => {
      const token = await acsAccessToken(config.acsUrl, config.stateDir, process.env, fetchImpl);
      if (!token) return fail('acs_not_logged_in', 'no ACS credential: run `jace-commander login` or set JC_ACS_TOKEN');
      const response = await requestJson(`${config.acsUrl}/work-items`, {
        method: 'POST', token, body: missionWorkItemBody(args as unknown as MissionInput), timeoutMs: config.requestTimeoutMs, fetchImpl,
      });
      return response.status < 400 ? ok(response.body) : fail(`acs_http_${response.status}`, 'ACS rejected the mission', { upstream: response.body });
    },
    swarm_read: async (args) => {
      const response = await requestJson(swarmReadUrl(config, args.view as SwarmView, args.taskId as string | undefined), {
        token: swarmToken, timeoutMs: config.requestTimeoutMs, fetchImpl,
      });
      return response.status < 400 ? ok(response.body) : fail(`swarm_http_${response.status}`, 'codex-swarm rejected the request');
    },
    visualizer_read: async (args) => {
      const response = await requestJson(visualizerReadUrl(config, args.view as VisualizerView), { timeoutMs: config.requestTimeoutMs, fetchImpl });
      return response.status < 400 ? ok(response.body) : fail(`visualizer_http_${response.status}`, 'visualizer rejected the request');
    },
    mission_router_list: async () => ok(listMissionRouterState(config.missionRouterDir)),
    looptrace_verify: async (args) => {
      const file = resolveTracePath(args.path, config.traceRoots);
      const parsed = readTraceFile(file);
      if (parsed.parseError) return ok({ path: file, ok: false, reason: `invalid JSON at line ${parsed.parseError.line}`, events: parsed.events.length });
      return ok({ path: file, events: parsed.events.length, ...verifyChain(parsed.events) });
    },
    privileged_exec: async (args, capability) => {
      if (capability === undefined) {
        return fail('JC_CAPABILITY_MISSING', 'privileged_exec requires an ACS acs.jc.v1 capability with a human approvalId; call it through the managed gateway (/jc/mcp), have a human approve the returned ACS work item, then retry the identical call');
      }
      const verdict = await invokeHelper({ capability, arguments: args }, helperOptions);
      return verdict.ok === true ? ok(verdict) : fail(String(verdict.code ?? 'PRIVILEGED_REJECTED'), 'privileged execution rejected; nothing ran');
    },
    list_directory: async (args) => ok(await listDirectory(args, fsPolicy)),
    get_file_info: async (args) => ok(await getFileInfo(args, fsPolicy)),
    read_file: async (args) => ok(await readFile(args, fsPolicy)),
    read_multiple_files: async (args) => ok(await readMultipleFiles(args, fsPolicy)),
    start_search: async (args) => ok(await search.start(args, fsPolicy)),
    get_more_search_results: async (args) => ok(search.more(args)),
    list_searches: async () => ok(search.list()),
    stop_search: async (args) => ok(search.stop(args)),
    write_file: async (args) => ok(await writeFile(args, fsPolicy)),
    create_directory: async (args) => ok(await createDirectory(args, fsPolicy)),
    move_file: async (args) => ok(await moveFile(args, fsPolicy)),
    edit_block: async (args) => ok(await editBlock(args, fsPolicy)),
    start_process: async (args) => ok(processes.start(args, fsPolicy)),
    read_process_output: async (args) => ok(processes.output(args)),
    list_processes: async () => ok(processes.list()),
    kill_process: async (args) => ok(processes.kill(args)),
    git_status: async (args) => ok(await gitStatus(args, fsPolicy)),
    git_diff: async (args) => ok(await gitDiff(args, fsPolicy)),
    git_log: async (args) => ok(await gitLog(args, fsPolicy)),
    git_branch: async (args) => ok(await gitBranch(args, fsPolicy)),
    git_show: async (args) => ok(await gitShow(args, fsPolicy)),
    git_add: async (args) => ok(await gitAdd(args, fsPolicy)),
    git_commit: async (args) => ok(await gitCommit(args, fsPolicy)),
    git_fetch: async (args) => ok(await gitFetch(args, fsPolicy)),
    git_push: async (args) => ok(await gitPush(args, fsPolicy)),
    jc_doctor: async () => ok(await jcDoctor(config)),
    ping: async () => ok(await jcPing(config)),
    get_config: async () => ok(jcConfigView(config)),
  });
  assertHandlerCoverage(Object.keys(handlers));

  async function dispatch(name: string, args: Record<string, unknown>, capability: unknown): Promise<ToolResult> {
    const handler = Object.prototype.hasOwnProperty.call(handlers, name) ? handlers[name] : undefined;
    return handler ? handler(args, capability) : fail('unknown_tool', `unknown tool: ${name}`);
  }

  async function status(): Promise<Record<string, unknown>> {
    const probe = async (url: string | undefined, token?: string) => {
      if (!url) return { configured: false };
      try {
        const response = await requestJson(url, { token, timeoutMs: Math.min(config.requestTimeoutMs, 3000), fetchImpl });
        return { configured: true, reachable: true, status: response.status };
      } catch (error) {
        return { configured: true, reachable: false, code: error instanceof IntegrationError ? error.code : 'error' };
      }
    };
    return {
      server: 'jace-commander',
      version: VERSION,
      mode,
      runtimeId: config.runtimeId,
      publicMcpUrl: config.publicMcpUrl,
      managedAuthorization: mode === 'managed'
        ? { contract: 'acs.jc.v1', keyConfigured: Boolean(config.acsPublicKey && config.acsKeyId) }
        : { contract: 'none (standalone)' },
      acs: { url: config.acsUrl, ...(await probe(`${config.acsUrl}/health`)) },
      swarm: { url: config.swarmUrl, ...(await probe(`${config.swarmUrl}/api/v1/health`, swarmToken)) },
      visualizer: { url: config.visualizerUrl ?? null, ...(await probe(config.visualizerUrl ? `${config.visualizerUrl}/healthz` : undefined)) },
      missionRouter: { dir: config.missionRouterDir },
      privilegedHelper: { path: config.privilegedHelperPath, sudoNonInteractive: await helperAvailable(helperOptions) },
    };
  }

  return server;
}

function recordTrace(trace: JsonlTraceChain, tool: string, args: unknown, outcome: Record<string, unknown>): void {
  try {
    trace.append('tool_call_finished', { tool, argumentsSha256: argsHash(args), ...outcome });
  } catch {
    // Local LoopTrace projection is telemetry (ACS ADR 0011); a write failure
    // must not change the tool outcome. Privileged audit is separate and
    // fail-closed inside the helper.
  }
}
