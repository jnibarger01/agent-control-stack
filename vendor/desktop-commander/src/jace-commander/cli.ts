#!/usr/bin/env node
/**
 * jace-commander CLI
 *
 *   jace-commander serve [--standalone]   stdio MCP server (spawned by the gateway bridge)
 *   jace-commander login [--acs-url URL]  ACS device-flow login (browser approve, CLI polls)
 *   jace-commander whoami                 show the stored ACS credential (no token printed)
 *   jace-commander logout                 delete the stored ACS credential
 *   jace-commander status                 local readiness: config, credential, sudo helper
 */
import fs from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadJcConfig } from './config.js';
import { credentialsPath, deviceLogin, loadCredentials } from './device-login.js';
import { privilegedHelperAvailable } from './privileged-client.js';
import { createJcServer } from './server.js';

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const [command = 'serve', ...rest] = process.argv.slice(2);
  const config = loadJcConfig();

  switch (command) {
    case 'serve': {
      const mode = rest.includes('--standalone') ? 'standalone' : 'managed';
      if (mode === 'managed' && (!config.acsPublicKey || !config.acsKeyId)) {
        // Fail closed at startup rather than rejecting every call later.
        console.error('jace-commander: managed mode requires JC_ACS_PUBLIC_KEY and JC_ACS_KEY_ID (or pass --standalone for local development)');
        process.exit(1);
      }
      const server = createJcServer(config, mode);
      await server.connect(new StdioServerTransport());
      return;
    }
    case 'login': {
      const acsUrl = flag(rest, '--acs-url') ?? config.acsUrl;
      const credentials = await deviceLogin({
        acsUrl,
        stateDir: config.stateDir,
        scope: flag(rest, '--scope'),
        onPrompt: ({ userCode, verificationUriComplete, expiresIn }) => {
          console.log('Approve this device in your browser:');
          console.log(`  ${verificationUriComplete}`);
          console.log(`  code: ${userCode}   (expires in ${Math.round(expiresIn / 60)} min)`);
          console.log('Waiting for approval...');
        },
      });
      console.log(`Logged in to ${credentials.acsUrl} as ${credentials.principal ?? 'unknown principal'} (scope: ${credentials.scope || 'n/a'})`);
      return;
    }
    case 'whoami': {
      const stored = loadCredentials(config.stateDir);
      if (!stored) {
        console.log('not logged in');
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify({
        acsUrl: stored.acsUrl,
        principal: stored.principal,
        deviceId: stored.deviceId,
        scope: stored.scope,
        expiresAt: new Date(stored.expiresAt).toISOString(),
        refreshable: Boolean(stored.refreshToken),
      }, null, 2));
      return;
    }
    case 'logout': {
      fs.rmSync(credentialsPath(config.stateDir), { force: true });
      console.log('logged out (local credential removed; revoke server-side via ACS if needed)');
      return;
    }
    case 'status': {
      const helper = await privilegedHelperAvailable({ sudoPath: config.sudoPath, helperPath: config.privilegedHelperPath });
      console.log(JSON.stringify({
        stateDir: config.stateDir,
        publicMcpUrl: config.publicMcpUrl,
        acsUrl: config.acsUrl,
        swarmUrl: config.swarmUrl,
        visualizerUrl: config.visualizerUrl ?? null,
        runtimeId: config.runtimeId,
        managedKeyConfigured: Boolean(config.acsPublicKey && config.acsKeyId),
        loggedIn: Boolean(loadCredentials(config.stateDir)),
        privilegedHelper: { path: config.privilegedHelperPath, sudoNonInteractive: helper },
      }, null, 2));
      return;
    }
    default:
      console.error(`unknown command: ${command}`);
      process.exit(2);
  }
}

main().catch((error) => {
  console.error(`jace-commander: ${(error as Error).message}`);
  process.exit(1);
});
