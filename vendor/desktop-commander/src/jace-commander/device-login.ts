/**
 * ACS CLI device login (RFC 8628 + Ed25519 PoP + ADR-0030 refresh proofs + DPoP).
 *
 * Strictly isolated from `/jc/mcp` credentials: uses its own Ed25519 keypair
 * and SecretStore namespace (`acs:<acsUrl>:secrets`), never shared with `jc-mcp`.
 *
 * Preserves `JC_ACS_TOKEN` env override (static service Bearer token) without
 * auto-downgrading device sessions to Bearer.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearPendingRefresh,
  readPendingRefresh,
  sha256Hex,
  withAuthLock,
  writePendingRefresh,
  writePrivateFileAtomic,
} from './auth-lock.js';
import {
  createDpopProof,
  generateDpopKeyPair,
  loadDpopKeyPairFromPem,
} from './dpop.js';
import { createSecretStore } from './secret-store.js';

export const ACS_DEVICE_CLIENT_ID = 'acs-cli';
export const DEVICE_CODE_PROOF_DOMAIN = 'acs-device-code-proof-v1';
export const REFRESH_PROOF_DOMAIN = 'acs-device-refresh-proof-v1';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
export const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

export interface StoredCredentials {
  acsUrl: string;
  clientId?: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scope: string;
  deviceId: string | null;
  principal: string | null;
  jkt?: string;
  tokenType?: 'DPoP' | 'Bearer';
}

interface StoredAcsMetadata {
  v: 2;
  acsUrl: string;
  clientId: string;
  expiresAt: number;
  scope: string;
  deviceId: string | null;
  principal: string | null;
  jkt: string;
  tokenType: 'DPoP';
  storageBackend?: string;
}

interface StoredAcsSecrets {
  accessToken: string;
  refreshToken: string | null;
  privateKeyPem: string;
}

export interface DeviceLoginOptions {
  acsUrl: string;
  stateDir: string;
  clientId?: string;
  scope?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onPrompt?: (prompt: { userCode: string; verificationUri: string; verificationUriComplete: string; expiresIn: number }) => void;
}

export function credentialsPath(stateDir: string): string {
  return path.join(stateDir, 'credentials.json');
}

function acsSecretKey(acsUrl: string): string {
  return `acs:${acsUrl.replace(/\/$/, '')}:secrets`;
}

function acsKeySecretKey(acsUrl: string): string {
  return `acs:${acsUrl.replace(/\/$/, '')}:device-key`;
}

export function deviceCodeProof(privateKey: crypto.KeyObject, deviceCode: string): string {
  return crypto.sign(null, Buffer.from(`${DEVICE_CODE_PROOF_DOMAIN}\n${deviceCode}`, 'utf8'), privateKey).toString('base64url');
}

export function signAcsRefreshProof(
  privateKey: crypto.KeyObject,
  clientId: string,
  deviceId: string,
  refreshToken: string,
  issuedAtSeconds: number,
): string {
  const refreshTokenSha256 = sha256Hex(refreshToken);
  const message = [
    REFRESH_PROOF_DOMAIN,
    `client_id=${clientId}`,
    `device_id=${deviceId}`,
    `refresh_token_sha256=${refreshTokenSha256}`,
    'operation=refresh_token',
    `issued_at=${issuedAtSeconds}`,
  ].join('\n');
  return crypto.sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64url');
}

export async function loadOrCreateDeviceKey(
  stateDir: string,
  acsUrl = 'default',
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReturnType<typeof generateDpopKeyPair>> {
  const store = await createSecretStore({ stateDir, env });
  const existingPem = await store.get(acsKeySecretKey(acsUrl));
  if (existingPem) {
    return loadDpopKeyPairFromPem(existingPem);
  }
  const legacyKeyPath = path.join(stateDir, 'device-key.pem');
  if (fs.existsSync(legacyKeyPath)) {
    const pem = fs.readFileSync(legacyKeyPath, 'utf8');
    await store.set(acsKeySecretKey(acsUrl), pem);
    fs.rmSync(legacyKeyPath, { force: true });
    return loadDpopKeyPairFromPem(pem);
  }
  const kp = generateDpopKeyPair();
  await store.set(acsKeySecretKey(acsUrl), kp.privateKeyPem);
  return kp;
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch {
    // leave empty; callers treat as protocol error
  }
  return { status: response.status, json };
}

function readAcsMetadata(stateDir: string): StoredAcsMetadata | undefined {
  try {
    const file = credentialsPath(stateDir);
    if (!fs.existsSync(file)) return undefined;
    if (fs.lstatSync(file).isSymbolicLink()) return undefined;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StoredAcsMetadata>;
    if (parsed && parsed.v === 2 && typeof parsed.acsUrl === 'string' && typeof parsed.jkt === 'string') {
      return parsed as StoredAcsMetadata;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function loadCredentials(stateDir: string): StoredCredentials | undefined {
  const meta = readAcsMetadata(stateDir);
  if (meta) {
    return {
      acsUrl: meta.acsUrl,
      clientId: meta.clientId,
      accessToken: '',
      refreshToken: null,
      expiresAt: meta.expiresAt,
      scope: meta.scope,
      deviceId: meta.deviceId,
      principal: meta.principal,
      jkt: meta.jkt,
      tokenType: meta.tokenType,
    };
  }
  try {
    return JSON.parse(fs.readFileSync(credentialsPath(stateDir), 'utf8')) as StoredCredentials;
  } catch {
    return undefined;
  }
}

export async function clearAcsCredentials(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  acsUrl?: string,
): Promise<void> {
  const meta = readAcsMetadata(stateDir);
  const target = (acsUrl ?? meta?.acsUrl)?.replace(/\/$/, '');
  if (target) {
    try {
      const store = await createSecretStore({ stateDir, env });
      await store.delete(acsSecretKey(target));
      await store.delete(acsKeySecretKey(target));
    } catch {
      // ignore cleanup error
    }
  }
  fs.rmSync(credentialsPath(stateDir), { force: true });
  fs.rmSync(path.join(stateDir, 'device-key.pem'), { force: true });
  clearPendingRefresh(stateDir, 'acs');
}

export async function deviceLogin(options: DeviceLoginOptions): Promise<StoredCredentials> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const acsUrl = options.acsUrl.replace(/\/$/, '');
  const clientId = options.clientId ?? ACS_DEVICE_CLIENT_ID;
  const keyPair = await loadOrCreateDeviceKey(options.stateDir, acsUrl, env);
  const publicKeyPem = crypto.createPublicKey(keyPair.privateKey).export({ format: 'pem', type: 'spki' }).toString();

  const code = await postJson(fetchImpl, `${acsUrl}/oauth/device/code`, {
    client_id: clientId,
    device_public_key: publicKeyPem,
    device_name: `jace-commander@${os.hostname()}`.slice(0, 128),
    scope: options.scope ?? 'acs:device',
  });
  const { device_code: deviceCode, user_code: userCode, verification_uri: verificationUri, verification_uri_complete: complete } = code.json;
  if (code.status !== 200 || typeof deviceCode !== 'string' || typeof userCode !== 'string' || typeof verificationUri !== 'string') {
    throw new Error(`ACS device authorization failed (${String(code.json.error ?? code.status)})`);
  }
  const expiresIn = typeof code.json.expires_in === 'number' ? code.json.expires_in : 600;
  let interval = typeof code.json.interval === 'number' && code.json.interval > 0 ? code.json.interval : 5;
  options.onPrompt?.({
    userCode,
    verificationUri,
    verificationUriComplete: typeof complete === 'string' ? complete : verificationUri,
    expiresIn,
  });

  const deadline = now() + expiresIn * 1000;
  const proof = deviceCodeProof(keyPair.privateKey, deviceCode);
  const tokenUrl = `${acsUrl}/oauth/token`;
  while (now() < deadline) {
    await sleep(interval * 1000);
    const dpop = createDpopProof({
      privateKey: keyPair.privateKey,
      publicJwk: keyPair.publicJwk,
      htm: 'POST',
      htu: tokenUrl,
      nowMs: now(),
    });
    const token = await postJson(
      fetchImpl,
      tokenUrl,
      {
        grant_type: DEVICE_GRANT,
        client_id: clientId,
        device_code: deviceCode,
        device_signature: proof,
      },
      { DPoP: dpop },
    );
    if (token.status === 200) {
      if (typeof token.json.access_token !== 'string' || !token.json.access_token) {
        throw new Error('ACS token response missing access_token');
      }
      const tokenExpiresIn = typeof token.json.expires_in === 'number' && token.json.expires_in > 0 ? token.json.expires_in : 300;
      const credentials: StoredCredentials = {
        acsUrl,
        clientId,
        accessToken: token.json.access_token,
        refreshToken: typeof token.json.refresh_token === 'string' ? token.json.refresh_token : null,
        expiresAt: now() + tokenExpiresIn * 1000,
        scope: typeof token.json.scope === 'string' ? token.json.scope : '',
        deviceId: typeof token.json.device_id === 'string' ? token.json.device_id : null,
        principal: typeof token.json.principal === 'string' ? token.json.principal : null,
        jkt: keyPair.jkt,
        tokenType: 'DPoP',
      };
      const store = await createSecretStore({ stateDir: options.stateDir, env });
      const secrets: StoredAcsSecrets = {
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        privateKeyPem: keyPair.privateKeyPem,
      };
      await store.set(acsSecretKey(acsUrl), JSON.stringify(secrets));
      const meta: StoredAcsMetadata = {
        v: 2,
        acsUrl,
        clientId,
        expiresAt: credentials.expiresAt,
        scope: credentials.scope,
        deviceId: credentials.deviceId,
        principal: credentials.principal,
        jkt: keyPair.jkt,
        tokenType: 'DPoP',
        storageBackend: store.backendName(),
      };
      writePrivateFileAtomic(credentialsPath(options.stateDir), JSON.stringify(meta, null, 2));
      return credentials;
    }
    const error = token.json.error;
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      interval += 5;
      continue;
    }
    throw new Error(`ACS device authorization ended: ${typeof error === 'string' ? error : `http_${token.status}`}`);
  }
  throw new Error('ACS device authorization expired before approval');
}

async function resolveAcsV2Credentials(
  acsUrl: string,
  stateDir: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
  now: () => number,
  forceRefresh = false,
): Promise<{ credentials: StoredCredentials; keyPair: ReturnType<typeof generateDpopKeyPair> } | undefined> {
  const normalized = acsUrl.replace(/\/$/, '');
  const meta = readAcsMetadata(stateDir);
  if (!meta || meta.acsUrl !== normalized) return undefined;

  const store = await createSecretStore({ stateDir, env });
  const rawSecrets = await store.get(acsSecretKey(normalized));
  if (!rawSecrets) return undefined;
  const secrets = JSON.parse(rawSecrets) as StoredAcsSecrets;
  const keyPair = loadDpopKeyPairFromPem(secrets.privateKeyPem);

  if (!forceRefresh && meta.expiresAt - now() > 60_000) {
    return {
      keyPair,
      credentials: {
        acsUrl: meta.acsUrl,
        clientId: meta.clientId,
        accessToken: secrets.accessToken,
        refreshToken: secrets.refreshToken,
        expiresAt: meta.expiresAt,
        scope: meta.scope,
        deviceId: meta.deviceId,
        principal: meta.principal,
        jkt: meta.jkt,
        tokenType: 'DPoP',
      },
    };
  }

  if (!secrets.refreshToken || !meta.deviceId) return undefined;

  return withAuthLock(
    stateDir,
    async () => {
      const latestMeta = readAcsMetadata(stateDir);
      if (!latestMeta || latestMeta.acsUrl !== normalized) return undefined;
      const latestRaw = await store.get(acsSecretKey(normalized));
      if (!latestRaw) return undefined;
      const latestSecrets = JSON.parse(latestRaw) as StoredAcsSecrets;
      const latestKeyPair = loadDpopKeyPairFromPem(latestSecrets.privateKeyPem);

      if (!forceRefresh && latestMeta.expiresAt - now() > 60_000) {
        return {
          keyPair: latestKeyPair,
          credentials: {
            acsUrl: latestMeta.acsUrl,
            clientId: latestMeta.clientId,
            accessToken: latestSecrets.accessToken,
            refreshToken: latestSecrets.refreshToken,
            expiresAt: latestMeta.expiresAt,
            scope: latestMeta.scope,
            deviceId: latestMeta.deviceId,
            principal: latestMeta.principal,
            jkt: latestMeta.jkt,
            tokenType: 'DPoP',
          },
        };
      }
      if (!latestSecrets.refreshToken || !latestMeta.deviceId) return undefined;

      const oldHash = sha256Hex(latestSecrets.refreshToken);
      const pending = readPendingRefresh(stateDir, 'acs');
      const refreshRequestId =
        pending && pending.url === normalized && pending.oldRefreshTokenHash === oldHash
          ? pending.refreshRequestId
          : crypto.randomUUID();
      writePendingRefresh(stateDir, {
        domain: 'acs',
        url: normalized,
        clientId: latestMeta.clientId,
        deviceId: latestMeta.deviceId,
        refreshRequestId,
        oldRefreshTokenHash: oldHash,
        startedAt: new Date(now()).toISOString(),
      });

      const issuedAtSec = Math.floor(now() / 1000);
      const refreshProof = signAcsRefreshProof(
        latestKeyPair.privateKey,
        latestMeta.clientId,
        latestMeta.deviceId,
        latestSecrets.refreshToken,
        issuedAtSec,
      );
      const tokenUrl = `${normalized}/oauth/token`;
      const dpop = createDpopProof({
        privateKey: latestKeyPair.privateKey,
        publicJwk: latestKeyPair.publicJwk,
        htm: 'POST',
        htu: tokenUrl,
        nowMs: now(),
      });
      const refreshed = await postJson(
        fetchImpl,
        tokenUrl,
        {
          grant_type: 'refresh_token',
          client_id: latestMeta.clientId,
          refresh_token: latestSecrets.refreshToken,
          device_id: latestMeta.deviceId,
          proof_issued_at: issuedAtSec,
          refresh_proof: refreshProof,
          refresh_request_id: refreshRequestId,
        },
        { DPoP: dpop },
      );
      if (refreshed.status !== 200 || typeof refreshed.json.access_token !== 'string') {
        const acsReason = refreshed.json.acs_reason;
        if (acsReason === 'device_revoked' || acsReason === 'refresh_replay' || acsReason === 'refresh_expired' || acsReason === 'unknown_refresh_token') {
          clearPendingRefresh(stateDir, 'acs');
          await store.set(acsSecretKey(normalized), JSON.stringify({ ...latestSecrets, refreshToken: null }));
        }
        return undefined;
      }

      const nextExpiresIn = typeof refreshed.json.expires_in === 'number' && refreshed.json.expires_in > 0 ? refreshed.json.expires_in : 300;
      const nextSecrets: StoredAcsSecrets = {
        accessToken: refreshed.json.access_token,
        refreshToken: typeof refreshed.json.refresh_token === 'string' ? refreshed.json.refresh_token : latestSecrets.refreshToken,
        privateKeyPem: latestSecrets.privateKeyPem,
      };
      await store.set(acsSecretKey(normalized), JSON.stringify(nextSecrets));
      const nextMeta: StoredAcsMetadata = {
        ...latestMeta,
        expiresAt: now() + nextExpiresIn * 1000,
        scope: typeof refreshed.json.scope === 'string' ? refreshed.json.scope : latestMeta.scope,
        principal: typeof refreshed.json.principal === 'string' ? refreshed.json.principal : latestMeta.principal,
        storageBackend: store.backendName(),
      };
      writePrivateFileAtomic(credentialsPath(stateDir), JSON.stringify(nextMeta, null, 2));
      clearPendingRefresh(stateDir, 'acs');

      return {
        keyPair: latestKeyPair,
        credentials: {
          acsUrl: nextMeta.acsUrl,
          clientId: nextMeta.clientId,
          accessToken: nextSecrets.accessToken,
          refreshToken: nextSecrets.refreshToken,
          expiresAt: nextMeta.expiresAt,
          scope: nextMeta.scope,
          deviceId: nextMeta.deviceId,
          principal: nextMeta.principal,
          jkt: nextMeta.jkt,
          tokenType: 'DPoP',
        },
      };
    },
    { lockName: 'acs-auth.lock' },
  );
}

export async function refreshAcsCredentials(
  acsUrl: string,
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<StoredCredentials | undefined> {
  const res = await resolveAcsV2Credentials(acsUrl, stateDir, env, fetchImpl, now, true);
  return res?.credentials;
}

export async function acsAccessToken(
  acsUrl: string,
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<string | undefined> {
  if (env.JC_ACS_TOKEN) return env.JC_ACS_TOKEN;
  const v2 = await resolveAcsV2Credentials(acsUrl, stateDir, env, fetchImpl, now, false).catch(() => undefined);
  if (v2) return v2.credentials.accessToken;
  // Legacy fallback if an external caller pre-seeded a plaintext credentials.json without v2 metadata
  try {
    const raw = JSON.parse(fs.readFileSync(credentialsPath(stateDir), 'utf8')) as Partial<StoredCredentials> & { v?: number };
    if (raw.v !== 2 && typeof raw.accessToken === 'string' && raw.acsUrl === acsUrl.replace(/\/$/, '') && (raw.expiresAt ?? 0) - now() > 60_000) {
      return raw.accessToken;
    }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Auth headers for protected ACS HTTP calls (`acs_read`, `acs_submit_mission`, mirror).
 * Uses `Bearer` only when explicit `JC_ACS_TOKEN` is set; device-login sessions
 * always send `Authorization: DPoP <at>` + fresh `DPoP` proof (never downgraded).
 */
export async function acsAuthHeaders(options: {
  acsUrl: string;
  stateDir: string;
  method: string;
  url: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<Record<string, string> | undefined> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  if (env.JC_ACS_TOKEN) {
    return { authorization: `Bearer ${env.JC_ACS_TOKEN}` };
  }
  const resolved = await resolveAcsV2Credentials(
    options.acsUrl,
    options.stateDir,
    env,
    options.fetchImpl ?? fetch,
    now,
    false,
  ).catch(() => undefined);
  if (!resolved) return undefined;
  const dpop = createDpopProof({
    privateKey: resolved.keyPair.privateKey,
    publicJwk: resolved.keyPair.publicJwk,
    htm: options.method,
    htu: options.url,
    accessToken: resolved.credentials.accessToken,
    nowMs: now(),
  });
  return {
    authorization: `DPoP ${resolved.credentials.accessToken}`,
    DPoP: dpop,
  };
}
