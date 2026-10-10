/**
 * approverd — the local human-approval authority for Jace Commander (ADR 0026 D4).
 *
 * Runs under its OWN OS identity (`jc-approverd`), separate from the unprivileged
 * JC server (`jc`) and from the human operator. It is the only holder of the
 * jc.local.v1 signing key and the only signing code in this package.
 *
 * Node has no portable SO_PEERCRED, so identity separation is the filesystem:
 *
 *   <runDir>/request/request.sock   group `jc`           0660   JC server: authorize, ping
 *   <runDir>/decide/decide.sock     group `jc-approvers` 0660   operator:  list, show, decide
 *
 * Each socket sits in its own 0750 directory owned by the matching group, so the
 * `jc` account (and therefore the model and every child of the server) cannot
 * even traverse to decide.sock, and approvers cannot reach request.sock. The two
 * sockets serve disjoint operations; an op sent to the wrong socket is refused.
 *
 * Flow (approval lifetime is separate from execution lifetime):
 *   authorize(tool,args)  -> state `pending`  (a request record, TTL ~15 min)
 *   human `decide`        -> `approved`       (bound to the exact invocation hash)
 *   authorize(same call)  -> state `granted`  (claims the approval ONCE and mints a
 *                                              jc.local.v1 token valid <= 30 s)
 * A claimed approval is consumed: a failed execution, a changed argument or a
 * second call needs a new approval. Every transition is appended to a
 * hash-chained audit log; if it cannot be written nothing is approved or minted.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { jcAuthorizationArguments } from './contract.js';
import {
  JC_LOCAL_MAX_TTL_MS,
  JC_LOCAL_TOKEN_VERSION,
  computeLocalInvocationHash,
  localTokenSigningBytes,
} from './local-token.js';
import { JsonlTraceChain, readTraceFile, verifyChain } from './looptrace.js';
import { jcRiskClassOf } from './providers.js';

export const DEFAULT_APPROVAL_TTL_MS = 15 * 60_000;
export const DEFAULT_TOKEN_TTL_MS = 25_000;
export const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_PENDING = 64;
const SOCKET_IDLE_MS = 5_000;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface ApproverdConfig {
  runtimeId: string;
  /** Pending/approved records and the audit chain. Owned by approverd, mode 0700. */
  stateDir: string;
  /** PKCS8 DER (base64url) Ed25519 private key, mode 0600, owned by approverd. */
  keyPath: string;
  keyId: string;
  requestSocket: string;
  decideSocket: string;
  /** Group (name or numeric gid) that may reach request.sock (the `jc` server account). */
  requestGroup?: string | number;
  /** Group (name or numeric gid) that may reach decide.sock (human approvers). */
  decideGroup?: string | number;
  approvalTtlMs?: number;
  tokenTtlMs?: number;
  maxPending?: number;
}

export interface ApproverdDeps {
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'claimed' | 'expired';

export interface ApprovalRecord {
  id: string;
  runtimeId: string;
  tool: string;
  riskClass: string;
  arguments: Record<string, unknown>;
  invocationHash: string;
  /** Authenticated caller that requested it (gateway sub|client); approval cannot move between callers. */
  principal?: string;
  requestedAt: string;
  expiresAt: string;
  status: ApprovalStatus;
  decidedAt?: string;
  approverId?: string;
  claimedAt?: string;
  tokenId?: string;
  /** A rejection is reported to the requester exactly once. */
  rejectionReported?: boolean;
}

// ---- keys -----------------------------------------------------------------

export interface ApproverKeyInfo {
  keyId: string;
  /** base64url SPKI DER: the value JC_APPROVER_PUBLIC_KEY / the helper config carry. */
  publicKey: string;
}

/** Creates the signing key (0600) if absent and returns its public half. Idempotent. */
export function ensureApproverKey(keyPath: string, keyId: string): ApproverKeyInfo {
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(keyPath)) {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const der = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
    const fd = fs.openSync(keyPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, der);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  const key = loadPrivateKey(keyPath);
  const publicKey = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64url');
  return { keyId, publicKey };
}

function loadPrivateKey(keyPath: string): crypto.KeyObject {
  const stat = fs.statSync(keyPath);
  if ((stat.mode & 0o077) !== 0) throw new Error(`approver key ${keyPath} must not be readable by group or others`);
  const key = crypto.createPrivateKey({ key: Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'base64url'), format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('approver key must be Ed25519');
  return key;
}

export interface MintInput {
  privateKey: crypto.KeyObject;
  keyId: string;
  runtimeId: string;
  tool: string;
  invocationHash: string;
  approvalId: string;
  approverId: string;
  tokenId: string;
  nonce: string;
  now: number;
  ttlMs: number;
}

/** The only signing code for jc.local.v1. */
export function signLocalToken(input: MintInput): { keyId: string; payload: Record<string, unknown>; signature: string } {
  if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1 || input.ttlMs > JC_LOCAL_MAX_TTL_MS) throw new RangeError('token ttl must be in [1, 30000] ms');
  const payload = {
    version: JC_LOCAL_TOKEN_VERSION,
    tokenId: input.tokenId,
    approvalId: input.approvalId,
    runtimeId: input.runtimeId,
    tool: input.tool,
    invocationHash: input.invocationHash,
    approverId: input.approverId,
    issuedAt: new Date(input.now).toISOString(),
    expiresAt: new Date(input.now + input.ttlMs).toISOString(),
    nonce: input.nonce,
  };
  const signature = crypto.sign(null, localTokenSigningBytes(payload), input.privateKey).toString('base64url');
  return { keyId: input.keyId, payload, signature };
}

// ---- the approver ----------------------------------------------------------

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class Approverd {
  private readonly now: () => number;
  private readonly rand: (size: number) => Buffer;
  private readonly records = new Map<string, ApprovalRecord>();
  private readonly approvalsDir: string;
  private readonly audit: JsonlTraceChain;
  private privateKey: crypto.KeyObject | undefined;
  private servers: net.Server[] = [];

  constructor(private readonly config: ApproverdConfig, deps: ApproverdDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.rand = deps.randomBytes ?? ((size) => crypto.randomBytes(size));
    if (!ID_PATTERN.test(config.runtimeId)) throw new TypeError('runtimeId must match the ID grammar');
    this.approvalsDir = path.join(config.stateDir, 'approvals');
    this.audit = new JsonlTraceChain(path.join(config.stateDir, 'audit.jsonl'), 'jc-approverd');
  }

  // -- lifecycle --

  async start(): Promise<void> {
    fs.mkdirSync(this.approvalsDir, { recursive: true, mode: 0o700 });
    this.privateKey = loadPrivateKey(this.config.keyPath);
    // The request group (the server identity) and the decide group (humans) must be disjoint,
    // or the model could reach decide.sock and approve its own requests.
    const requestGid = resolveGid(this.config.requestGroup);
    const decideGid = resolveGid(this.config.decideGroup);
    if (requestGid !== undefined && requestGid === decideGid) {
      throw new Error('requestGroup and decideGroup resolve to the same group; refusing to start');
    }
    this.loadRecords();
    this.servers = [
      await this.listen(this.config.requestSocket, this.config.requestGroup, (message) => this.handleRequestOp(message)),
      await this.listen(this.config.decideSocket, this.config.decideGroup, (message) => this.handleDecideOp(message)),
    ];
  }

  async stop(): Promise<void> {
    await Promise.all(this.servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    this.servers = [];
    for (const socket of [this.config.requestSocket, this.config.decideSocket]) fs.rmSync(socket, { force: true });
  }

  // -- request socket (the JC server) --

  handleRequestOp(message: unknown): Json {
    if (!isRecord(message) || typeof message.op !== 'string') return { ok: false, code: 'INVALID_REQUEST' };
    if (message.op === 'ping') return { ok: true, runtimeId: this.config.runtimeId, keyId: this.config.keyId };
    if (message.op !== 'authorize') return { ok: false, code: 'UNKNOWN_OP' };
    return this.authorize(message);
  }

  private authorize(message: Json): Json {
    const { runtimeId, tool } = message;
    if (runtimeId !== this.config.runtimeId) return { ok: false, code: 'RUNTIME_MISMATCH' };
    if (typeof tool !== 'string') return { ok: false, code: 'INVALID_REQUEST' };
    const riskClass = jcRiskClassOf(tool);
    // Reads never need approval; an unknown tool is never approvable.
    if (!riskClass || riskClass === 'read') return { ok: false, code: 'INVALID_REQUEST' };
    let args: Record<string, unknown>;
    let invocationHash: string;
    try {
      args = jcAuthorizationArguments(message.arguments);
      invocationHash = computeLocalInvocationHash(this.config.runtimeId, tool, args);
    } catch {
      return { ok: false, code: 'INVALID_REQUEST' };
    }
    const principal = typeof message.principal === 'string' && message.principal.length > 0 && message.principal.length <= 320 ? message.principal : '';
    if (message.principal !== undefined && principal === '') return { ok: false, code: 'INVALID_REQUEST' };
    this.expireStale();
    const live = [...this.records.values()].filter((record) => record.invocationHash === invocationHash && (record.principal ?? '') === principal);
    const approved = live.find((record) => record.status === 'approved');
    if (approved) return this.claim(approved);
    const pending = live.find((record) => record.status === 'pending');
    if (pending) return { ok: true, state: 'pending', approvalId: pending.id, expiresAt: pending.expiresAt };
    const rejected = live.find((record) => record.status === 'rejected' && !record.rejectionReported);
    if (rejected) {
      rejected.rejectionReported = true;
      this.persist(rejected);
      return { ok: true, state: 'rejected', approvalId: rejected.id };
    }
    const openCount = [...this.records.values()].filter((record) => record.status === 'pending').length;
    if (openCount >= (this.config.maxPending ?? MAX_PENDING)) return { ok: false, code: 'TOO_MANY_PENDING' };

    const now = this.now();
    const record: ApprovalRecord = {
      id: `apr-${this.rand(9).toString('base64url')}`,
      runtimeId: this.config.runtimeId,
      tool,
      riskClass,
      arguments: args,
      invocationHash,
      ...(principal ? { principal } : {}),
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (this.config.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS)).toISOString(),
      status: 'pending',
    };
    if (!this.auditAppend('approval_requested', { approvalId: record.id, tool, riskClass, invocationHash, ...(principal ? { principal } : {}) })) return { ok: false, code: 'AUDIT_UNAVAILABLE' };
    this.records.set(record.id, record);
    this.persist(record);
    return { ok: true, state: 'pending', approvalId: record.id, expiresAt: record.expiresAt };
  }

  /** Consumes an approved record exactly once and mints the execution token. */
  private claim(record: ApprovalRecord): Json {
    const now = this.now();
    const tokenId = `tok-${this.rand(9).toString('base64url')}`;
    // Audit BEFORE minting: no durable record, no token.
    if (!this.auditAppend('approval_decision', { approvalId: record.id, action: 'claimed', tokenId, invocationHash: record.invocationHash })) {
      return { ok: false, code: 'AUDIT_UNAVAILABLE' };
    }
    record.status = 'claimed';
    record.claimedAt = new Date(now).toISOString();
    record.tokenId = tokenId;
    // The claimed state must be durable BEFORE authority leaves the daemon; otherwise a crash
    // could revert the file to `approved` and let the same approval mint a second token.
    try {
      this.persist(record);
    } catch {
      return { ok: false, code: 'PERSIST_UNAVAILABLE' };
    }
    const token = signLocalToken({
      privateKey: this.privateKey as crypto.KeyObject,
      keyId: this.config.keyId,
      runtimeId: record.runtimeId,
      tool: record.tool,
      invocationHash: record.invocationHash,
      approvalId: record.id,
      approverId: record.approverId ?? 'unknown',
      tokenId,
      nonce: this.rand(32).toString('base64url'),
      now,
      ttlMs: Math.min(this.config.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS, JC_LOCAL_MAX_TTL_MS),
    });
    return { ok: true, state: 'granted', approvalId: record.id, token };
  }

  // -- decide socket (the human operator) --

  handleDecideOp(message: unknown): Json {
    if (!isRecord(message) || typeof message.op !== 'string') return { ok: false, code: 'INVALID_REQUEST' };
    this.expireStale();
    switch (message.op) {
      case 'list':
        return {
          ok: true,
          pending: [...this.records.values()].filter((record) => record.status === 'pending').map((record) => ({
            id: record.id, tool: record.tool, riskClass: record.riskClass, requestedAt: record.requestedAt, expiresAt: record.expiresAt, invocationHash: record.invocationHash,
          })),
        };
      case 'show': {
        const record = typeof message.id === 'string' ? this.records.get(message.id) : undefined;
        return record ? { ok: true, approval: record } : { ok: false, code: 'NOT_FOUND' };
      }
      case 'decide':
        return this.decide(message);
      default:
        return { ok: false, code: 'UNKNOWN_OP' };
    }
  }

  private decide(message: Json): Json {
    const record = typeof message.id === 'string' ? this.records.get(message.id) : undefined;
    if (!record) return { ok: false, code: 'NOT_FOUND' };
    if (message.decision !== 'approve' && message.decision !== 'reject') return { ok: false, code: 'INVALID_REQUEST' };
    if (typeof message.approverId !== 'string' || !ID_PATTERN.test(message.approverId)) return { ok: false, code: 'INVALID_REQUEST' };
    if (record.status !== 'pending') return { ok: false, code: record.status === 'expired' ? 'EXPIRED' : 'NOT_PENDING' };
    // The human must have seen THIS invocation: the client echoes its hash.
    if (message.confirmHash !== record.invocationHash) return { ok: false, code: 'CONFIRMATION_MISMATCH' };
    const action = message.decision === 'approve' ? 'approved' : 'rejected';
    if (!this.auditAppend('approval_decision', { approvalId: record.id, action, approverId: message.approverId,
      // Node has no SO_PEERCRED: the socket group proves only that SOME decide-group member acted.
      approverIdAssurance: 'self-asserted', invocationHash: record.invocationHash })) {
      return { ok: false, code: 'AUDIT_UNAVAILABLE' };
    }
    record.status = action;
    record.decidedAt = new Date(this.now()).toISOString();
    record.approverId = message.approverId;
    this.persist(record);
    return { ok: true, approvalId: record.id, status: record.status };
  }

  // -- internals --

  private expireStale(): void {
    const now = this.now();
    for (const record of this.records.values()) {
      if ((record.status === 'pending' || record.status === 'approved') && Date.parse(record.expiresAt) <= now) {
        record.status = 'expired';
        this.persist(record);
      }
    }
  }

  private auditAppend(type: 'approval_requested' | 'approval_decision', payload: Record<string, unknown>): boolean {
    try {
      this.audit.append(type, payload, new Date(this.now()).toISOString());
      return true;
    } catch {
      return false;
    }
  }

  private persist(record: ApprovalRecord): void {
    const target = path.join(this.approvalsDir, `${record.id}.json`);
    const temp = `${target}.${process.pid}.tmp`;
    const fd = fs.openSync(temp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(record));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, target);
    const dirFd = fs.openSync(this.approvalsDir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  }

  /**
   * Restores persisted approvals, trusting NOTHING on disk by itself: each record must be fully
   * shaped, its invocation hash must recompute from its own runtime/tool/arguments/principal, and
   * its state must be backed by the hash-chained audit log. A broken audit chain restores nothing.
   */
  private loadRecords(): void {
    const auditPath = path.join(this.config.stateDir, 'audit.jsonl');
    const requested = new Map<string, string>();
    const decided = new Map<string, Map<string, string>>();
    if (fs.existsSync(auditPath)) {
      const parsed = readTraceFile(auditPath);
      if (parsed.parseError || !verifyChain(parsed.events).ok) return;
      for (const event of parsed.events as Array<{ type: string; payload: Record<string, unknown> }>) {
        const id = event.payload.approvalId;
        const hash = event.payload.invocationHash;
        if (typeof id !== 'string' || typeof hash !== 'string') continue;
        if (event.type === 'approval_requested') requested.set(id, hash);
        if (event.type === 'approval_decision' && typeof event.payload.action === 'string') {
          const actions = decided.get(id) ?? new Map<string, string>();
          actions.set(event.payload.action, hash);
          decided.set(id, actions);
        }
      }
    }
    for (const entry of fs.readdirSync(this.approvalsDir)) {
      if (!entry.endsWith('.json')) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(this.approvalsDir, entry), 'utf8')) as ApprovalRecord;
        if (!this.persistedRecordValid(record, requested, decided)) continue;
        // The audit is the durable truth: a consumed approval must never be restored as usable.
        if (decided.get(record.id)?.has('claimed') && record.status !== 'claimed') record.status = 'claimed';
        this.records.set(record.id, record);
      } catch {
        // An unreadable record is dropped: it can only mean "no approval", never an approval.
      }
    }
  }

  private persistedRecordValid(record: ApprovalRecord, requested: Map<string, string>, decided: Map<string, Map<string, string>>): boolean {
    if (!record || typeof record !== 'object') return false;
    if (typeof record.id !== 'string' || !ID_PATTERN.test(record.id)) return false;
    if (record.runtimeId !== this.config.runtimeId) return false;
    if (typeof record.tool !== 'string' || jcRiskClassOf(record.tool) !== record.riskClass || record.riskClass === 'read') return false;
    if (!['pending', 'approved', 'rejected', 'expired', 'claimed'].includes(record.status)) return false;
    if (!Number.isFinite(Date.parse(record.requestedAt)) || !Number.isFinite(Date.parse(record.expiresAt))) return false;
    if (record.principal !== undefined && typeof record.principal !== 'string') return false;
    let expected: string;
    try {
      expected = computeLocalInvocationHash(record.runtimeId, record.tool, jcAuthorizationArguments(record.arguments));
    } catch {
      return false;
    }
    if (record.invocationHash !== expected) return false;
    // Every record needs its request in the audit; approved/rejected/claimed need that decision too.
    if (requested.get(record.id) !== record.invocationHash) return false;
    const needed = record.status === 'approved' ? 'approved' : record.status === 'rejected' ? 'rejected' : record.status === 'claimed' ? 'claimed' : undefined;
    if (needed && decided.get(record.id)?.get(needed) !== record.invocationHash) return false;
    return true;
  }

  private listen(socketPath: string, group: string | number | undefined, handle: (message: unknown) => Json): Promise<net.Server> {
    const dir = path.dirname(socketPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    fs.chmodSync(dir, 0o750);
    const gid = resolveGid(group);
    if (gid !== undefined) fs.chownSync(dir, -1, gid);
    if (fs.existsSync(socketPath)) {
      if (!fs.lstatSync(socketPath).isSocket()) throw new Error(`${socketPath} exists and is not a socket`);
      fs.rmSync(socketPath);
    }
    const server = net.createServer((connection) => {
      connection.setTimeout(SOCKET_IDLE_MS, () => connection.destroy());
      let buffered = '';
      let handled = false;
      connection.on('data', (chunk) => {
        if (handled) return;
        buffered += chunk.toString('utf8');
        if (buffered.length > MAX_MESSAGE_BYTES) {
          connection.destroy();
          return;
        }
        const newline = buffered.indexOf('\n');
        if (newline < 0) return;
        handled = true;
        let reply: Json;
        try {
          reply = handle(JSON.parse(buffered.slice(0, newline)));
        } catch {
          reply = { ok: false, code: 'INVALID_REQUEST' };
        }
        connection.end(`${JSON.stringify(reply)}\n`);
      });
      connection.on('error', () => { /* a dropped peer must never crash the approver */ });
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      const previous = process.umask(0o007);
      server.listen(socketPath, () => {
        process.umask(previous);
        fs.chmodSync(socketPath, 0o660);
        if (gid !== undefined) fs.chownSync(socketPath, -1, gid);
        resolve(server);
      });
    });
  }
}

function resolveGid(group: string | number | undefined): number | undefined {
  if (group === undefined) return undefined;
  if (typeof group === 'number') return group;
  if (/^\d+$/.test(group)) return Number(group);
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(group)) throw new Error(`invalid group name ${group}`);
  const line = execFileSync('getent', ['group', group], { encoding: 'utf8' }).trim();
  const gid = Number(line.split(':')[2]);
  if (!Number.isInteger(gid)) throw new Error(`cannot resolve group ${group}`);
  return gid;
}
