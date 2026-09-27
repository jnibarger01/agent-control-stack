import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  CallRecord,
  ControlPlaneStore,
  DeviceRecord,
  DeviceRegistration,
  DeviceSessionBinding,
  PresenceSnapshot,
} from './service.js';

const DEFAULT_PRESENCE_SYNC_TIMEOUT_MS = 2_500;
const ABSENT: PresenceSnapshot = { present: false, transport: null, localMcpReady: null, connectionGeneration: null };

function fail(error: unknown): never {
  throw new Error(`Supabase control-plane operation failed: ${error instanceof Error ? error.message : String(error)}`);
}
function authorizationValue(token: string): string { return `Bearer ${token}`; }
function copyAbsent(): PresenceSnapshot { return { ...ABSENT }; }

export function deviceTopic(userId: string, deviceId: string): string {
  return `user:${userId}:device:${deviceId}`;
}

export function parseDevicePresenceState(deviceId: string, state: Record<string, unknown>): PresenceSnapshot {
  const raw = state[deviceId];
  if (!Array.isArray(raw)) return copyAbsent();
  const valid = raw.filter((item): item is Record<string, unknown> => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const row = item as Record<string, unknown>;
    return row.device_id === deviceId && row.transport === 'broadcast_v1';
  });
  if (valid.length === 0) return copyAbsent();
  if (valid.length !== 1) {
    // Presence proves transport exists, but multiple processes under one key are
    // split-brain. Refuse to produce an executable generation.
    return { present: true, transport: 'broadcast_v1', localMcpReady: false, connectionGeneration: null };
  }
  const row = valid[0];
  const generation = typeof row.connection_generation === 'string' && row.connection_generation.length > 0
    ? row.connection_generation
    : null;
  return {
    present: true,
    transport: 'broadcast_v1',
    localMcpReady: row.local_mcp_ready === true,
    connectionGeneration: generation,
  };
}

export interface SupabaseControlPlaneStoreConfig {
  supabaseUrl: string;
  publishableKey: string;
  serverSecretKey: string;
  accessToken: string;
  presenceSyncTimeoutMs?: number;
}

/**
 * Production adapter. The publishable client carries the caller's Supabase JWT
 * and is subject to RLS. The server client uses a Vercel-only secret key only
 * for narrow server RPCs that authenticated clients cannot execute.
 */
export class SupabaseControlPlaneStore implements ControlPlaneStore {
  private readonly userClient: SupabaseClient;
  private readonly serverClient: SupabaseClient;
  private readonly presenceSyncTimeoutMs: number;

  constructor(config: SupabaseControlPlaneStoreConfig) {
    const commonAuth = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
    this.userClient = createClient(config.supabaseUrl, config.publishableKey, {
      global: { headers: { Authorization: authorizationValue(config.accessToken) } },
      auth: commonAuth,
    });
    this.userClient.realtime.setAuth(config.accessToken);
    this.serverClient = createClient(config.supabaseUrl, config.serverSecretKey, { auth: commonAuth });
    this.presenceSyncTimeoutMs = config.presenceSyncTimeoutMs ?? DEFAULT_PRESENCE_SYNC_TIMEOUT_MS;
  }

  async readPresence(userId: string, deviceId: string): Promise<PresenceSnapshot> {
    const channel = this.userClient.channel(deviceTopic(userId, deviceId), { config: { private: true } });
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise<PresenceSnapshot>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          fn();
        };
        timer = setTimeout(() => finish(() => reject(new Error('Supabase Presence sync timed out'))), this.presenceSyncTimeoutMs);
        channel
          .on('presence', { event: 'sync' }, () => {
            finish(() => resolve(parseDevicePresenceState(deviceId, channel.presenceState() as Record<string, unknown>)));
          })
          .subscribe((status: string, error?: Error) => {
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
              finish(() => reject(new Error(`Supabase Presence channel ${status}${error?.message ? `: ${error.message}` : ''}`)));
            }
          });
      });
    } finally {
      if (timer) clearTimeout(timer);
      await this.userClient.removeChannel(channel).catch(() => undefined);
    }
  }

  async createDevice(userId: string, registration: DeviceRegistration): Promise<DeviceRecord> {
    const { data, error } = await this.serverClient.from('mcp_devices').insert({
      user_id: userId,
      device_name: registration.device_name,
      capabilities: registration.capabilities,
    }).select('*').single();
    if (error || !data) fail(error ?? new Error('device insert returned no row'));
    return data as DeviceRecord;
  }

  async listDevices(_userId: string): Promise<DeviceRecord[]> {
    const { data, error } = await this.userClient.from('mcp_devices').select('*').order('created_at', { ascending: true });
    if (error) fail(error);
    return (data ?? []) as DeviceRecord[];
  }

  async getDevice(_userId: string, deviceId: string): Promise<DeviceRecord | null> {
    const { data, error } = await this.userClient.from('mcp_devices').select('*').eq('id', deviceId).maybeSingle();
    if (error) fail(error);
    return data as DeviceRecord | null;
  }

  async updateDevice(userId: string, deviceId: string, update: Partial<Pick<DeviceRecord, 'device_name' | 'capabilities'>>): Promise<DeviceRecord | null> {
    const { data, error } = await this.serverClient.from('mcp_devices').update({ ...update, updated_at: new Date().toISOString() })
      .eq('id', deviceId).eq('user_id', userId).select('*').maybeSingle();
    if (error) fail(error);
    return data as DeviceRecord | null;
  }

  async revokeDevice(userId: string, deviceId: string, _now: string): Promise<DeviceRecord | null> {
    const { data, error } = await this.serverClient.rpc('revoke_mcp_device_server', { p_user_id: userId, p_device_id: deviceId });
    if (error) fail(error);
    return data as DeviceRecord | null;
  }

  async getActiveDeviceSession(userId: string, deviceId: string): Promise<DeviceSessionBinding | null> {
    const { data, error } = await this.serverClient.rpc('get_mcp_device_session_server', { p_user_id: userId, p_device_id: deviceId });
    if (error) fail(error);
    if (!data || !data.auth_session_id) return null;
    return { sessionId: data.auth_session_id as string, generation: Number(data.generation), revokedAt: data.revoked_at as string | null };
  }

  async findDeviceBoundToSession(userId: string, sessionId: string): Promise<string | null> {
    const { data, error } = await this.serverClient.from('mcp_device_sessions').select('device_id')
      .eq('user_id', userId).eq('auth_session_id', sessionId).is('revoked_at', null).maybeSingle();
    if (error) fail(error);
    return (data?.device_id as string | undefined) ?? null;
  }

  async bindDeviceSession(userId: string, deviceId: string, sessionId: string, _now: string): Promise<DeviceSessionBinding | null> {
    const { data, error } = await this.serverClient.rpc('bind_mcp_device_session_server', {
      p_user_id: userId,
      p_device_id: deviceId,
      p_auth_session_id: sessionId,
    });
    if (error) fail(error);
    if (!data) return null;
    return { sessionId: data.auth_session_id as string, generation: Number(data.generation), revokedAt: data.revoked_at as string | null };
  }

  async createCall(call: CallRecord): Promise<CallRecord> {
    const { data, error } = await this.serverClient.rpc('create_mcp_remote_call_server', {
      p_user_id: call.user_id,
      p_device_id: call.device_id,
      p_target_auth_session_id: call.target_auth_session_id,
      p_target_connection_generation: call.target_connection_generation,
      p_tool_name: call.tool_name,
      p_tool_args: call.tool_args,
      p_metadata: call.metadata,
      p_idempotency_key: call.idempotency_key,
      p_deadline_at: call.deadline_at,
    });
    if (error || !data) fail(error ?? new Error('call creation returned no row'));
    return data as CallRecord;
  }

  async getCall(_userId: string, deviceId: string, callId: string): Promise<CallRecord | null> {
    const { data, error } = await this.userClient.from('mcp_remote_calls').select('*').eq('id', callId).eq('device_id', deviceId).maybeSingle();
    if (error) fail(error);
    return data as CallRecord | null;
  }

  async getCallByIdempotency(_userId: string, deviceId: string, key: string): Promise<CallRecord | null> {
    const { data, error } = await this.userClient.from('mcp_remote_calls').select('*').eq('device_id', deviceId).eq('idempotency_key', key).maybeSingle();
    if (error) fail(error);
    return data as CallRecord | null;
  }

  async expireCall(_userId: string, deviceId: string, callId: string, _now: string): Promise<CallRecord | null> {
    const { data, error } = await this.userClient.rpc('expire_mcp_remote_call', { p_call_id: callId });
    if (error) fail(error);
    if (data && data.device_id !== deviceId) throw new Error('expired call device mismatch');
    return data as CallRecord | null;
  }

  async claimCall(_userId: string, deviceId: string, callId: string, _sessionId: string, connectionGeneration: string, _now: string): Promise<boolean> {
    const { data, error } = await this.userClient.rpc('claim_mcp_remote_call', {
      p_call_id: callId,
      p_device_id: deviceId,
      p_connection_generation: connectionGeneration,
    });
    if (error) fail(error);
    return data === true;
  }

  async completeCall(userId: string, deviceId: string, callId: string, _sessionId: string, connectionGeneration: string, status: 'completed' | 'failed', result: unknown | null, errorMessage: string | null, _now: string): Promise<CallRecord | null> {
    const { data, error } = await this.userClient.rpc('complete_mcp_remote_call', {
      p_call_id: callId,
      p_device_id: deviceId,
      p_connection_generation: connectionGeneration,
      p_status: status,
      p_result: result,
      p_error_message: errorMessage,
    });
    if (error) fail(error);
    if (data && (data.user_id !== userId || data.device_id !== deviceId)) throw new Error('completed call binding mismatch');
    return data as CallRecord | null;
  }
}
