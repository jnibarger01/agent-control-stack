/**
 * `jace auth <subcommand>` CLI namespace for `/jc/mcp` OAuth 2.1 + PKCE + DPoP
 * and RFC 8628 headless device authentication.
 */
import type { JcConfig } from './config.js';
import {
  connect,
  connectDevice,
  forgetMcpToken,
  listJcDevices,
  loadMcpAuthStatus,
  refreshMcpSession,
  revokeJcDevice,
} from './mcp-auth.js';
import { JC_EXIT } from './mcp-http-client.js';
import { safeErrorMessage } from './secret-redaction.js';

export interface AuthCliOut {
  json: boolean;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === name) return argv[i + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

function mcpUrlFromArgs(argv: readonly string[], config: JcConfig, env: NodeJS.ProcessEnv): string {
  const raw = flagValue(argv, '--mcp-url') ?? env.JC_MCP_URL ?? config.publicMcpUrl;
  return raw.replace(/\/$/, '');
}

export async function runAuthCommand(
  argv: readonly string[],
  config: JcConfig,
  out: AuthCliOut,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const [sub, ...rest] = argv;
  const mcpUrl = mcpUrlFromArgs(rest, config, env);

  try {
    switch (sub) {
      case 'login': {
        const useDevice = rest.includes('--device') || rest.includes('--no-browser');
        const label = flagValue(rest, '--label');
        const scope = flagValue(rest, '--scope');
        const promptOut = out.json ? out.stderr : out.stdout;
        const stored = useDevice
          ? await connectDevice({
              mcpUrl,
              stateDir: config.stateDir,
              env,
              fetchImpl,
              ...(label ? { label } : {}),
              ...(scope ? { scope } : {}),
              onPrompt: ({ userCode, verificationUriComplete, expiresIn }) => {
                promptOut('Approve this device in your browser:');
                promptOut(`  ${verificationUriComplete}`);
                promptOut(`  code: ${userCode}   (expires in ${Math.round(expiresIn / 60)} min)`);
                promptOut('Waiting for approval...');
              },
            })
          : await connect({
              mcpUrl,
              stateDir: config.stateDir,
              env,
              fetchImpl,
              ...(label ? { label } : {}),
              ...(scope ? { scope } : {}),
              onAuthorizeUrl: (authorizeUrl) => {
                promptOut('Open this URL in a browser on this machine and approve with the gateway consent passphrase:');
                promptOut(`  ${authorizeUrl}`);
                promptOut('Waiting for approval...');
              },
            });
        const payload = {
          connected: true,
          auth_mode: 'dpop',
          mcp_url: stored.mcpUrl,
          issuer: stored.issuer ?? null,
          sub: stored.sub ?? null,
          device_id: stored.deviceId ?? null,
          jkt: stored.jkt ?? null,
          expires_at: new Date(stored.expiresAt).toISOString(),
          storage_backend: stored.storageBackend ?? null,
        };
        out.stdout(
          out.json
            ? JSON.stringify(payload, null, 2)
            : `Connected to ${stored.mcpUrl} (mode: DPoP, device: ${stored.deviceId ?? 'n/a'}, jkt: ${stored.jkt ?? 'n/a'}, store: ${stored.storageBackend ?? 'n/a'})`,
        );
        return JC_EXIT.ok;
      }

      case 'status': {
        const status = await loadMcpAuthStatus(mcpUrl, config.stateDir, env);
        const payload = {
          connected: status.connected,
          auth_mode: status.authMode,
          sub: status.sub,
          device_id: status.deviceId,
          jkt: status.jkt,
          expires_at: status.expiresAt,
          issuer: status.issuer,
          audience: status.audience,
          storage_backend: status.storageBackend,
          refreshable: status.refreshable,
          label: status.label,
          reauth_required: status.reauthRequired,
        };
        if (out.json) {
          out.stdout(JSON.stringify(payload, null, 2));
        } else if (!status.connected && status.authMode === 'not_connected') {
          out.stdout(`not connected to ${mcpUrl} (run \`jace auth login\`)`);
        } else {
          out.stdout(
            [
              `auth_mode:       ${payload.auth_mode}`,
              `sub:             ${payload.sub ?? 'n/a'}`,
              `device_id:       ${payload.device_id ?? 'n/a'}`,
              `jkt:             ${payload.jkt ?? 'n/a'}`,
              `expires_at:      ${payload.expires_at ?? 'n/a'}`,
              `issuer:          ${payload.issuer ?? 'n/a'}`,
              `audience:        ${payload.audience}`,
              `storage_backend: ${payload.storage_backend ?? 'n/a'}`,
              ...(payload.reauth_required ? [`reauth_required: ${payload.reauth_required.reason}`] : []),
            ].join('\n'),
          );
        }
        return status.connected ? JC_EXIT.ok : JC_EXIT.notConnected;
      }

      case 'refresh': {
        const outcome = await refreshMcpSession(mcpUrl, config.stateDir, env, fetchImpl);
        if (outcome.kind === 'token') {
          const status = await loadMcpAuthStatus(mcpUrl, config.stateDir, env);
          const payload = {
            refreshed: true,
            auth_mode: status.authMode,
            device_id: status.deviceId,
            jkt: status.jkt,
            expires_at: status.expiresAt,
          };
          out.stdout(out.json ? JSON.stringify(payload, null, 2) : `Refreshed ${mcpUrl} (expires ${status.expiresAt ?? 'unknown'})`);
          return JC_EXIT.ok;
        }
        if (outcome.kind === 'unavailable') {
          out.stderr(`refresh unavailable: ${safeErrorMessage(outcome.reason)}`);
          return JC_EXIT.authorityUnavailable;
        }
        out.stderr(`refresh failed (${outcome.kind}): run \`jace auth login\``);
        return JC_EXIT.notConnected;
      }

      case 'logout': {
        await forgetMcpToken(config.stateDir, env, mcpUrl);
        const msg =
          'Local credentials and device keypair removed (local-only; remote devices remain active until `jace auth revoke <device-id>`).';
        out.stdout(out.json ? JSON.stringify({ logged_out: true, local_only: true, note: msg }, null, 2) : msg);
        return JC_EXIT.ok;
      }

      case 'devices': {
        const devices = await listJcDevices(mcpUrl, config.stateDir, env, fetchImpl);
        if (out.json) {
          out.stdout(JSON.stringify({ devices }, null, 2));
        } else if (devices.length === 0) {
          out.stdout('no registered devices');
        } else {
          out.stdout(
            devices
              .map((d) => `${String(d.device_id ?? '')}  ${String(d.status ?? '')}  ${String(d.label ?? '')}  jkt=${String(d.jkt ?? '')}`)
              .join('\n'),
          );
        }
        return JC_EXIT.ok;
      }

      case 'revoke': {
        const deviceId = rest.find((arg) => !arg.startsWith('-'));
        if (!deviceId) {
          out.stderr('usage: jace auth revoke <device-id> [--mcp-url <url>]');
          return JC_EXIT.invalidArguments;
        }
        const res = await revokeJcDevice(mcpUrl, config.stateDir, deviceId, env, fetchImpl);
        out.stdout(out.json ? JSON.stringify(res, null, 2) : `Revoked device ${res.device_id}`);
        return JC_EXIT.ok;
      }

      default:
        out.stderr(
          'usage: jace auth <login|status|refresh|logout|devices|revoke> [options]\n' +
            '  login [--device] [--no-browser] [--mcp-url URL] [--label NAME]\n' +
            '  status [--json] [--mcp-url URL]\n' +
            '  refresh [--json] [--mcp-url URL]\n' +
            '  logout [--json] [--mcp-url URL]\n' +
            '  devices [--json] [--mcp-url URL]\n' +
            '  revoke <device-id> [--json] [--mcp-url URL]',
        );
        return JC_EXIT.invalidArguments;
    }
  } catch (error) {
    const safe = safeErrorMessage(error);
    if (out.json) {
      out.stdout(JSON.stringify({ ok: false, error: safe }, null, 2));
    } else {
      out.stderr(`jace auth ${sub ?? ''}: ${safe}`);
    }
    return JC_EXIT.toolFailure;
  }
}
