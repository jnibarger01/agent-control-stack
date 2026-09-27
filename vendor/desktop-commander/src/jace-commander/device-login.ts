/**
 * CLI login — the same RFC 8628 device flow ACS already serves
 * (apps/gateway/src/device-auth.ts), and the same "open a URL, approve in the
 * browser, CLI polls" UX as Desktop Commander's remote-device pairing:
 *
 *   1. POST {acs}/oauth/device/code   {client_id, device_public_key, device_name, scope}
 *   2. human opens verification_uri_complete (ACS Mission Control session,
 *      which itself can be backed by jace-auth OIDC) and approves the code
 *   3. POST {acs}/oauth/token         {grant_type=device_code, device_code,
 *      device_signature = Ed25519("acs-device-code-proof-v1\n" + device_code)}
 *
 * The device key never leaves this machine; the proof-of-possession binds
 * the issued token to it. Credentials are stored 0600 under JC_STATE_DIR.
 * No Supabase dependency: identity is ACS/jace-auth.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ACS_DEVICE_CLIENT_ID = 'acs-cli';
export const DEVICE_CODE_PROOF_DOMAIN = 'acs-device-code-proof-v1';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
export const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

export interface StoredCredentials {
  acsUrl: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scope: string;
  deviceId: string | null;
  principal: string | null;
}

export interface DeviceLoginOptions {
  acsUrl: string;
  stateDir: string;
  scope?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onPrompt?: (prompt: { userCode: string; verificationUri: string; verificationUriComplete: string; expiresIn: number }) => void;
}

function writeSecretFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function credentialsPath(stateDir: string): string {
  return path.join(stateDir, 'credentials.json');
}

export function loadOrCreateDeviceKey(stateDir: string): crypto.KeyObject {
  const keyPath = path.join(stateDir, 'device-key.pem');
  if (fs.existsSync(keyPath)) return crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  writeSecretFile(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
  return privateKey;
}

export function deviceCodeProof(privateKey: crypto.KeyObject, deviceCode: string): string {
  return crypto.sign(null, Buffer.from(`${DEVICE_CODE_PROOF_DOMAIN}\n${deviceCode}`, 'utf8'), privateKey).toString('base64url');
}

async function postJson(fetchImpl: typeof fetch, url: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    // A silent ACS must not hang login or every token refresh.
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

function toCredentials(acsUrl: string, json: Record<string, unknown>, now: number): StoredCredentials {
  if (typeof json.access_token !== 'string' || json.access_token.length === 0) throw new Error('ACS token response missing access_token');
  const expiresIn = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 300;
  return {
    acsUrl,
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
    expiresAt: now + expiresIn * 1000,
    scope: typeof json.scope === 'string' ? json.scope : '',
    deviceId: typeof json.device_id === 'string' ? json.device_id : null,
    principal: typeof json.principal === 'string' ? json.principal : null,
  };
}

export async function deviceLogin(options: DeviceLoginOptions): Promise<StoredCredentials> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const acsUrl = options.acsUrl.replace(/\/$/, '');
  const privateKey = loadOrCreateDeviceKey(options.stateDir);
  const publicKeyPem = crypto.createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }).toString();

  const code = await postJson(fetchImpl, `${acsUrl}/oauth/device/code`, {
    client_id: ACS_DEVICE_CLIENT_ID,
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
  const proof = deviceCodeProof(privateKey, deviceCode);
  while (now() < deadline) {
    await sleep(interval * 1000);
    const token = await postJson(fetchImpl, `${acsUrl}/oauth/token`, {
      grant_type: DEVICE_GRANT,
      client_id: ACS_DEVICE_CLIENT_ID,
      device_code: deviceCode,
      device_signature: proof,
    });
    if (token.status === 200) {
      const credentials = toCredentials(acsUrl, token.json, now());
      writeSecretFile(credentialsPath(options.stateDir), JSON.stringify(credentials, null, 2));
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

export function loadCredentials(stateDir: string): StoredCredentials | undefined {
  try {
    return JSON.parse(fs.readFileSync(credentialsPath(stateDir), 'utf8')) as StoredCredentials;
  } catch {
    return undefined;
  }
}

/**
 * Bearer for ACS calls: JC_ACS_TOKEN (service deployments) wins, else the
 * device-login credential for the same ACS origin, refreshed when within
 * 60 s of expiry. Returns undefined rather than a stale or foreign token.
 */
export async function acsAccessToken(
  acsUrl: string,
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<string | undefined> {
  if (env.JC_ACS_TOKEN) return env.JC_ACS_TOKEN;
  const stored = loadCredentials(stateDir);
  if (!stored || stored.acsUrl !== acsUrl.replace(/\/$/, '')) return undefined;
  if (stored.expiresAt - now() > 60_000) return stored.accessToken;
  if (!stored.refreshToken) return undefined;
  try {
    const refreshed = await postJson(fetchImpl, `${stored.acsUrl}/oauth/token`, {
      grant_type: 'refresh_token',
      client_id: ACS_DEVICE_CLIENT_ID,
      refresh_token: stored.refreshToken,
    });
    if (refreshed.status !== 200) return undefined;
    const credentials = toCredentials(stored.acsUrl, refreshed.json, now());
    writeSecretFile(credentialsPath(stateDir), JSON.stringify(credentials, null, 2));
    return credentials.accessToken;
  } catch {
    return undefined;
  }
}
