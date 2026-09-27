import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const IDENTITY_FILE_NAME = 'runtime-identity.json';
const IDENTITY_SCHEMA_VERSION = 1;

interface PersistedRuntimeIdentity {
  schemaVersion: number;
  runtimeId: string;
  createdAt: string;
}

export interface RuntimeIdentityState {
  runtime_id: string;
  created_at: string;
  identity_schema_version: number;
  device_id?: string;
  remote_auth_state: 'persisted' | 'not_configured' | 'unavailable';
  authorization: 'external';
}

export interface RuntimeIdentityOptions {
  stateDirectory?: string;
  deviceConfigPath?: string;
  homeDirectory?: string;
}

function stateDirectory(options: RuntimeIdentityOptions): string {
  const configured = options.stateDirectory ?? process.env.DESKTOP_COMMANDER_STATE_DIR;
  return configured
    ? path.resolve(configured)
    : path.join(options.homeDirectory ?? os.homedir(), '.desktop-commander');
}

function identityPath(options: RuntimeIdentityOptions): string {
  return path.join(stateDirectory(options), IDENTITY_FILE_NAME);
}

function legacyDevicePath(options: RuntimeIdentityOptions): string {
  const configured = options.deviceConfigPath ?? process.env.DESKTOP_COMMANDER_DEVICE_CONFIG_PATH;
  return configured
    ? path.resolve(configured)
    : path.join(options.homeDirectory ?? os.homedir(), '.desktop-commander-device', 'device.json');
}

function validateIdentity(value: unknown, options: RuntimeIdentityOptions): PersistedRuntimeIdentity {
  const record = value as Partial<PersistedRuntimeIdentity> | null;
  if (
    !record
    || record.schemaVersion !== IDENTITY_SCHEMA_VERSION
    || typeof record.runtimeId !== 'string'
    || !record.runtimeId
    || typeof record.createdAt !== 'string'
    || Number.isNaN(Date.parse(record.createdAt))
  ) {
    throw new Error(`Invalid Desktop Commander runtime identity at ${identityPath(options)}`);
  }
  return record as PersistedRuntimeIdentity;
}

async function readIdentity(options: RuntimeIdentityOptions): Promise<PersistedRuntimeIdentity> {
  const raw = await fs.readFile(identityPath(options), 'utf8');
  return validateIdentity(JSON.parse(raw), options);
}

async function loadOrCreateIdentity(options: RuntimeIdentityOptions): Promise<PersistedRuntimeIdentity> {
  try {
    return await readIdentity(options);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }

  await fs.mkdir(stateDirectory(options), { recursive: true, mode: 0o700 });
  const created: PersistedRuntimeIdentity = {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    runtimeId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };

  const temporaryPath = `${identityPath(options)}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(created, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      // link() publishes a fully-written file atomically and fails with EEXIST
      // if another process won the identity race.
      await fs.link(temporaryPath, identityPath(options));
      return created;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      return readIdentity(options);
    }
  } catch (error: any) {
    throw error;
  } finally {
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

async function readLegacyDeviceState(options: RuntimeIdentityOptions): Promise<{
  deviceId?: string;
  authState: RuntimeIdentityState['remote_auth_state'];
}> {
  try {
    const raw = await fs.readFile(legacyDevicePath(options), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      deviceId: typeof parsed?.deviceId === 'string' && parsed.deviceId ? parsed.deviceId : undefined,
      authState: parsed?.session?.access_token && parsed?.session?.refresh_token
        ? 'persisted'
        : 'not_configured',
    };
  } catch (error: any) {
    // Remote auth is optional. A missing or malformed legacy device file must
    // never prevent the independent local identity from loading.
    return { authState: error?.code === 'ENOENT' ? 'not_configured' : 'unavailable' };
  }
}

/**
 * Stable local runtime identity plus redacted remote-auth presence.
 * Authentication state is informational only; authorization belongs to the caller.
 */
export async function getRuntimeIdentityState(options: RuntimeIdentityOptions = {}): Promise<RuntimeIdentityState> {
  const [identity, legacy] = await Promise.all([
    loadOrCreateIdentity(options),
    readLegacyDeviceState(options),
  ]);

  return {
    runtime_id: identity.runtimeId,
    created_at: identity.createdAt,
    identity_schema_version: identity.schemaVersion,
    ...(legacy.deviceId ? { device_id: legacy.deviceId } : {}),
    remote_auth_state: legacy.authState,
    authorization: 'external',
  };
}
