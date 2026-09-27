import crypto from 'node:crypto';

export const MAX_TOOL_NAME_BYTES = 128;
export const MAX_ARGUMENT_BYTES = 64 * 1024;
export const MAX_RESULT_BYTES = 256 * 1024;
export const MAX_METADATA_BYTES = 8 * 1024;
export const DEFAULT_DISPATCH_TIMEOUT_MS = 30_000;

export type EffectiveDeviceState = 'online' | 'offline' | 'revoked';
export type DeviceStateReason = 'revoked' | 'device_session_missing' | 'presence_absent' | 'transport_invalid' | 'local_mcp_not_ready' | null;
export type CallStatus = 'pending' | 'executing' | 'completed' | 'failed' | 'timed_out' | 'cancelled';

export interface DeviceRecord {
  id: string;
  user_id: string;
  device_name: string;
  capabilities: Record<string, unknown>;
  /** Compatibility/diagnostic field only. Never used to authorize dispatch. */
  status: string;
  last_seen: string;
  revoked_at: string | null;
}
export interface PresenceSnapshot {
  present: boolean;
  transport: string | null;
  localMcpReady: boolean | null;
  connectionGeneration: string | null;
}
export interface DeviceSessionBinding {
  sessionId: string;
  generation: number;
  revokedAt: string | null;
}
export interface DeviceView extends DeviceRecord {
  registered: true;
  revoked: boolean;
  authenticated: boolean;
  present: boolean;
  remoteChannelReachable: boolean;
  transport: string | null;
  transportCapabilityValid: boolean;
  localMcpReady: boolean | null;
  connectionGeneration: string | null;
  effectiveOnline: boolean;
  executionReady: boolean;
  reason: DeviceStateReason;
  /** Compatibility projection for older callers. */
  effective_state: EffectiveDeviceState;
}
export interface CallRecord {
  id: string;
  user_id: string;
  device_id: string;
  target_auth_session_id: string;
  target_connection_generation: string;
  tool_name: string;
  tool_args: Record<string, unknown>;
  metadata: Record<string, unknown>;
  idempotency_key: string;
  status: CallStatus;
  created_at: string;
  deadline_at: string;
  completed_at: string | null;
  result: unknown | null;
  error_message: string | null;
}
export interface DeviceRegistration { device_name: string; capabilities: Record<string, unknown>; }
export interface DispatchRequest { tool_name: string; arguments: Record<string, unknown>; metadata?: Record<string, unknown>; idempotency_key: string; }
export interface PresenceReader { readPresence(userId: string, deviceId: string): Promise<PresenceSnapshot>; }
export interface DispatchNotifier { notifyNewCall(userId: string, callId: string, deviceId: string): Promise<void>; }
export interface Clock { now(): Date; }
export interface ControlPlaneStore extends PresenceReader {
  createDevice(userId: string, registration: DeviceRegistration): Promise<DeviceRecord>;
  listDevices(userId: string): Promise<DeviceRecord[]>;
  getDevice(userId: string, deviceId: string): Promise<DeviceRecord | null>;
  updateDevice(userId: string, deviceId: string, update: Partial<Pick<DeviceRecord, 'device_name' | 'capabilities'>>): Promise<DeviceRecord | null>;
  revokeDevice(userId: string, deviceId: string, now: string): Promise<DeviceRecord | null>;
  getActiveDeviceSession(userId: string, deviceId: string): Promise<DeviceSessionBinding | null>;
  /** The device an auth session is currently bound to (one live binding per session), if any. */
  findDeviceBoundToSession(userId: string, sessionId: string): Promise<string | null>;
  bindDeviceSession(userId: string, deviceId: string, sessionId: string, now: string): Promise<DeviceSessionBinding | null>;
  createCall(call: CallRecord): Promise<CallRecord>;
  getCall(userId: string, deviceId: string, callId: string): Promise<CallRecord | null>;
  getCallByIdempotency(userId: string, deviceId: string, idempotencyKey: string): Promise<CallRecord | null>;
  expireCall(userId: string, deviceId: string, callId: string, now: string): Promise<CallRecord | null>;
  claimCall(userId: string, deviceId: string, callId: string, sessionId: string, connectionGeneration: string, now: string): Promise<boolean>;
  completeCall(userId: string, deviceId: string, callId: string, sessionId: string, connectionGeneration: string, status: 'completed' | 'failed', result: unknown | null, errorMessage: string | null, now: string): Promise<CallRecord | null>;
}
export class ControlPlaneError extends Error {
  constructor(public readonly code: 'not_found' | 'device_unavailable' | 'invalid_request' | 'conflict', message: string) { super(message); }
}
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8'); }
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function uuid(): string { return crypto.randomUUID(); }

/** Canonical resolver. Persisted `status` is deliberately not an input. */
export async function resolveEffectiveDeviceState(device: DeviceRecord, store: Pick<ControlPlaneStore, 'readPresence' | 'getActiveDeviceSession'>): Promise<DeviceView> {
  const revoked = device.revoked_at !== null;
  const session = revoked ? null : await store.getActiveDeviceSession(device.user_id, device.id);
  const absent: PresenceSnapshot = { present: false, transport: null, localMcpReady: null, connectionGeneration: null };
  // An unreadable Presence (Realtime slow to join, socket error) is treated as
  // absent: dispatch stays refused, and registration or listing don't fail with 500.
  const presence = revoked ? absent : await store.readPresence(device.user_id, device.id).catch((error: unknown) => {
    console.error(JSON.stringify({ event: 'control_plane_presence_read_failed', error_type: error instanceof Error ? error.name : 'unknown' }));
    return absent;
  });
  const transportCapabilityValid = device.capabilities.transport_broadcast_v1 === true && presence.transport === 'broadcast_v1' && typeof presence.connectionGeneration === 'string' && presence.connectionGeneration.length > 0;
  const authenticated = session !== null && session.revokedAt === null;
  const effectiveOnline = !revoked && authenticated && presence.present && transportCapabilityValid;
  const executionReady = effectiveOnline && presence.localMcpReady === true;
  let reason: DeviceStateReason = null;
  if (revoked) reason = 'revoked';
  else if (!authenticated) reason = 'device_session_missing';
  else if (!presence.present) reason = 'presence_absent';
  else if (!transportCapabilityValid) reason = 'transport_invalid';
  else if (!executionReady) reason = 'local_mcp_not_ready';
  return {
    ...device,
    registered: true,
    revoked,
    authenticated,
    present: presence.present,
    remoteChannelReachable: presence.present,
    transport: presence.transport,
    transportCapabilityValid,
    localMcpReady: presence.localMcpReady,
    connectionGeneration: presence.connectionGeneration,
    effectiveOnline,
    executionReady,
    reason,
    effective_state: revoked ? 'revoked' : effectiveOnline ? 'online' : 'offline',
  };
}

export class ControlPlaneService {
  private readonly clock: Clock;
  private readonly dispatchTimeoutMs: number;
  private readonly notifier?: DispatchNotifier;
  constructor(private readonly store: ControlPlaneStore, options: { now?: () => Date; dispatchTimeoutMs?: number; notifier?: DispatchNotifier } = {}) {
    this.clock = { now: options.now ?? (() => new Date()) };
    this.dispatchTimeoutMs = options.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
    this.notifier = options.notifier;
  }
  private now(): string { return this.clock.now().toISOString(); }
  private view(device: DeviceRecord): Promise<DeviceView> { return resolveEffectiveDeviceState(device, this.store); }
  async registerDevice(userId: string, registration: DeviceRegistration): Promise<DeviceView> {
    if (!registration.device_name || Buffer.byteLength(registration.device_name) > 128 || bytes(registration.capabilities) > MAX_METADATA_BYTES) throw new ControlPlaneError('invalid_request', 'invalid device registration');
    return this.view(await this.store.createDevice(userId, registration));
  }
  async deviceBoundToSession(userId: string, sessionId: string): Promise<string | null> {
    return this.store.findDeviceBoundToSession(userId, sessionId);
  }
  async bindDeviceSession(userId: string, deviceId: string, sessionId: string): Promise<DeviceSessionBinding> {
    if (!sessionId || sessionId.length > 128) throw new ControlPlaneError('invalid_request', 'invalid session binding');
    const binding = await this.store.bindDeviceSession(userId, deviceId, sessionId, this.now());
    if (!binding) throw new ControlPlaneError('not_found', 'device not found');
    return binding;
  }
  async listDevices(userId: string): Promise<DeviceView[]> { return Promise.all((await this.store.listDevices(userId)).map((device) => this.view(device))); }
  async getDevice(userId: string, deviceId: string): Promise<DeviceView> {
    const device = await this.store.getDevice(userId, deviceId);
    if (!device) throw new ControlPlaneError('not_found', 'device not found');
    return this.view(device);
  }
  async updateDevice(userId: string, deviceId: string, update: Partial<DeviceRegistration>): Promise<DeviceView> {
    if (update.device_name !== undefined && (!update.device_name || Buffer.byteLength(update.device_name) > 128)) throw new ControlPlaneError('invalid_request', 'invalid device name');
    if (update.capabilities !== undefined && bytes(update.capabilities) > MAX_METADATA_BYTES) throw new ControlPlaneError('invalid_request', 'capabilities too large');
    const device = await this.store.updateDevice(userId, deviceId, update);
    if (!device) throw new ControlPlaneError('not_found', 'device not found');
    return this.view(device);
  }
  async revokeDevice(userId: string, deviceId: string): Promise<DeviceView> {
    const device = await this.store.revokeDevice(userId, deviceId, this.now());
    if (!device) throw new ControlPlaneError('not_found', 'device not found');
    return this.view(device);
  }
  async dispatch(userId: string, deviceId: string, request: DispatchRequest): Promise<CallRecord> {
    if (!request.idempotency_key || request.idempotency_key.length > 128 || !request.tool_name || Buffer.byteLength(request.tool_name) > MAX_TOOL_NAME_BYTES || bytes(request.arguments) > MAX_ARGUMENT_BYTES || bytes(request.metadata ?? {}) > MAX_METADATA_BYTES) throw new ControlPlaneError('invalid_request', 'tool request exceeds schema or payload limits');
    const existing = await this.store.getCallByIdempotency(userId, deviceId, request.idempotency_key);
    if (existing) return this.expireIfNeeded(existing);
    const device = await this.getDevice(userId, deviceId);
    if (!device.executionReady || !device.connectionGeneration) throw new ControlPlaneError('device_unavailable', `device unavailable: ${device.reason ?? 'not ready'}`);
    const session = await this.store.getActiveDeviceSession(userId, deviceId);
    if (!session) throw new ControlPlaneError('device_unavailable', 'device unavailable: device_session_missing');
    const now = this.clock.now();
    const candidate: CallRecord = { id: uuid(), user_id: userId, device_id: deviceId, target_auth_session_id: session.sessionId, target_connection_generation: device.connectionGeneration, tool_name: request.tool_name, tool_args: copy(request.arguments), metadata: copy(request.metadata ?? {}), idempotency_key: request.idempotency_key, status: 'pending', created_at: now.toISOString(), deadline_at: new Date(now.getTime() + this.dispatchTimeoutMs).toISOString(), completed_at: null, result: null, error_message: null };
    const call = await this.store.createCall(candidate);
    if (call.id === candidate.id && this.notifier) await this.notifier.notifyNewCall(userId, call.id, deviceId);
    return call;
  }
  async claim(userId: string, deviceId: string, callId: string, sessionId: string, connectionGeneration: string): Promise<boolean> {
    return this.store.claimCall(userId, deviceId, callId, sessionId, connectionGeneration, this.now());
  }
  async complete(userId: string, deviceId: string, callId: string, sessionId: string, connectionGeneration: string, status: 'completed' | 'failed', result: unknown | null, errorMessage: string | null): Promise<CallRecord> {
    if (bytes(result) > MAX_RESULT_BYTES || (errorMessage && Buffer.byteLength(errorMessage) > 4096)) throw new ControlPlaneError('invalid_request', 'result too large');
    const call = await this.store.completeCall(userId, deviceId, callId, sessionId, connectionGeneration, status, result, errorMessage, this.now());
    if (!call) throw new ControlPlaneError('not_found', 'call not found, expired, or not claimed by this device session');
    return call;
  }
  async getCall(userId: string, deviceId: string, callId: string): Promise<CallRecord> {
    const call = await this.store.getCall(userId, deviceId, callId);
    if (!call) throw new ControlPlaneError('not_found', 'call not found');
    return this.expireIfNeeded(call);
  }
  private async expireIfNeeded(call: CallRecord): Promise<CallRecord> {
    if ((call.status === 'pending' || call.status === 'executing') && Date.parse(call.deadline_at) <= this.clock.now().getTime()) {
      const expired = await this.store.expireCall(call.user_id, call.device_id, call.id, this.now());
      return expired ?? { ...call, status: 'timed_out', completed_at: this.now(), error_message: 'dispatch timed out' };
    }
    return call;
  }
  async setPresence(userId: string, deviceId: string, snapshot: PresenceSnapshot): Promise<void> {
    const store = this.store as InMemoryControlPlaneStore;
    if (!(store instanceof InMemoryControlPlaneStore)) throw new Error('Presence is supplied by Supabase Realtime in production');
    store.setPresence(userId, deviceId, snapshot);
  }
}

/** Test-only adapter. Production startup must never use this. */
export class InMemoryControlPlaneStore implements ControlPlaneStore {
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly calls = new Map<string, CallRecord>();
  private readonly presence = new Map<string, PresenceSnapshot>();
  private readonly sessions = new Map<string, DeviceSessionBinding>();
  private key(userId: string, deviceId: string): string { return `${userId}:${deviceId}`; }
  async readPresence(userId: string, deviceId: string): Promise<PresenceSnapshot> { return copy(this.presence.get(this.key(userId, deviceId)) ?? { present: false, transport: null, localMcpReady: null, connectionGeneration: null }); }
  setPresence(userId: string, deviceId: string, snapshot: PresenceSnapshot): void { this.presence.set(this.key(userId, deviceId), copy(snapshot)); }
  async setDiagnosticStatus(userId: string, deviceId: string, status: string): Promise<void> { const device = this.devices.get(this.key(userId, deviceId)); if (device) device.status = status; }
  async createDevice(userId: string, registration: DeviceRegistration): Promise<DeviceRecord> { const record: DeviceRecord = { id: uuid(), user_id: userId, device_name: registration.device_name, capabilities: copy(registration.capabilities), status: 'offline', last_seen: new Date().toISOString(), revoked_at: null }; this.devices.set(this.key(userId, record.id), record); return copy(record); }
  async listDevices(userId: string): Promise<DeviceRecord[]> { return [...this.devices.values()].filter((d) => d.user_id === userId).map(copy); }
  async getDevice(userId: string, deviceId: string): Promise<DeviceRecord | null> { const value = this.devices.get(this.key(userId, deviceId)); return value ? copy(value) : null; }
  async updateDevice(userId: string, deviceId: string, update: Partial<DeviceRegistration>): Promise<DeviceRecord | null> { const value = this.devices.get(this.key(userId, deviceId)); if (!value) return null; Object.assign(value, copy(update)); return copy(value); }
  async revokeDevice(userId: string, deviceId: string, now: string): Promise<DeviceRecord | null> { const key = this.key(userId, deviceId); const value = this.devices.get(key); if (!value) return null; value.revoked_at = now; this.sessions.delete(key); return copy(value); }
  async findDeviceBoundToSession(userId: string, sessionId: string): Promise<string | null> { for (const [key, binding] of this.sessions) { if (!binding.revokedAt && binding.sessionId === sessionId && key.startsWith(`${userId}:`)) return key.slice(userId.length + 1); } return null; }
  async getActiveDeviceSession(userId: string, deviceId: string): Promise<DeviceSessionBinding | null> { const value = this.sessions.get(this.key(userId, deviceId)); return value && !value.revokedAt ? copy(value) : null; }
  async bindDeviceSession(userId: string, deviceId: string, sessionId: string, _now: string): Promise<DeviceSessionBinding | null> { const key = this.key(userId, deviceId); const device = this.devices.get(key); if (!device || device.revoked_at) return null; const previous = this.sessions.get(key); const binding = { sessionId, generation: (previous?.generation ?? 0) + 1, revokedAt: null }; this.sessions.set(key, binding); return copy(binding); }
  async createCall(call: CallRecord): Promise<CallRecord> { const existing = [...this.calls.values()].find((c) => c.user_id === call.user_id && c.device_id === call.device_id && c.idempotency_key === call.idempotency_key); if (existing) return copy(existing); this.calls.set(call.id, copy(call)); return copy(call); }
  async getCall(userId: string, deviceId: string, callId: string): Promise<CallRecord | null> { const value = this.calls.get(callId); return value && value.user_id === userId && value.device_id === deviceId ? copy(value) : null; }
  async getCallByIdempotency(userId: string, deviceId: string, key: string): Promise<CallRecord | null> { const value = [...this.calls.values()].find((call) => call.user_id === userId && call.device_id === deviceId && call.idempotency_key === key); return value ? copy(value) : null; }
  async expireCall(userId: string, deviceId: string, callId: string, now: string): Promise<CallRecord | null> { const call = this.calls.get(callId); if (!call || call.user_id !== userId || call.device_id !== deviceId) return null; if ((call.status === 'pending' || call.status === 'executing') && Date.parse(call.deadline_at) <= Date.parse(now)) Object.assign(call, { status: 'timed_out', completed_at: now, error_message: 'dispatch timed out' }); return copy(call); }
  async claimCall(userId: string, deviceId: string, callId: string, sessionId: string, connectionGeneration: string, now: string): Promise<boolean> { const call = this.calls.get(callId); const binding = this.sessions.get(this.key(userId, deviceId)); if (!call || call.user_id !== userId || call.device_id !== deviceId || call.status !== 'pending' || !binding || binding.revokedAt || binding.sessionId !== sessionId || call.target_auth_session_id !== sessionId || call.target_connection_generation !== connectionGeneration) return false; if (Date.parse(call.deadline_at) <= Date.parse(now)) { Object.assign(call, { status: 'timed_out', completed_at: now, error_message: 'dispatch timed out' }); return false; } call.status = 'executing'; return true; }
  async completeCall(userId: string, deviceId: string, callId: string, sessionId: string, connectionGeneration: string, status: 'completed' | 'failed', result: unknown | null, errorMessage: string | null, now: string): Promise<CallRecord | null> { const call = this.calls.get(callId); const binding = this.sessions.get(this.key(userId, deviceId)); if (!call || call.user_id !== userId || call.device_id !== deviceId || call.status !== 'executing' || !binding || binding.revokedAt || binding.sessionId !== sessionId || call.target_auth_session_id !== sessionId || call.target_connection_generation !== connectionGeneration || Date.parse(call.deadline_at) <= Date.parse(now)) { if (call && (call.status === 'pending' || call.status === 'executing') && Date.parse(call.deadline_at) <= Date.parse(now)) Object.assign(call, { status: 'timed_out', completed_at: now, error_message: 'dispatch timed out' }); return null; } Object.assign(call, { status, result: copy(result), error_message: errorMessage, completed_at: now }); return copy(call); }
}
