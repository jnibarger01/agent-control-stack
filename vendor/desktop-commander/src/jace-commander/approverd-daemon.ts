/**
 * Isolated approverd Unix-socket service.
 * Deployment MUST run as the dedicated jc-approverd OS account, NOT as root,
 * the JC service user, or the operator login user. Operator signing credentials
 * never live on this host; approverd holds only the operator PUBLIC key.
 * The daemon's own Ed25519 private key is mode 0600, owned by jc-approverd.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { JsonlTraceChain } from './looptrace.js';
import { JcApproverdService } from './approverd-service.js';
import type { SignedJcHumanAssertion } from './human-assertion.js';
import { readRootControlledJcFile } from './local-policy.js';

const SOCKET = '/run/jace-commander/approverd.sock';
const PRIVATE_KEY = '/var/lib/jc-approverd/signing-private.pem';
const OPERATOR_KEY = '/etc/jace-commander/operator-public.pem';
const AUDIT = '/var/lib/jc-approverd/audit.jsonl';
const MAX_REQUEST = 32 * 1024;
const MAX_IN_FLIGHT = 20;
function loadPrivateKey(): crypto.KeyObject {
  const st = fs.lstatSync(PRIVATE_KEY);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0 || st.size > 8192)
    throw new Error('JC_APPROVERD_PRIVATE_KEY_UNTRUSTED');
  return crypto.createPrivateKey(fs.readFileSync(PRIVATE_KEY));
}
function verifyServerIdentity(): void {
  if (process.getuid?.() === 0 || os.userInfo().username !== 'jc-approverd')
    throw new Error('JC_APPROVERD_WRONG_IDENTITY');
  const dir = path.dirname(SOCKET);
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o007) !== 0 ||
      (st.mode & 0o020) !== 0 || (st.uid !== 0 && st.uid !== process.getuid()))
    throw new Error('JC_APPROVERD_SOCKET_DIRECTORY_UNTRUSTED');
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function errorCode(e: unknown): string {
  if (e instanceof Error && /^JC_[A-Z_]+$/.test(e.message)) return e.message;
  return 'JC_APPROVERD_REJECTED';
}
/** Main entrypoint for an operator-installed dedicated-identity systemd unit. */
export function startJcApproverd(): net.Server {
  verifyServerIdentity();
  if (fs.existsSync(SOCKET)) throw new Error('JC_APPROVERD_SOCKET_ALREADY_EXISTS');
  const approver = new JcApproverdService(
    loadPrivateKey(),
    crypto.createPublicKey(readRootControlledJcFile(OPERATOR_KEY, 8192)),
    new JsonlTraceChain(AUDIT, 'jc-approverd'),
  );
  let inFlight = 0;
  const server = net.createServer(socket => {
    if (++inFlight > MAX_IN_FLIGHT) {
      inFlight--; socket.destroy(); return;
    }
    socket.setTimeout(10_000, () => socket.destroy());
    let input = '';
    let done = false;
    const finish = (data: Record<string, unknown>): void => {
      if (done) return;
      done = true;
      socket.end(JSON.stringify(data) + '\n');
    };
    socket.on('data', chunk => {
      if (done) return;
      input += chunk.toString('utf8');
      if (input.length > MAX_REQUEST) { finish({ ok: false, code: 'JC_APPROVERD_TOO_LARGE' }); return; }
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      if (input.slice(newline + 1).trim()) { finish({ ok: false, code: 'JC_APPROVERD_MULTIPLE_REQUESTS' }); return; }
      let request: unknown;
      try { request = JSON.parse(input.slice(0, newline)); }
      catch { finish({ ok: false, code: 'JC_APPROVERD_INVALID_JSON' }); return; }
      void (async () => {
        try {
          if (!isRecord(request)) throw new Error('JC_APPROVERD_INVALID_REQUEST');
          if (request.op === 'request') {
            if (typeof request.tool !== 'string' || typeof request.runtimeId !== 'string' ||
                !isRecord(request.arguments)) throw new Error('JC_APPROVERD_INVALID_REQUEST');
            finish({ ok: true, pending: approver.request(request.tool, request.arguments, request.runtimeId) });
          } else if (request.op === 'approve') {
            if (!isRecord(request.assertion) || !isRecord(request.assertion.payload) ||
                typeof request.assertion.signature !== 'string') throw new Error('JC_APPROVERD_INVALID_REQUEST');
            // Human authorization is verified cryptographically in approver,
            // independently of the socket caller's UID or apparent TTY.
            const token = await approver.approveAndIssue(request.assertion as unknown as SignedJcHumanAssertion);
            finish({ ok: true, capability: token });
          } else throw new Error('JC_APPROVERD_UNKNOWN_OPERATION');
        } catch (e) { finish({ ok: false, code: errorCode(e) }); }
      })();
    });
    socket.on('close', () => { inFlight--; });
    socket.on('error', () => {});
  });
  server.listen(SOCKET, () => fs.chmodSync(SOCKET, 0o660));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  startJcApproverd();
}
