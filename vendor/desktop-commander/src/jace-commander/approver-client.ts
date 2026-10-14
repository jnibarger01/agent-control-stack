/**
 * Clients for approverd's two sockets (ADR 0026 D4). One JSON line out, one back.
 * The JC server only ever talks to request.sock; the operator CLI only to decide.sock.
 * Any transport failure is `ApproverUnavailable`, which callers map to a fail-closed
 * `JC_LOCAL_APPROVAL_UNAVAILABLE` and never to an allow.
 */
import net from 'node:net';

export class ApproverUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApproverUnavailable';
  }
}

const MAX_REPLY_BYTES = 512 * 1024;

export function approverCall(socketPath: string, message: unknown, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffered = '';
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };
    socket.setTimeout(timeoutMs, () => done(() => reject(new ApproverUnavailable('approver timed out'))));
    socket.on('error', (error) => done(() => reject(new ApproverUnavailable(`approver unreachable (${(error as NodeJS.ErrnoException).code ?? 'error'})`))));
    socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      if (buffered.length > MAX_REPLY_BYTES) return done(() => reject(new ApproverUnavailable('approver reply too large')));
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      try {
        const reply = JSON.parse(buffered.slice(0, newline));
        if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) throw new Error('not an object');
        done(() => resolve(reply as Record<string, unknown>));
      } catch {
        done(() => reject(new ApproverUnavailable('approver sent a malformed reply')));
      }
    });
    socket.on('close', () => done(() => reject(new ApproverUnavailable('approver closed the connection'))));
  });
}

export type AuthorizeReply =
  | { state: 'granted'; approvalId: string; token: unknown }
  | { state: 'pending'; approvalId: string; expiresAt: string }
  | { state: 'rejected'; approvalId: string };

/** The JC server's view of approverd. */
export class ApproverClient {
  constructor(private readonly requestSocket: string, private readonly runtimeId: string, private readonly timeoutMs = 3000) {}

  async authorize(tool: string, args: Record<string, unknown>, principal?: string): Promise<AuthorizeReply> {
    const reply = await approverCall(this.requestSocket, { op: 'authorize', runtimeId: this.runtimeId, tool, arguments: args, ...(principal ? { principal } : {}) }, this.timeoutMs);
    if (reply.ok !== true) throw new ApproverUnavailable(`approver refused (${String(reply.code ?? 'unknown')})`);
    if (reply.state === 'granted' && typeof reply.approvalId === 'string') return { state: 'granted', approvalId: reply.approvalId, token: reply.token };
    if (reply.state === 'pending' && typeof reply.approvalId === 'string' && typeof reply.expiresAt === 'string') {
      return { state: 'pending', approvalId: reply.approvalId, expiresAt: reply.expiresAt };
    }
    if (reply.state === 'rejected' && typeof reply.approvalId === 'string') return { state: 'rejected', approvalId: reply.approvalId };
    throw new ApproverUnavailable('approver sent an unexpected reply');
  }

  async ping(): Promise<{ runtimeId: string; keyId: string }> {
    const reply = await approverCall(this.requestSocket, { op: 'ping' }, this.timeoutMs);
    if (reply.ok !== true || typeof reply.runtimeId !== 'string' || typeof reply.keyId !== 'string') throw new ApproverUnavailable('approver ping failed');
    return { runtimeId: reply.runtimeId, keyId: reply.keyId };
  }
}
