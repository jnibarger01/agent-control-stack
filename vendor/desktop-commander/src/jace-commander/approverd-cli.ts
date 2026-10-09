#!/usr/bin/env node
/**
 * approverd entrypoint (runs as the `jc-approverd` account).
 *
 *   approverd init --config /etc/jace-commander/approverd.json   create the signing key if absent
 *   approverd run  --config /etc/jace-commander/approverd.json   serve request.sock and decide.sock
 *
 * `init` prints the PUBLIC key and key id as JSON: the values for JC_APPROVER_PUBLIC_KEY /
 * JC_APPROVER_KEY_ID and for the root helper's config. The private key never leaves
 * the key file.
 */
import fs from 'node:fs';
import { Approverd, ensureApproverKey, type ApproverdConfig } from './approverd.js';

function loadConfig(file: string): ApproverdConfig {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  for (const key of ['runtimeId', 'stateDir', 'keyPath', 'keyId', 'requestSocket', 'decideSocket']) {
    if (typeof parsed[key] !== 'string' || (parsed[key] as string).length === 0) throw new Error(`approverd config.${key} is required`);
  }
  return parsed as unknown as ApproverdConfig;
}

async function main(argv: string[]): Promise<number> {
  const [command, flag, file] = argv;
  if ((command !== 'init' && command !== 'run') || flag !== '--config' || !file) {
    process.stderr.write('usage: approverd <init|run> --config <file>\n');
    return 2;
  }
  const config = loadConfig(file);
  const key = ensureApproverKey(config.keyPath, config.keyId);
  if (command === 'init') {
    process.stdout.write(`${JSON.stringify(key)}\n`);
    return 0;
  }
  const daemon = new Approverd(config);
  await daemon.start();
  process.stderr.write(`approverd: serving runtime ${config.runtimeId} key ${config.keyId}\n`);
  const stop = () => { void daemon.stop().then(() => process.exit(0)); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return -1;
}

main(process.argv.slice(2)).then((code) => { if (code >= 0) process.exit(code); }, (error) => {
  process.stderr.write(`approverd: ${error instanceof Error ? error.message : 'failed'}\n`);
  process.exit(1);
});
