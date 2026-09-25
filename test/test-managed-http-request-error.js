import assert from 'node:assert/strict';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DesktopCommanderIntegration } from '../dist/remote-device/desktop-commander-integration.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

function readyIntegration() {
  const integration = new DesktopCommanderIntegration(false, 'https://managed.example/mcp');
  const reasons = [];
  integration.onDisconnect((reason) => reasons.push(reason));
  integration.isReady = true;
  integration.mcpClient = { id: 'client' };
  integration.mcpTransport = { id: 'transport' };
  return { integration, reasons };
}

const denied = readyIntegration();
denied.integration.handleManagedTransportError(
  new StreamableHTTPError(503, 'Error POSTing to endpoint: {"error":"managed_authorization_unavailable","code":"require_approval"}'),
);
assert.equal(denied.integration.ready, true, 'ACS fail-closed HTTP error must keep the session');
assert.equal(denied.integration.mcpClient?.id, 'client', 'request failure must not drop the MCP client');
assert.equal(denied.integration.mcpTransport?.id, 'transport', 'request failure must not drop the transport');
assert.deepEqual(denied.reasons, [], 'request failure must not notify disconnect');

const lost = readyIntegration();
lost.integration.handleManagedTransportError(new Error('socket hang up'));
assert.equal(lost.integration.ready, false, 'non-HTTP transport error must clear readiness');
assert.equal(lost.integration.mcpClient, null);
assert.equal(lost.integration.mcpTransport, null);
assert.deepEqual(lost.reasons, ['managed HTTP transport error: socket hang up']);

const closed = readyIntegration();
closed.integration.handleLocalDisconnect('managed HTTP transport closed');
assert.equal(closed.integration.ready, false, 'transport close must still disconnect');
assert.deepEqual(closed.reasons, ['managed HTTP transport closed']);

console.log('managed HTTP request-error tests passed');

const retried = new DesktopCommanderIntegration(false, 'https://managed.example/mcp');
let calls = 0;
let replacements = 0;
retried.isReady = true;
retried.mcpClient = {
  async callTool() {
    calls += 1;
    if (calls === 1) throw new Error('MCP error -32001: Request timed out');
    return { content: [{ type: 'text', text: 'DC_EXEC_OK' }] };
  },
};
retried.replaceManagedTransport = async () => {
  replacements += 1;
  retried.isReady = true;
};
const recovered = await retried.callClientTool('start_process', { command: "printf 'DC_EXEC_OK\\n'" });
assert.equal(replacements, 1, 'a timed-out managed request must replace the session once');
assert.equal(calls, 2, 'the tool must be retried exactly once');
assert.equal(recovered.content[0].text, 'DC_EXEC_OK');

console.log('managed HTTP timeout-retry test passed');

// Merge blocker #2 — single-flight replaceManagedTransport: several tool calls
// hitting the 8s managed timeout simultaneously must share ONE attach attempt.
// Uses the REAL implementation (not a stub): the internal attach is observed
// through a patched initializeManagedHttp counter.
const concurrent = new DesktopCommanderIntegration(false, 'https://managed.example/mcp');
let attachAttempts = 0;
let releaseAttach;
const attachGate = new Promise((resolve) => { releaseAttach = resolve; });
concurrent.initializeManagedHttp = async () => {
  attachAttempts += 1;
  await attachGate;
  concurrent.mcpTransport = { id: `transport-${attachAttempts}` };
  concurrent.mcpClient = { id: `client-${attachAttempts}` };
  concurrent.isReady = true;
};
const flights = [
  concurrent.replaceManagedTransport(),
  concurrent.replaceManagedTransport(),
  concurrent.replaceManagedTransport(),
];
// Give the microtask queue a beat: all three must have joined ONE flight.
await new Promise((resolve) => setImmediate(resolve));
assert.equal(attachAttempts, 1, 'concurrent replaces must start exactly one attach attempt');
releaseAttach();
await Promise.all(flights);
assert.equal(attachAttempts, 1, 'the shared flight must still be the only attach after settling');
assert.equal(concurrent.managedAttachFlight, null, 'the flight guard must clear after settling');
assert.equal(concurrent.isReady, true, 'the session must be ready after the shared attach');

// A replace racing an ensureReady-driven initialize must also join ONE attach.
const raced = new DesktopCommanderIntegration(false, 'https://managed.example/mcp');
let raceAttaches = 0;
raced.initializeManagedHttp = async () => {
  raceAttaches += 1;
  raced.mcpTransport = { id: `race-transport-${raceAttaches}` };
  raced.mcpClient = { id: `race-client-${raceAttaches}` };
  raced.isReady = true;
};
const initializeFlight = raced.initialize();
const replaceFlight = raced.replaceManagedTransport();
await Promise.all([initializeFlight, replaceFlight]);
assert.equal(raceAttaches, 1, 'initialize racing a replace must not attach twice');
assert.equal(raced.isReady, true);

console.log('managed HTTP single-flight replace tests passed');

