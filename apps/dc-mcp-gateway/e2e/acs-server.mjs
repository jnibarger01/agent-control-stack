#!/usr/bin/env node
/**
 * ACS capability issuer for the certification E2E: the real built ACS gateway
 * (apps/gateway dist buildGateway) on loopback, with three credentials:
 *   mr (service, acs:write)  -> Mission Router webhook ingest
 *   svc (service, acs:write) -> mcp-gateway capability issuance + bootstrap
 *   dc-bridge (service+worker, actorId acs-dc-bridge, acs:worker)
 *                            -> canonical attempt-bound result submission
 * Capability signing/containment come from the ACS capability env, so the
 * gateway issues acs.dc.v1 envelopes exactly as production would.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Resolved by absolute path so the shim can run from any directory against the
// real built artifacts of the agent-control-stack workspace.
const { buildGateway } = await import('file:///home/jacen/projects/agent-control-stack/apps/gateway/dist/index.js');
const { SqliteWorkItemStore } = await import('file:///home/jacen/projects/agent-control-stack/packages/work-items/dist/index.js');

const dir = mkdtempSync(join(tmpdir(), 'acs-cert-'));
const dbPath = process.env.ACS_DB_PATH || join(dir, 'control.db');
const root = process.env.ACS_E2E_WORKSPACE_ROOT;
if (!root) {
  console.error('acs-server: ACS_E2E_WORKSPACE_ROOT is required');
  process.exit(1);
}

const credentials = JSON.parse(process.env.ACS_GATEWAY_CREDENTIALS_JSON);

// Seed registry actors for the service principals.
const seed = new SqliteWorkItemStore(dbPath);
try {
  for (const actorId of ['mission-router', 'acs-gateway-service', 'acs-dc-bridge']) {
    try {
      seed.registerActor({ id: actorId, actorType: 'SERVICE', displayName: actorId });
    } catch (error) {
      if (!/exist/i.test(String(error))) throw error;
    }
  }
} finally {
  seed.close();
}

const app = buildGateway({ dbPath, logger: false, auth: { credentials } });
const port = parseInt(process.env.ACS_PORT || '8900', 10);
await app.listen({ port, host: '127.0.0.1' });
console.log(`acs-cert: listening on http://127.0.0.1:${port} (db ${dbPath})`);

async function shutdown() {
  await app.close();
  process.exit(0);
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => shutdown());
