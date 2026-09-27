import crypto from 'node:crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export type PairingState = 'PENDING' | 'VERIFIED' | 'CONSUMED' | 'EXPIRED' | 'REJECTED';

/** Public projection of a pairing row. Never carries the nonce hash or the sealed code. */
export interface PairingSession {
  session_id: string;
  device_code: string;
  user_code: string;
  device_id?: string | null;
  device_name: string;
  code_challenge: string;
  created_at: string;
  expires_at: string;
  state: PairingState;
  verified_at: string | null;
  consumed_at: string | null;
}

export interface PairingStartInput {
  device_name: string;
  device_id?: string;
  code_challenge: string;
  expires_in: number;
}

/** Outcome of the OAuth redirect landing on /device/callback. */
export type PairingCallbackResult = 'verified' | 'rejected' | 'expired' | 'invalid' | 'unknown';

/** Outcome of the device poll after the plane has checked PKCE. */
export type PairingConsumeResult =
  | { kind: 'code'; sealed_code: string; device_id: string | null }
  | { kind: 'pending' | 'expired' | 'rejected' | 'consumed' | 'unknown' };

/**
 * The pairing state machine. Every transition below is atomic in the durable
 * adapter (one security-definer RPC each); the in-memory adapter mirrors it.
 *
 *   PENDING --callback(valid nonce)--> VERIFIED (sealed code, code TTL)
 *   PENDING --callback(error)--------> REJECTED
 *   VERIFIED --callback(replay)------> REJECTED + wipe
 *   VERIFIED --poll------------------> CONSUMED + wipe (returns sealed code once)
 *   VERIFIED --poll after code TTL---> EXPIRED + wipe
 */
export interface PairingStore {
  create(input: PairingStartInput): Promise<PairingSession>;
  get(sessionId: string): Promise<PairingSession | null>;
  findByDeviceCode(deviceCode: string): Promise<PairingSession | null>;
  /** Binds a fresh OAuth state nonce (hash only) to a live PENDING session. */
  setStateNonce(sessionId: string, nonceHash: string): Promise<boolean>;
  storeCode(sessionId: string, nonceHash: string, sealedCode: string, codeTtlSeconds: number): Promise<PairingCallbackResult>;
  reject(sessionId: string, nonceHash: string): Promise<PairingCallbackResult>;
  consume(sessionId: string): Promise<PairingConsumeResult>;
}

const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIRING_TTL_SECONDS = 900;
export const PAIRING_CODE_TTL_SECONDS = 120;
const PUBLIC_COLUMNS = 'session_id,device_code,user_code,device_id,device_name,code_challenge,created_at,expires_at,state,verified_at,consumed_at';

function randomValue(bytes: number): string { return crypto.randomBytes(bytes).toString('base64url'); }
function randomUserCode(): string {
  const bytes = crypto.randomBytes(8);
  let raw = '';
  for (const byte of bytes) raw += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

export function createPairingResponse(baseUrl: string, session: PairingSession, interval = 5): Record<string, unknown> {
  const root = baseUrl.replace(/\/$/, '');
  const addDevice = new URL(`${root}/add-device`);
  addDevice.searchParams.set('session_id', session.session_id);
  return {
    session_id: session.session_id,
    // Compatibility only. Canonical callers must use session_id.
    device_code: session.device_code,
    user_code: session.user_code,
    verification_uri: `${root}/add-device`,
    verification_uri_complete: addDevice.toString(),
    expires_in: Math.max(0, Math.floor((Date.parse(session.expires_at) - Date.now()) / 1000)),
    interval,
  };
}

interface MemoryRow extends PairingSession {
  state_nonce_hash: string | null;
  sealed_code: string | null;
  code_expires_at: number | null;
}

/** Deterministic local adapter used by the local control-plane integration tests. */
export class InMemoryPairingStore implements PairingStore {
  private readonly sessions = new Map<string, MemoryRow>();

  async create(input: PairingStartInput): Promise<PairingSession> {
    const created = Date.now();
    const row: MemoryRow = {
      session_id: randomValue(32),
      device_code: randomValue(32),
      user_code: randomUserCode(),
      device_id: input.device_id ?? null,
      device_name: input.device_name,
      code_challenge: input.code_challenge,
      created_at: new Date(created).toISOString(),
      expires_at: new Date(created + input.expires_in * 1000).toISOString(),
      state: 'PENDING',
      verified_at: null,
      consumed_at: null,
      state_nonce_hash: null,
      sealed_code: null,
      code_expires_at: null,
    };
    this.sessions.set(row.session_id, row);
    return this.project(row);
  }

  async get(sessionId: string): Promise<PairingSession | null> {
    const row = this.sessions.get(sessionId);
    return row ? this.project(row) : null;
  }

  async findByDeviceCode(deviceCode: string): Promise<PairingSession | null> {
    const row = [...this.sessions.values()].find((item) => item.device_code === deviceCode);
    return row ? this.project(row) : null;
  }

  async setStateNonce(sessionId: string, nonceHash: string): Promise<boolean> {
    const row = this.sessions.get(sessionId);
    if (!row || row.state !== 'PENDING' || Date.parse(row.expires_at) <= Date.now()) return false;
    row.state_nonce_hash = nonceHash;
    return true;
  }

  async storeCode(sessionId: string, nonceHash: string, sealedCode: string, codeTtlSeconds: number): Promise<PairingCallbackResult> {
    const row = this.sessions.get(sessionId);
    if (!row) return 'unknown';
    if (row.state === 'VERIFIED') { this.wipe(row, 'REJECTED'); return 'rejected'; }
    if (row.state !== 'PENDING') return 'invalid';
    if (Date.parse(row.expires_at) <= Date.now()) { this.wipe(row, 'EXPIRED'); return 'expired'; }
    if (!row.state_nonce_hash || row.state_nonce_hash !== nonceHash) return 'invalid';
    row.state = 'VERIFIED';
    row.verified_at = new Date().toISOString();
    row.sealed_code = sealedCode;
    row.code_expires_at = Date.now() + codeTtlSeconds * 1000;
    row.state_nonce_hash = null;
    return 'verified';
  }

  async reject(sessionId: string, nonceHash: string): Promise<PairingCallbackResult> {
    const row = this.sessions.get(sessionId);
    if (!row) return 'unknown';
    if (row.state === 'VERIFIED' || (row.state === 'PENDING' && row.state_nonce_hash === nonceHash)) {
      this.wipe(row, 'REJECTED');
      return 'rejected';
    }
    return 'invalid';
  }

  async consume(sessionId: string): Promise<PairingConsumeResult> {
    const row = this.sessions.get(sessionId);
    if (!row) return { kind: 'unknown' };
    const now = Date.now();
    if (row.state === 'VERIFIED' && row.sealed_code && (row.code_expires_at ?? 0) > now) {
      const sealed = row.sealed_code;
      this.wipe(row, 'CONSUMED');
      row.consumed_at = new Date(now).toISOString();
      return { kind: 'code', sealed_code: sealed, device_id: row.device_id ?? null };
    }
    if (row.state === 'VERIFIED' || (row.state === 'PENDING' && Date.parse(row.expires_at) <= now)) {
      this.wipe(row, 'EXPIRED');
      return { kind: 'expired' };
    }
    if (row.state === 'PENDING') return { kind: 'pending' };
    if (row.state === 'REJECTED') return { kind: 'rejected' };
    if (row.state === 'CONSUMED') return { kind: 'consumed' };
    return { kind: 'expired' };
  }

  /** Test hook: age a stored code past its TTL. */
  expireCodeNow(sessionId: string): void {
    const row = this.sessions.get(sessionId);
    if (row) row.code_expires_at = Date.now() - 1;
  }

  /** Test hook: whether sealed material or a nonce is still held for the session. */
  holdsSecretMaterial(sessionId: string): boolean {
    const row = this.sessions.get(sessionId);
    return Boolean(row && (row.sealed_code || row.state_nonce_hash));
  }

  /** Test hook: read the sealed code at rest. */
  sealedCode(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.sealed_code ?? null;
  }

  private wipe(row: MemoryRow, state: PairingState): void {
    row.state = state;
    row.sealed_code = null;
    row.code_expires_at = null;
    row.state_nonce_hash = null;
  }

  private project(row: MemoryRow): PairingSession {
    const { state_nonce_hash: _n, sealed_code: _c, code_expires_at: _e, ...session } = row;
    return copy(session);
  }
}

/** Durable production adapter. Every transition is a service_role-only RPC from 20260924204948_oauth_pairing.sql. */
export class SupabasePairingStore implements PairingStore {
  private readonly client: SupabaseClient;

  constructor(config: { supabaseUrl: string; serverSecretKey: string }) {
    this.client = createClient(config.supabaseUrl, config.serverSecretKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  }

  async create(input: PairingStartInput): Promise<PairingSession> {
    const created = Date.now();
    const row = {
      session_id: randomValue(32), device_code: randomValue(32), user_code: randomUserCode(),
      device_id: input.device_id ?? null, device_name: input.device_name, code_challenge: input.code_challenge,
      created_at: new Date(created).toISOString(), expires_at: new Date(created + input.expires_in * 1000).toISOString(), state: 'PENDING',
    };
    const { data, error } = await this.client.from('mcp_pairing_sessions').insert(row).select(PUBLIC_COLUMNS).single();
    if (error || !data) throw new Error('pairing session persistence failed');
    return data as unknown as PairingSession;
  }

  async get(sessionId: string): Promise<PairingSession | null> {
    const { data, error } = await this.client.from('mcp_pairing_sessions').select(PUBLIC_COLUMNS).eq('session_id', sessionId).maybeSingle();
    if (error) throw new Error('pairing session lookup failed');
    return data as unknown as PairingSession | null;
  }

  async findByDeviceCode(deviceCode: string): Promise<PairingSession | null> {
    const { data, error } = await this.client.from('mcp_pairing_sessions').select(PUBLIC_COLUMNS).eq('device_code', deviceCode).maybeSingle();
    if (error) throw new Error('pairing device lookup failed');
    return data as unknown as PairingSession | null;
  }

  async setStateNonce(sessionId: string, nonceHash: string): Promise<boolean> {
    const { data, error } = await this.client.rpc('set_mcp_pairing_nonce_server', { p_session_id: sessionId, p_nonce_hash: nonceHash });
    if (error) throw new Error('pairing nonce persistence failed');
    return data === true;
  }

  async storeCode(sessionId: string, nonceHash: string, sealedCode: string, codeTtlSeconds: number): Promise<PairingCallbackResult> {
    const { data, error } = await this.client.rpc('store_mcp_pairing_code_server', {
      p_session_id: sessionId, p_nonce_hash: nonceHash, p_code_ciphertext: sealedCode, p_code_ttl_seconds: codeTtlSeconds,
    });
    if (error) throw new Error('pairing callback persistence failed');
    return callbackResult(data);
  }

  async reject(sessionId: string, nonceHash: string): Promise<PairingCallbackResult> {
    const { data, error } = await this.client.rpc('reject_mcp_pairing_session_server', { p_session_id: sessionId, p_nonce_hash: nonceHash });
    if (error) throw new Error('pairing rejection failed');
    return callbackResult(data);
  }

  async consume(sessionId: string): Promise<PairingConsumeResult> {
    const { data, error } = await this.client.rpc('consume_mcp_pairing_code_server', { p_session_id: sessionId });
    if (error || !data || typeof data !== 'object') throw new Error('pairing consume failed');
    const result = data as { outcome?: string; code_ciphertext?: string | null; device_id?: string | null };
    if (result.outcome === 'code' && typeof result.code_ciphertext === 'string') {
      return { kind: 'code', sealed_code: result.code_ciphertext, device_id: result.device_id ?? null };
    }
    if (result.outcome === 'pending' || result.outcome === 'expired' || result.outcome === 'rejected' || result.outcome === 'consumed' || result.outcome === 'unknown') {
      return { kind: result.outcome };
    }
    throw new Error('pairing consume returned an unexpected outcome');
  }
}

function callbackResult(value: unknown): PairingCallbackResult {
  if (value === 'verified' || value === 'rejected' || value === 'expired' || value === 'invalid' || value === 'unknown') return value;
  throw new Error('pairing callback returned an unexpected outcome');
}

export const DEFAULT_PAIRING_TTL_SECONDS = PAIRING_TTL_SECONDS;
