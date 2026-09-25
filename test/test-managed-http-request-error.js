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


// Optional standalone SSE stream failures must not tear down the session
// (previously caused a ~1/s attach/detach flap against the ACS gateway).
for (const message of [
  'Failed to reconnect SSE stream: Streamable HTTP error: Failed to open SSE stream: ',
  'SSE stream disconnected: TypeError: terminated',
  'Failed to reconnect: fetch failed',
  'Maximum reconnection attempts (2) exceeded.',
]) {
  const sse = readyIntegration();
  sse.integration.handleManagedTransportError(new Error(message));
  assert.equal(sse.integration.ready, true, `SSE-only error must keep the session: ${message}`);
  assert.equal(sse.integration.mcpTransport?.id, 'transport');
  assert.deepEqual(sse.reasons, [], `SSE-only error must not notify disconnect: ${message}`);
}

// Look-alikes that are not SDK SSE-stream errors still disconnect.
for (const message of ['socket hang up: Failed to reconnect SSE stream:', 'ECONNRESET', 'fetch failed']) {
  const real = readyIntegration();
  real.integration.handleManagedTransportError(new Error(message));
  assert.equal(real.integration.ready, false, `non-SSE error must disconnect: ${message}`);
}

// SSE log is rate-limited to one line per minute with a suppressed count.
{
  const rl = readyIntegration();
  const lines = [];
  const orig = console.error;
  console.error = (...a) => lines.push(a.join(' '));
  try {
    rl.integration.logSseStreamError('Failed to reconnect SSE stream: x', 1_000_000);
    for (let i = 0; i < 5; i++) rl.integration.logSseStreamError('Failed to reconnect SSE stream: x', 1_000_000 + i * 1000);
    rl.integration.logSseStreamError('Failed to reconnect SSE stream: x', 1_000_000 + 61_000);
  } finally { console.error = orig; }
  assert.equal(lines.length, 2, 'one line per minute');
  assert.match(lines[1], /\[\+5 suppressed\]/);
}

console.log('managed SSE stream resilience tests passed');
