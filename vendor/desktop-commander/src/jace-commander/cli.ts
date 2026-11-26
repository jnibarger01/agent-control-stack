#!/usr/bin/env node
/**
 * jace-commander CLI (also installed as `jc`).
 *
 * Tool commands (ls, stat, read, cat, acs read, ...) are MCP tools/call
 * requests to the managed /jc/mcp lane. They are authorized by ACS exactly
 * like any other MCP client's calls and executed by the same server handlers;
 * the CLI has no local execution path and makes no authorization decision.
 * `jace-commander help` lists everything; exit codes are stable (see help).
 *
 * Local commands: serve, connect, disconnect, login, whoami, logout,
 * status --local, tools, version, help.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { runAuthCommand } from './auth-cli.js';
import { CLI_COMMANDS, CliUsageError, helpText, parseArgs, resolveCommand } from './cli-commands.js';
import { loadJcConfig, type JcConfig } from './config.js';
import { clearAcsCredentials, deviceLogin, loadCredentials } from './device-login.js';
import { JC_MANIFEST } from './manifest.generated.js';
import { loadMcpAuthStatus, mcpAuthProvider } from './mcp-auth.js';
import { JC_EXIT, McpHttpClient, type JcCallOutcome } from './mcp-http-client.js';
import { safeErrorMessage } from './secret-redaction.js';
import { privilegedHelperAvailable } from './privileged-client.js';
import { JC_PRESETS, isJcPreset, type JcPreset } from './authorizers.js';
import { createJcServer } from './server.js';
import { runApproveCommand } from './approve-cli.js';
import { runLocalCeremony } from './passkey-ceremony.js';
import readline from 'node:readline/promises';
import { JC_TOOLS } from './tool-descriptors.js';
import { VERSION } from '../version.js';

type Out = { json: boolean; stdout: (text: string) => void; stderr: (text: string) => void };

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function mcpUrlFor(config: JcConfig, env: NodeJS.ProcessEnv = process.env): string {
  return (env.JC_MCP_URL ?? config.publicMcpUrl).replace(/\/$/, '');
}

/** Human rendering of a refusal: an ACS decision must never look like a crash. */
function renderRefusal(outcome: JcCallOutcome): string {
  if (outcome.kind === 'managed_authorization_required') {
    return [
      'APPROVAL REQUIRED',
      '',
      ...(outcome.workItemId ? [`Work item: ${outcome.workItemId}`] : []),
      ...(outcome.actionHash ? [`Action hash: ${outcome.actionHash}`] : []),
      '',
      outcome.approvalInstructions ?? 'Approve the work item through ACS, then retry the identical command.',
    ].join('\n');
  }
  const title = {
    managed_authorization_denied: 'DENIED by ACS',
    managed_authorization_unavailable: 'AUTHORIZATION UNAVAILABLE (nothing ran)',
    not_connected: 'NOT CONNECTED',
    execution_unknown: 'EXECUTION UNKNOWN (the call may have run; verify before re-running)',
    invalid_arguments: 'INVALID ARGUMENTS',
    tool_error: 'FAILED',
    ok: 'OK',
  }[outcome.kind];
  return `${title}: ${outcome.code ?? ''}${outcome.message ? `\n${outcome.message}` : ''}`;
}

export function outcomeJson(outcome: JcCallOutcome): Record<string, unknown> {
  if (outcome.kind === 'ok') return outcome.result ?? { text: outcome.text ?? '' };
  return {
    ok: false,
    kind: outcome.kind,
    ...(outcome.code ? { code: outcome.code } : {}),
    ...(outcome.message ? { message: outcome.message } : {}),
    ...(outcome.workItemId ? { workItemId: outcome.workItemId } : {}),
    ...(outcome.actionHash ? { actionHash: outcome.actionHash } : {}),
    ...(outcome.approvalInstructions ? { approvalInstructions: outcome.approvalInstructions } : {}),
    ...(outcome.retryable !== undefined ? { retryable: outcome.retryable } : {}),
  };
}

async function runToolCommand(argv: string[], config: JcConfig, out: Out, env: NodeJS.ProcessEnv): Promise<number> {
  const resolved = resolveCommand(argv);
  if (!resolved) {
    out.stderr(`unknown command: ${argv.join(' ')}\nRun \`jace-commander help\`.`);
    return JC_EXIT.invalidArguments;
  }
  const { command, rest } = resolved;
  let args: Record<string, unknown>;
  try {
    const parsed = parseArgs(rest, ['json', ...(command.booleanFlags ?? [])], command.options);
    if (parsed.positionals.length > command.maxPositionals) {
      throw new CliUsageError(`unexpected argument: ${parsed.positionals[command.maxPositionals]}`);
    }
    args = command.toArguments(parsed);
  } catch (error) {
    if (!(error instanceof CliUsageError)) throw error;
    const outcome: JcCallOutcome = { kind: 'invalid_arguments', exitCode: JC_EXIT.invalidArguments, code: 'usage', message: `${error.message}\nusage: jace-commander ${command.usage}` };
    out.json ? out.stdout(JSON.stringify(outcomeJson(outcome), null, 2)) : out.stderr(renderRefusal(outcome));
    return outcome.exitCode;
  }
  const url = mcpUrlFor(config, env);
  const client = new McpHttpClient({ url, auth: mcpAuthProvider(url, config.stateDir, env) });
  try {
    const outcome = await client.callTool(command.tool, args);
    if (out.json) out.stdout(JSON.stringify(outcomeJson(outcome), null, 2));
    else if (outcome.kind === 'ok') out.stdout(command.render(outcome.result, outcome.text));
    else out.stderr(renderRefusal(outcome));
    return outcome.exitCode;
  } finally {
    await client.close();
  }
}

interface ClientCheck {
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
}

function descriptorKey(tool: Record<string, unknown>): string {
  return JSON.stringify([tool.name, tool.description, tool.inputSchema]);
}

/**
 * `jace-commander doctor`: the client half of the chain (CLI verbs, the
 * /jc/mcp endpoint, live tools/list against this manifest), then the server's
 * own jc_doctor through the same governed path every other command uses.
 */
async function runDoctor(config: JcConfig, out: Out, env: NodeJS.ProcessEnv): Promise<number> {
  const checks: ClientCheck[] = [];
  const manifestVerbs = JC_MANIFEST.tools.flatMap((tool) => tool.cliCommands.map((verb) => `${verb}->${tool.name}`)).sort();
  const cliVerbs = CLI_COMMANDS.map((command) => `${command.verb}->${command.tool}`).sort();
  checks.push({
    name: 'cli parity',
    ok: manifestVerbs.join('|') === cliVerbs.join('|'),
    required: true,
    detail: `${cliVerbs.length} CLI verbs for ${JC_MANIFEST.tools.length} manifest tools`,
  });
  const url = mcpUrlFor(config, env);
  const client = new McpHttpClient({ url, auth: mcpAuthProvider(url, config.stateDir, env) });
  let server: Record<string, unknown> | null = null;
  let exitCode: number = JC_EXIT.ok;
  try {
    let live: Array<Record<string, unknown>> | null = null;
    try {
      live = await client.listTools();
      checks.push({ name: 'jc mcp endpoint', ok: true, required: true, detail: `${url} answered tools/list` });
    } catch (error) {
      const outcome = (error as { outcome?: JcCallOutcome }).outcome;
      if (!outcome) throw error;
      checks.push({ name: 'jc mcp endpoint', ok: false, required: true, detail: `${url}: ${outcome.kind}${outcome.code ? ` (${outcome.code})` : ''}${outcome.message ? `: ${outcome.message}` : ''}` });
      exitCode = outcome.exitCode;
    }
    if (live) {
      const expected = new Map(JC_TOOLS.map((tool) => [tool.name, descriptorKey(tool as unknown as Record<string, unknown>)]));
      const seen = new Map(live.map((tool) => [String(tool.name), descriptorKey(tool)]));
      const missing = [...expected.keys()].filter((name) => !seen.has(name));
      const extra = [...seen.keys()].filter((name) => !expected.has(name));
      const changed = [...expected.keys()].filter((name) => seen.has(name) && seen.get(name) !== expected.get(name));
      const drift = missing.length + extra.length + changed.length > 0;
      checks.push({
        name: 'tools/list drift',
        ok: !drift,
        required: true,
        detail: drift
          ? `live ${seen.size} vs manifest ${expected.size}; missing [${missing.join(',')}] extra [${extra.join(',')}] changed [${changed.join(',')}]`
          : `live tools/list matches manifest ${JC_MANIFEST.manifestHash.slice(0, 12)} (${seen.size} tools)`,
      });
      const outcome = await client.callTool('jc_doctor', {});
      if (outcome.kind === 'ok' && outcome.result && typeof outcome.result === 'object') {
        server = outcome.result as Record<string, unknown>;
        checks.push({ name: 'jc_doctor', ok: server.ok === true, required: true, detail: `server report ${server.ok === true ? 'ok' : 'has failing checks'}` });
      } else {
        checks.push({ name: 'jc_doctor', ok: false, required: true, detail: `${outcome.kind}${outcome.code ? ` (${outcome.code})` : ''}${outcome.message ? `: ${outcome.message}` : ''}` });
        exitCode = outcome.exitCode;
      }
    }
  } finally {
    await client.close();
  }
  const okAll = checks.every((check) => check.ok || !check.required);
  if (!okAll && exitCode === JC_EXIT.ok) exitCode = JC_EXIT.toolFailure;
  const report = { ok: okAll, version: VERSION, mcpUrl: url, manifestHash: JC_MANIFEST.manifestHash, client: checks, server };
  if (out.json) {
    out.stdout(JSON.stringify(report, null, 2));
  } else {
    const serverChecks = (server?.checks as ClientCheck[] | undefined) ?? [];
    const line = (check: ClientCheck) => `${check.ok ? 'ok  ' : check.required ? 'FAIL' : 'warn'}  ${check.name.padEnd(24)} ${check.detail}`;
    out.stdout([`jace-commander doctor: ${okAll ? 'ok' : 'FAIL'}`, ...checks.map(line), ...serverChecks.map(line)].join('\n'));
  }
  return exitCode;
}

async function localStatus(config: JcConfig, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  const helper = await privilegedHelperAvailable({ sudoPath: config.sudoPath, helperPath: config.privilegedHelperPath });
  const mcpStatus = await loadMcpAuthStatus(mcpUrlFor(config, env), config.stateDir, env);
  return {
    version: VERSION,
    manifestHash: JC_MANIFEST.manifestHash,
    tools: JC_MANIFEST.tools.length,
    stateDir: config.stateDir,
    publicMcpUrl: config.publicMcpUrl,
    acsUrl: config.acsUrl,
    swarmUrl: config.swarmUrl,
    visualizerUrl: config.visualizerUrl ?? null,
    runtimeId: config.runtimeId,
    fsRoots: config.fsRoots,
    managedKeyConfigured: Boolean(config.acsPublicKey && config.acsKeyId),
    loggedIn: Boolean(loadCredentials(config.stateDir)),
    mcpConnected: mcpStatus.connected
      ? { mcpUrl: mcpStatus.mcpUrl, authMode: mcpStatus.authMode, expiresAt: mcpStatus.expiresAt, deviceId: mcpStatus.deviceId }
      : false,
    privilegedHelper: { path: config.privilegedHelperPath, sudoNonInteractive: helper },
  };
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, io?: Partial<Out>): Promise<number> {
  // --json is a global option only before `--`: after it, every argument
  // belongs to the invoked program (e.g. `jc sudo -- /usr/bin/tool --json`)
  // and must reach ACS for approval exactly as typed.
  const terminator = argv.indexOf('--');
  const options = terminator === -1 ? argv : argv.slice(0, terminator);
  const passthrough = terminator === -1 ? [] : argv.slice(terminator);
  const json = options.includes('--json');
  const words = [...options.filter((arg) => arg !== '--json'), ...passthrough];
  const out: Out = {
    json,
    stdout: io?.stdout ?? ((text) => console.log(text)),
    stderr: io?.stderr ?? ((text) => console.error(text)),
  };
  const [command, ...rest] = words;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    out.stdout(helpText());
    return JC_EXIT.ok;
  }
  if (command === 'version' || command === '--version') {
    const info = { version: VERSION, manifestVersion: JC_MANIFEST.version, manifestHash: JC_MANIFEST.manifestHash, tools: JC_MANIFEST.tools.length, cliCommands: CLI_COMMANDS.length };
    out.stdout(json ? JSON.stringify(info, null, 2) : `jace-commander ${VERSION} (manifest ${JC_MANIFEST.manifestHash.slice(0, 12)}, ${info.tools} tools)`);
    return JC_EXIT.ok;
  }
  const config = loadJcConfig(env);

  switch (command) {
    case 'serve': {
      const requested = flagValue(rest, '--preset') ?? env.JC_PRESET;
      if (requested !== undefined && !isJcPreset(requested)) {
        out.stderr(`jace-commander: unknown preset ${JSON.stringify(requested)} (expected ${JC_PRESETS.join(', ')})`);
        return JC_EXIT.invalidArguments;
      }
      if (rest.includes('--standalone') && requested !== undefined && requested !== 'standalone') {
        out.stderr('jace-commander: --standalone conflicts with --preset');
        return JC_EXIT.invalidArguments;
      }
      const mode: JcPreset = rest.includes('--standalone') ? 'standalone' : (requested ?? 'managed');
      if (mode === 'managed' && (!config.acsPublicKey || !config.acsKeyId)) {
        // Fail closed at startup rather than rejecting every call later.
        out.stderr('jace-commander: managed mode requires JC_ACS_PUBLIC_KEY and JC_ACS_KEY_ID (or pass --standalone for read-only local development, or --preset local)');
        return JC_EXIT.authorityUnavailable;
      }
      const server = createJcServer(config, mode);
      await server.connect(new StdioServerTransport());
      return -1; // keep running
    }
    case 'pending':
    case 'approve':
    case 'reject': {
      const decideSocket = env.JC_APPROVER_DECIDE_SOCKET ?? config.approverDecideSocket;
      const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
      return runApproveCommand(command, rest, {
        decideSocket,
        approverId: env.JC_APPROVER_ID,
        passkeyCeremony: (begin) => {
          const webauthn = begin.webauthn as Record<string, unknown>;
          return runLocalCeremony({
            mode: 'get',
            origin: String(webauthn.origin),
            options: { challenge: webauthn.challenge, rpId: webauthn.rpId, allowCredentials: webauthn.allowCredentials, userVerification: 'required', timeout: webauthn.timeoutMs },
            timeoutMs: Math.max(1, Number(webauthn.timeoutMs) || 0),
            summary: `Approve ${String(begin.approvalId)}\ninvocation ${String(begin.invocationHash)}`,
            onUrl: (url) => out.stderr(`Open on this machine and use your passkey: ${url}`),
          });
        },
        io: {
          stdout: out.stdout,
          stderr: out.stderr,
          isTty: terminal,
          prompt: async (question) => {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            try {
              return await rl.question(question);
            } finally {
              rl.close();
            }
          },
        },
      });
    }
    case 'auth':
      return runAuthCommand(rest, config, out, env);
    case 'connect':
      return runAuthCommand(['login', ...rest], config, out, env);
    case 'disconnect':
      return runAuthCommand(['logout', ...rest], config, out, env);
    case 'tools': {
      if (rest.includes('--remote')) {
        const url = mcpUrlFor(config, env);
        const client = new McpHttpClient({ url, auth: mcpAuthProvider(url, config.stateDir, env) });
        try {
          const tools = await client.listTools();
          out.stdout(json ? JSON.stringify(tools, null, 2) : tools.map((tool) => String(tool.name)).join('\n'));
          return JC_EXIT.ok;
        } catch (error) {
          const outcome = (error as { outcome?: JcCallOutcome }).outcome;
          if (!outcome) throw error;
          json ? out.stdout(JSON.stringify(outcomeJson(outcome), null, 2)) : out.stderr(renderRefusal(outcome));
          return outcome.exitCode;
        } finally {
          await client.close();
        }
      }
      const rows = JC_MANIFEST.tools.map(({ name, group, scopes, requiresApproval, cliCommands }) => ({ name, group, scopes, requiresApproval, cliCommands }));
      out.stdout(json ? JSON.stringify(rows, null, 2) : rows.map((row) => `${row.name.padEnd(22)} ${row.group.padEnd(11)} ${row.scopes.join(',').padEnd(20)} ${row.requiresApproval ? 'approval ' : '         '} ${row.cliCommands.join(', ')}`).join('\n'));
      return JC_EXIT.ok;
    }
    case 'login': {
      const acsUrl = flagValue(rest, '--acs-url') ?? config.acsUrl;
      const credentials = await deviceLogin({
        acsUrl,
        stateDir: config.stateDir,
        scope: flagValue(rest, '--scope'),
        env,
        onPrompt: ({ userCode, verificationUriComplete, expiresIn }) => {
          out.stderr('Approve this device in your browser:');
          out.stderr(`  ${verificationUriComplete}`);
          out.stderr(`  code: ${userCode}   (expires in ${Math.round(expiresIn / 60)} min)`);
          out.stderr('Waiting for approval...');
        },
      });
      out.stdout(`Logged in to ${credentials.acsUrl} as ${credentials.principal ?? 'unknown principal'} (scope: ${credentials.scope || 'n/a'})`);
      return JC_EXIT.ok;
    }
    case 'whoami': {
      const stored = loadCredentials(config.stateDir);
      const mcpStatus = await loadMcpAuthStatus(mcpUrlFor(config, env), config.stateDir, env);
      if (!stored && !mcpStatus.connected) {
        out.stdout(json ? JSON.stringify({ loggedIn: false, mcpConnected: false }) : 'not logged in');
        return JC_EXIT.notConnected;
      }
      out.stdout(JSON.stringify({
        acs: stored
          ? {
            acsUrl: stored.acsUrl,
            principal: stored.principal,
            deviceId: stored.deviceId,
            scope: stored.scope,
            expiresAt: new Date(stored.expiresAt).toISOString(),
            tokenType: stored.tokenType ?? 'DPoP',
            jkt: stored.jkt ?? null,
          }
          : null,
        mcp: mcpStatus.connected
          ? {
            mcpUrl: mcpStatus.mcpUrl,
            authMode: mcpStatus.authMode,
            sub: mcpStatus.sub,
            deviceId: mcpStatus.deviceId,
            jkt: mcpStatus.jkt,
            expiresAt: mcpStatus.expiresAt,
            refreshable: mcpStatus.refreshable,
            storageBackend: mcpStatus.storageBackend,
          }
          : null,
      }, null, 2));
      return JC_EXIT.ok;
    }
    case 'logout':
      await clearAcsCredentials(config.stateDir, env);
      out.stdout('logged out (local credential removed; revoke server-side via ACS if needed)');
      return JC_EXIT.ok;
    case 'doctor':
      return runDoctor(config, out, env);
    case 'status':
      if (rest.includes('--local')) {
        out.stdout(JSON.stringify(await localStatus(config, env), null, 2));
        return JC_EXIT.ok;
      }
      return runToolCommand(words, config, out, env);
    default:
      return runToolCommand(words, config, out, env);
  }
}

const isEntrypoint = process.argv[1] && /(?:^|[\\/])(?:cli\.js|jace-commander|jace|jc)$/u.test(process.argv[1]);
if (isEntrypoint) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code >= 0) process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`jace-commander: ${safeErrorMessage(error)}`);
      process.exitCode = JC_EXIT.toolFailure;
    },
  );
}
