import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { acsPost } from '../managed.js';

const TOKEN = 'edge-acs-token-must-not-leak-0123456789';
const CHALLENGE = 'challenge-must-not-leak-AAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function capture() {
  const lines = [];
  const original = console.log;
  console.log = (line, ...rest) => {
    if (typeof line === 'string' && line.includes('"acs_post_timing"')) lines.push(line);
    else original(line, ...rest);
  };
  return { lines, restore: () => { console.log = original; } };
}

async function server(handler) {
  const seen = [];
  const s = http.createServer((req, res) => {
    seen.push(req.headers['x-acs-request-id']);
    req.resume();
    req.on('end', () => handler(req, res));
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}`, seen, close: () => new Promise((r) => s.close(r)) };
}

test('acsPost emits one correlated timing record per bootstrap call without secrets', async () => {
  const acs = await server((req, res) => { res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ challenge: CHALLENGE })); });
  const out = capture();
  try {
    const managed = { acsGatewayUrl: acs.url, acsGatewayToken: TOKEN, timeoutMs: 2000 };
    const result = await acsPost(managed, '/dc/runtime/bootstrap', { challenge: CHALLENGE });
    assert.equal(result.status, 201);
    await acsPost(managed, '/dc/capability/issue', {}); // untimed route: no record, no header
  } finally { out.restore(); await acs.close(); }
  assert.equal(out.lines.length, 1);
  const record = JSON.parse(out.lines[0]);
  assert.equal(record.event, 'acs_post_timing');
  assert.equal(record.operation, '/dc/runtime/bootstrap');
  assert.equal(record.outcome, 'ok');
  assert.equal(record.status, 201);
  assert.equal(record.correlationId, acs.seen[0]);
  assert.equal(acs.seen[1], undefined);
  for (const key of ['totalMs', 'firstByteMs', 'eventLoopDelayMaxMs', 'eventLoopDelayP99Ms']) assert.ok(record[key] >= 0, key);
  assert.ok(!out.lines[0].includes(TOKEN) && !out.lines[0].includes(CHALLENGE) && !out.lines[0].includes('Bearer'));
});

test('acsPost labels an edge-side timeout distinctly and still rejects', async () => {
  let release;
  const acs = await server((req, res) => { release = () => { res.writeHead(201); res.end('{}'); }; });
  const out = capture();
  try {
    await assert.rejects(
      acsPost({ acsGatewayUrl: acs.url, acsGatewayToken: TOKEN, timeoutMs: 100 }, '/dc/runtime/bootstrap/complete', {}),
      /acs issuance timeout/,
    );
  } finally { out.restore(); release?.(); await acs.close(); }
  assert.equal(out.lines.length, 1);
  const record = JSON.parse(out.lines[0]);
  assert.equal(record.outcome, 'edge_timeout');
  assert.equal(record.operation, '/dc/runtime/bootstrap/complete');
  assert.equal(record.firstByteMs, undefined);
});
