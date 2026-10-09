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
 *   --standalone       local development, no ACS: ONLY read-only tools are
 *                      registered, listed and dispatched (manifest tools that
 *                      are not approval-gated and whose every scope is a
 *                      `*.read` scope; see jcStandaloneToolAllowed). Writes,
 *                      process/git mutation, acs_submit_mission and
 *                      privileged_exec are refused before any handler runs.
 *   --preset local    (ADR 0026) every provider authorized by the `local`
 *                      authorizer: read class is allowed, the other classes
 *                      follow the class decisions (default: human approval).
 *                      Distinct from standalone; standalone is unchanged.
 *   privileged_exec    managed mode only; the capability is verified by the
 *                      root helper, not here; this process cannot grant sudo.
 *                      It is excluded from standalone even though the helper
 *                      would still verify an ACS capability: standalone has no
 *                      ACS in front of it, so there is nothing to approve with.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { JcConfig } from './config.js';
import { FileNonceStore, JC_TOOL_POLICIES, JcAuthorizationError, JcCapabilityVerifier, type JcAuthorization } from './contract.js';
import { acsAccessToken } from './device-login.js';
import {
  IntegrationError,
  acsReadUrl,
  acsReadyUrl,
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
import { checkPolicyConstraints, loadJcPolicy, type JcPolicyLoad } from './local-policy.js';
import { ApproverClient, ApproverUnavailable, type AuthorizeReply } from './approver-client.js';
import { JcLocalTokenError, JcLocalTokenVerifier, type JcLocalAuthorization } from './local-token.js';
import { jcConfigView, jcDoctor, jcPing } from './doctor.js';
import { defaultDeniedRoots, getFileInfo, listDirectory, readFile, readMultipleFiles, type JcFsPolicy } from './filesystem.js';
import { gitAdd, gitBranch, gitCommit, gitDiff, gitFetch, gitLog, gitPush, gitShow, gitStatus } from './git-ops.js';
import { createDirectory, editBlock, moveFile, writeFile } from './mutations.js';
import { createProcessRegistry } from './processes.js';
import { createSearchRegistry } from './search.js';
import { invokePrivilegedHelper, privilegedHelperAvailable } from './privileged-client.js';
import { assertProviderCoverage, collectProviderHealth, type JcProviderId, type JcProviderProbe } from './providers.js';
import {
  JC_DEFAULT_CLASS_DECISIONS,
  createAuthorizerResolver,
  jcStandaloneToolAllowed,
  type JcAuthorizerTable,
  type JcClassDecisions,
  type JcPreset,
  type JcRoute,
} from './authorizers.js';
import { JC_TOOLS } from './tool-descriptors.js';
export { JC_TOOLS };
import { VERSION } from '../version.js';

export type JcMode = JcPreset;

export interface JcServerDeps {
  /** Overrides the authorizer table the `local` preset takes from the policy (tests). */
  authorizerTable?: JcAuthorizerTable;
  /** Overrides the class decisions the `local` preset takes from the policy (tests). */
  classDecisions?: JcClassDecisions;
  /** Pre-loaded policy (tests). Otherwise loaded once at startup from config for the `local` preset. */
  policy?: JcPolicyLoad;
  /** Tests only: skip the cannot-modify-it policy check. */
  skipPolicyImmutability?: boolean;
  /** Overrides the approverd client the `local` preset builds from config (tests). */
  approver?: { authorize(tool: string, args: Record<string, unknown>): Promise<AuthorizeReply>; ping(): Promise<{ runtimeId: string; keyId: string }> };
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

export { jcStandaloneToolAllowed };

/** Tool names served in standalone mode, derived from the manifest. */
export const JC_STANDALONE_TOOL_NAMES: readonly string[] = Object.freeze(
  JC_TOOLS.map((tool) => tool.name).filter((name) => jcStandaloneToolAllowed(name)),
);

export function createJcServer(config: JcConfig, mode: JcMode, deps: JcServerDeps = {}): Server {
  assertToolPolicyCoverage();
  assertProviderCoverage();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const invokeHelper = deps.invokeHelper ?? invokePrivilegedHelper;
  const helperAvailable = deps.helperAvailable ?? privilegedHelperAvailable;
  const helperOptions = { sudoPath: config.sudoPath, helperPath: config.privilegedHelperPath };
  // The policy applies to the `local` preset only; managed/standalone never read it (parity).
  const policy: JcPolicyLoad | undefined = mode === 'local'
    ? (deps.policy ?? loadJcPolicy({
      systemPath: config.policyPath,
      systemPathExplicit: config.policyPathExplicit,
      userPath: config.policyUserPath,
      unsafeDev: config.policyUnsafeDev,
      requireImmutable: !deps.skipPolicyImmutability,
      baseFsRoots: config.fsRoots,
    }))
    : undefined;
  const resolver = createAuthorizerResolver(mode, deps.authorizerTable ?? (mode === 'local' ? policy?.effective.authorizerTable : undefined));
  const classDecisions = deps.classDecisions ?? policy?.effective.classDecisions ?? JC_DEFAULT_CLASS_DECISIONS;
  const verifier = resolver.usesAcs()
    ? new JcCapabilityVerifier({
      publicKey: config.acsPublicKey,
      keyId: config.acsKeyId,
      runtimeId: config.runtimeId,
      nonceStore: new FileNonceStore(path.join(config.stateDir, 'nonces')),
      now: deps.now,
    })
    : undefined;
  const routeTrace = (route: JcRoute): Record<string, unknown> => ({ ...traceRoute(route), ...(policy ? { policyHash: policy.hash } : {}) });
  // Local human approval (slice 4): enabled only in the `local` preset and only when approverd's
  // socket AND its public trust anchor are both configured. Without them `approve` fails closed.
  const approver = mode !== 'local' ? undefined : deps.approver ?? (
    config.approverRequestSocket && config.approverPublicKey && config.approverKeyId
      ? new ApproverClient(config.approverRequestSocket, config.runtimeId)
      : undefined
  );
  const localVerifier = approver
    ? new JcLocalTokenVerifier({
      publicKey: config.approverPublicKey,
      keyId: config.approverKeyId,
      runtimeId: config.runtimeId,
      nonceStore: new FileNonceStore(path.join(config.stateDir, 'local-nonces')),
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

  // Tools the preset has never served (standalone's 12 non-read tools) are not listed.
  const listed = JC_TOOLS.filter((tool) => resolver.resolve(tool.name)?.authorizer !== 'refused');
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed.map((tool) => ({ ...tool })) as any }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const capability = (request.params._meta as Record<string, unknown> | undefined)?.acsCapability;
    const route = Object.prototype.hasOwnProperty.call(JC_TOOL_POLICIES, name) ? resolver.resolve(name) : undefined;
    if (!route) return fail('unknown_tool', `unknown tool: ${name}`);
    let routeMeta = jcAuthorizationMeta(mode, route);
    if (route.authorizer === 'refused') {
      // No capability exists in standalone mode, so nothing that writes,
      // executes or needs approval may run. Refused before any handler.
      recordTrace(trace, name, args, { ok: false, code: 'JC_STANDALONE_TOOL_REFUSED', ...routeTrace(route) });
      return fail(
        'JC_STANDALONE_TOOL_REFUSED',
        `${name} is not available in standalone mode (read-only tools only); run managed behind ACS to use it`,
        { jaceCommanderMode: mode, acsAuthorization: { decision: 'refused-standalone' }, ...routeMeta },
      );
    }

    if (policy?.state === 'invalid' && route.provider !== 'jc.meta') {
      // A configured policy that cannot be trusted denies everything but diagnostics.
      recordTrace(trace, name, args, { ok: false, code: 'JC_POLICY_INVALID', ...routeTrace(route) });
      return fail('JC_POLICY_INVALID', 'the configured local policy is missing, invalid or modifiable by this process; run jc_doctor', { jaceCommanderMode: mode, ...jcAuthorizationMeta(mode, route, 'policy-invalid') });
    }

    let authorization: JcAuthorization | undefined;
    let localAuthorization: JcLocalAuthorization | undefined;
    // What the privileged handler forwards to the root helper. Under the local authorizer it is
    // ONLY ever approverd's token, never anything the client put in _meta.
    let helperCapability: unknown = capability;
    if (route.authorizer === 'local') {
      helperCapability = undefined;
      const decision = classDecisions[route.riskClass];
      // A privileged class can never be `allow`; refuse rather than trust a bad table.
      const effective = route.riskClass === 'privileged' && decision === 'allow' ? 'deny' : decision;
      if (effective === 'deny') {
        recordTrace(trace, name, args, { ok: false, code: 'JC_LOCAL_DENIED', ...routeTrace(route) });
        return fail('JC_LOCAL_DENIED', `${name} is denied by the local policy for class ${route.riskClass}`, { jaceCommanderMode: mode, ...jcAuthorizationMeta(mode, route, 'denied') });
      }
      if (effective === 'approve') {
        const outcome = await localApproval(name, args, route);
        if (!outcome.granted) return outcome.result;
        localAuthorization = outcome.authorization;
        helperCapability = outcome.token;
        routeMeta = jcAuthorizationMeta(mode, route, 'approved', { approvalId: localAuthorization.approvalId, approverId: localAuthorization.approverId, tokenId: localAuthorization.tokenId });
      }
    } else if (verifier && name !== 'privileged_exec') {
      try {
        authorization = verifier.verify(name, args, capability);
      } catch (error) {
        const code = error instanceof JcAuthorizationError ? error.code : 'JC_CAPABILITY_MALFORMED';
        recordTrace(trace, name, args, { ok: false, code, ...routeTrace(route) });
        return fail(code, 'Jace Commander managed authorization rejected', { acsAuthorization: { version: 'acs.jc.v1', decision: 'denied', code }, ...routeMeta });
      }
    }

    if (policy && route.authorizer === 'local') {
      const violation = checkPolicyConstraints(policy.effective, name, args);
      if (violation) {
        recordTrace(trace, name, args, { ok: false, code: 'JC_POLICY_CONSTRAINT', ...routeTrace(route) });
        return fail('JC_POLICY_CONSTRAINT', violation, { jaceCommanderMode: mode, ...jcAuthorizationMeta(mode, route, 'constraint-violation') });
      }
    }

    // Durable intent BEFORE the side effect for anything above read that JC itself
    // authorized. No intent record, no execution (ADR 0026 D1.4). Managed and
    // read-class calls keep the best-effort behavior they always had.
    if ((route.authorizer === 'local' || route.authorizer === 'admin-delegated') && route.riskClass !== 'read') {
      try {
        trace.append('tool_call_started', { tool: name, argumentsSha256: argsHash(args), ...routeTrace(route), ...approvalTrace(localAuthorization) });
      } catch {
        return fail('JC_TRACE_UNAVAILABLE', 'the local audit trace cannot be written; refusing to run a mutating call', { jaceCommanderMode: mode, ...jcAuthorizationMeta(mode, route, 'trace-unavailable') });
      }
    }

    let result: ToolResult;
    try {
      result = await dispatch(name, args, helperCapability);
    } catch (error) {
      result = error instanceof IntegrationError
        ? fail(error.code, error.message)
        : fail('internal_error', 'tool failed');
    }
    const meta = {
      jaceCommanderMode: mode,
      acsAuthorization: authorization
        ? { ...authorization, decision: 'granted' }
        : { decision: name === 'privileged_exec' && route.authorizer !== 'local' ? 'delegated-to-privileged-helper' : 'not-required' },
      ...routeMeta,
    };
    recordTrace(trace, name, args, { ok: !result.isError, workItemId: authorization?.workItemId, ...routeTrace(route), ...approvalTrace(localAuthorization) });
    return { ...result, _meta: { ...(result._meta ?? {}), ...meta } };
  });

  /**
   * `approve` decisions: ask approverd. A pending approval returns a challenge the human
   * resolves with `jace-commander approve <id>`; the identical retry claims it once and
   * yields a jc.local.v1 token that THIS process verifies before running anything.
   * For privileged_exec the same token is then handed to the root helper, which verifies it
   * again against its own root-owned local trust anchor; this process cannot grant sudo.
   */
  async function localApproval(name: string, args: Record<string, unknown>, route: JcRoute):
    Promise<{ granted: true; authorization: JcLocalAuthorization; token: unknown } | { granted: false; result: ToolResult }> {
    const refuse = (code: string, message: string, decision: string, extraMeta: Record<string, unknown> = {}, extraTrace: Record<string, unknown> = {}) => {
      recordTrace(trace, name, args, { ok: false, code, ...routeTrace(route), ...extraTrace });
      return { granted: false as const, result: fail(code, message, { jaceCommanderMode: mode, ...jcAuthorizationMeta(mode, route, decision), ...extraMeta }) };
    };
    if (!approver || !localVerifier) {
      return refuse('JC_LOCAL_APPROVAL_UNAVAILABLE', `${name} needs local human approval (class ${route.riskClass}) but no approver is available; nothing ran`, 'approval-unavailable');
    }
    let reply: AuthorizeReply;
    try {
      reply = await approver.authorize(name, args);
    } catch (error) {
      const detail = error instanceof ApproverUnavailable ? error.message : 'approver error';
      return refuse('JC_LOCAL_APPROVAL_UNAVAILABLE', `${name} needs local human approval but approverd is unavailable (${detail}); nothing ran`, 'approval-unavailable');
    }
    if (reply.state === 'pending') {
      return refuse(
        'JC_LOCAL_APPROVAL_REQUIRED',
        `${name} needs human approval ${reply.approvalId}: run \`jace-commander approve ${reply.approvalId}\` on a terminal, then retry the identical call (the approval is single-use)`,
        'approval-required',
        { jcApproval: { approvalId: reply.approvalId, expiresAt: reply.expiresAt, command: `jace-commander approve ${reply.approvalId}` } },
        { approvalId: reply.approvalId },
      );
    }
    if (reply.state === 'rejected') {
      return refuse('JC_LOCAL_APPROVAL_REJECTED', `${name} was rejected by the approver (${reply.approvalId}); nothing ran`, 'approval-rejected', {}, { approvalId: reply.approvalId });
    }
    try {
      return { granted: true, authorization: localVerifier.verify(name, args, reply.token), token: reply.token };
    } catch (error) {
      const code = error instanceof JcLocalTokenError ? error.code : 'JC_LOCAL_TOKEN_MALFORMED';
      return refuse(code, 'the approval token was not accepted; nothing ran', 'token-rejected', {}, { approvalId: reply.approvalId });
    }
  }

  type Handler = (args: Record<string, unknown>, capability: unknown) => Promise<ToolResult>;
  const fsPolicy: JcFsPolicy = {
    roots: policy?.effective.fsRoots ?? config.fsRoots,
    deniedRoots: [
      ...defaultDeniedRoots(config.stateDir, config.homeDir),
      ...config.fsDeniedRoots,
      // The model must not be able to read the policy it is governed by, or edit it.
      ...(mode === 'local' ? [config.policyPath, config.policyUserPath] : []),
      ...(policy?.effective.fsDeniedRoots ?? []),
    ],
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
    jc_doctor: async () => ok(await jcDoctor(config, {
      mode,
      handlerNames: Object.keys(handlers),
      verifierReady: Boolean(verifier && config.acsPublicKey && config.acsKeyId),
      policy,
      approver: mode === 'local' ? approverHealth : undefined,
      privilegedHelper: () => helperAvailable(helperOptions),
    })),
    ping: async () => ok(await jcPing(config)),
    get_config: async () => ok(jcConfigView(config)),
  });
  assertHandlerCoverage(Object.keys(handlers));

  async function dispatch(name: string, args: Record<string, unknown>, capability: unknown): Promise<ToolResult> {
    const handler = Object.prototype.hasOwnProperty.call(handlers, name) ? handlers[name] : undefined;
    return handler ? handler(args, capability) : fail('unknown_tool', `unknown tool: ${name}`);
  }

  /** Whether approverd is configured, reachable and the one we trust; and that WE cannot reach decide.sock. */
  async function approverHealth(): Promise<Record<string, unknown>> {
    const configured = Boolean(approver);
    let reachable = false;
    let keyMatches = false;
    if (approver) {
      try {
        const pong = await approver.ping();
        reachable = true;
        keyMatches = pong.keyId === config.approverKeyId && pong.runtimeId === config.runtimeId;
      } catch {
        reachable = false;
      }
    }
    // The server identity must NOT be able to open the decide socket (ADR 0026 D4).
    let serverCanDecide: boolean | undefined;
    if (config.approverDecideSocket) {
      try {
        fs.accessSync(config.approverDecideSocket, fs.constants.R_OK | fs.constants.W_OK);
        serverCanDecide = true;
      } catch {
        serverCanDecide = false;
      }
    }
    return { configured, reachable, keyMatches, serverCanDecide };
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
    // ACS is probed at /readyz (about 60 ms); the deep /health takes seconds and
    // made a healthy ACS look unreachable (ADR 0026 section 1.5).
    const [acs, swarm, visualizer, helper] = await Promise.all([
      probe(acsReadyUrl(config)),
      probe(`${config.swarmUrl}/api/v1/health`, swarmToken),
      probe(config.visualizerUrl ? `${config.visualizerUrl}/healthz` : undefined),
      helperAvailable(helperOptions).catch(() => false),
    ]);
    const reachable = (result: { configured: boolean; reachable?: boolean }) => result.configured && result.reachable === true;
    const probes: Partial<Record<JcProviderId, JcProviderProbe>> = {
      'jc.fs': async () => {
        const missing = config.fsRoots.filter((root) => !fs.existsSync(root));
        if (config.fsRoots.length === 0) return { state: 'degraded', detail: 'JC_FS_ROOTS empty; filesystem, process and git tools fail closed' };
        return missing.length ? { state: 'degraded', detail: `missing roots: ${missing.join(', ')}` } : { state: 'ok', detail: `${config.fsRoots.length} root(s)` };
      },
      'jc.privileged': async () => (helper
        ? { state: 'ok', detail: 'sudo -n helper available' }
        : { state: 'unavailable', detail: 'privileged helper not installed or sudo -n refused' }),
      'jc.integration': async () => {
        const configured = [swarm, visualizer].filter((entry) => entry.configured);
        const down = configured.filter((entry) => !reachable(entry as { configured: boolean; reachable?: boolean }));
        if (down.length === 0) return { state: 'ok', detail: `${configured.length} service(s) reachable` };
        return { state: 'degraded', detail: `${down.length}/${configured.length} configured service(s) unreachable` };
      },
      acs: async () => (reachable(acs as { configured: boolean; reachable?: boolean })
        ? { state: 'ok', detail: 'ACS /readyz reachable' }
        : { state: 'unavailable', detail: 'ACS /readyz not reachable' }),
    };
    return {
      server: 'jace-commander',
      version: VERSION,
      mode,
      runtimeId: config.runtimeId,
      publicMcpUrl: config.publicMcpUrl,
      managedAuthorization: mode === 'managed'
        ? { contract: 'acs.jc.v1', keyConfigured: Boolean(config.acsPublicKey && config.acsKeyId) }
        : mode === 'local'
          ? { contract: 'local', classDecisions: classDecisions, served: listed.length }
          : { contract: 'none (standalone)', tools: 'read-only only', served: JC_STANDALONE_TOOL_NAMES.length },
      acs: { url: config.acsUrl, ...acs },
      swarm: { url: config.swarmUrl, ...swarm },
      visualizer: { url: config.visualizerUrl ?? null, ...visualizer },
      missionRouter: { dir: config.missionRouterDir },
      privilegedHelper: { path: config.privilegedHelperPath, sudoNonInteractive: helper },
      providers: await collectProviderHealth(probes),
      ...(mode === 'local' ? { approver: await approverHealth() } : {}),
      ...(policy ? { policy: { state: policy.state, hash: policy.hash, immutable: policy.immutable, unsafeDev: policy.unsafeDev, sources: policy.sources, errorCount: policy.errors.length } } : {}),
    };
  }

  return server;
}

/** Route detail for trace records (all presets). */
function traceRoute(route: JcRoute): Record<string, unknown> {
  return { authorizer: route.authorizer, provider: route.provider, riskClass: route.riskClass };
}

/**
 * Per-call authorization detail surfaced to clients. Absent in `managed` so
 * managed responses stay byte-identical to before ADR 0026.
 */
function jcAuthorizationMeta(mode: JcMode, route: JcRoute, decision?: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  if (mode === 'managed') return {};
  return { jcAuthorization: { authorizer: route.authorizer, provider: route.provider, class: route.riskClass, source: route.source, ...(decision ? { decision } : {}), ...extra } };
}

/** Approval identifiers for trace records (ids only; never the token). */
function approvalTrace(auth: JcLocalAuthorization | undefined): Record<string, unknown> {
  return auth ? { approvalId: auth.approvalId, approverId: auth.approverId, tokenId: auth.tokenId } : {};
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
