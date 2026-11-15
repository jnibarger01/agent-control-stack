import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writeCredentials, type StoredCredentials } from "../../apps/runtime/src/auth/credential-store.js";

export const OPERATOR_TOKEN = "operator-token-0123456789abcdef";
export const OPERATOR_ACTOR_ID = "operator-1";
export const DEFAULT_RECOVERY_KEY = randomBytes(32).toString("base64");

const GATEWAY_WORKER = resolve(process.cwd(), "tests/device-auth-reliability/gateway-worker.ts");
const CLI_REFRESH_WORKER = resolve(process.cwd(), "tests/device-auth-reliability/cli-refresh-worker.ts");

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createTempEnv(): { dir: string; dbPath: string; credentialsPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "acs-dar-"));
  return {
    dir,
    dbPath: join(dir, "control.db"),
    credentialsPath: join(dir, "credentials.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

export interface GatewayProcess {
  url: string;
  stop: () => Promise<void>;
}

export async function spawnGatewayProcess(options: {
  dbPath: string;
  recoveryKey?: string | null;
  recoveryWindowSeconds?: number;
  extraEnv?: Record<string, string>;
}): Promise<GatewayProcess> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ACS_DB_PATH: options.dbPath,
    ACS_GATEWAY_TOKEN: OPERATOR_TOKEN,
    ACS_GATEWAY_ACTOR_ID: OPERATOR_ACTOR_ID,
    ACS_GATEWAY_ACTOR: "user",
    ...options.extraEnv
  };
  if (options.recoveryKey === null) {
    delete env.ACS_DEVICE_REFRESH_RECOVERY_KEY;
  } else {
    env.ACS_DEVICE_REFRESH_RECOVERY_KEY = options.recoveryKey ?? DEFAULT_RECOVERY_KEY;
  }
  if (options.recoveryWindowSeconds !== undefined) {
    env.ACS_DEVICE_REFRESH_RECOVERY_WINDOW_SECONDS = String(options.recoveryWindowSeconds);
  }

  const child = spawn(process.execPath, ["--import", "tsx", GATEWAY_WORKER], {
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const url = await new Promise<string>((resolveReady, rejectReady) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      rejectReady(new Error(`gateway worker timed out starting. stderr: ${stderr}`));
    }, 15_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const match = /READY (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolveReady(match[1]);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      rejectReady(new Error(`gateway worker exited prematurely (${code ?? signal}): ${stderr}`));
    });
  });

  return {
    url,
    stop: () => stopChild(child)
  };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveExit();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
    child.kill("SIGTERM");
  });
}

export interface CliWorkerResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  parsed?: {
    ok: boolean;
    deviceId: string;
    accessTokenHash: string;
    refreshTokenHash: string;
    accessTokenExpiresAt: string;
  };
}

export async function spawnCliRefreshProcess(options: {
  credentialsPath: string;
  killBeforePersist?: boolean;
  extraEnv?: Record<string, string>;
}): Promise<CliWorkerResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ACS_CLI_CREDENTIALS_PATH: options.credentialsPath,
    ...(options.killBeforePersist ? { ACS_TEST_KILL_BEFORE_PERSIST: "1" } : {}),
    ...options.extraEnv
  };

  return new Promise<CliWorkerResult>((resolveResult) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI_REFRESH_WORKER], {
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("exit", (code, signal) => {
      let parsed: CliWorkerResult["parsed"];
      try {
        const line = stdout.trim().split("\n").pop();
        if (line && line.startsWith("{")) {
          parsed = JSON.parse(line);
        }
      } catch {
        // ignore parse failure
      }
      resolveResult({ code, signal, stdout, stderr, parsed });
    });
  });
}

export interface AuthenticatedDevice {
  credentials: StoredCredentials;
  deviceId: string;
  principal: string;
  accessToken: string;
  refreshToken: string;
}

export async function authenticateDevice(options: {
  gatewayUrl: string;
  credentialsPath: string;
  clientId?: string;
  deviceName?: string;
  scopes?: string[];
  accessTokenExpiresAtOverride?: string;
}): Promise<AuthenticatedDevice> {
  const clientId = options.clientId ?? "acs-cli";
  const deviceName = options.deviceName ?? "test-device";
  const scopes = options.scopes ?? ["acs:device"];
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const devicePublicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const devicePrivateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const codeRes = await fetch(`${options.gatewayUrl}/oauth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      device_public_key: devicePublicKeyPem,
      device_name: deviceName,
      scope: scopes.join(" ")
    }).toString()
  });
  if (!codeRes.ok) {
    throw new Error(`device code request failed: ${codeRes.status}`);
  }
  const codeBody = (await codeRes.json()) as { device_code: string; user_code: string };

  const approveRes = await fetch(`${options.gatewayUrl}/device/verify`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${OPERATOR_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ user_code: codeBody.user_code, action: "approve" })
  });
  if (!approveRes.ok) {
    throw new Error(`device verify failed: ${approveRes.status}`);
  }

  const deviceSignature = sign(
    null,
    Buffer.from(`acs-device-code-proof-v1\n${codeBody.device_code}`, "utf8"),
    privateKey
  ).toString("base64url");

  const tokenRes = await fetch(`${options.gatewayUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: codeBody.device_code,
      device_signature: deviceSignature,
      client_id: clientId
    }).toString()
  });
  if (!tokenRes.ok) {
    throw new Error(`device token exchange failed: ${tokenRes.status}`);
  }
  const tokenBody = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
    device_id: string;
    principal: string;
  };

  const credentials: StoredCredentials = {
    v: 1,
    acsUrl: options.gatewayUrl,
    clientId,
    deviceName,
    devicePrivateKeyPem,
    devicePublicKeyPem,
    session: {
      deviceId: tokenBody.device_id,
      principal: tokenBody.principal,
      accessToken: tokenBody.access_token,
      accessTokenExpiresAt:
        options.accessTokenExpiresAtOverride ?? new Date(Date.now() + tokenBody.expires_in * 1000).toISOString(),
      refreshToken: tokenBody.refresh_token,
      scopes: tokenBody.scope.split(/\s+/).filter(Boolean)
    }
  };
  writeCredentials(options.credentialsPath, credentials);

  return {
    credentials,
    deviceId: tokenBody.device_id,
    principal: tokenBody.principal,
    accessToken: tokenBody.access_token,
    refreshToken: tokenBody.refresh_token
  };
}

export function signRefreshProof(input: {
  privateKeyPem: string;
  clientId: string;
  deviceId: string;
  refreshToken: string;
  issuedAt: number;
}): string {
  const payload = [
    "acs-device-refresh-proof-v1",
    `client_id=${input.clientId}`,
    `device_id=${input.deviceId}`,
    `refresh_token_sha256=${sha256Hex(input.refreshToken)}`,
    "operation=refresh_token",
    `issued_at=${input.issuedAt}`
  ].join("\n");
  return sign(null, Buffer.from(payload, "utf8"), createPrivateKey(input.privateKeyPem)).toString("base64url");
}

export function inspectDeviceRow(
  dbPath: string,
  deviceId: string
):
  | {
      status: string;
      revoked_at: string | null;
      refresh_token_hash: string | null;
      refresh_token_expires_at: string | null;
      previous_refresh_token_hash: string | null;
      access_token_hash: string | null;
      access_token_expires_at: string | null;
    }
  | undefined {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT status, revoked_at, refresh_token_hash, refresh_token_expires_at,
                previous_refresh_token_hash, access_token_hash, access_token_expires_at
         FROM devices WHERE id = ?`
      )
      .get(deviceId) as
      | {
          status: string;
          revoked_at: string | null;
          refresh_token_hash: string | null;
          refresh_token_expires_at: string | null;
          previous_refresh_token_hash: string | null;
          access_token_hash: string | null;
          access_token_expires_at: string | null;
        }
      | undefined;
  } finally {
    db.close();
  }
}

export function dpopHeaders(input: {
  accessToken: string;
  devicePublicKeyPem: string;
  devicePrivateKeyPem: string;
  method: string;
  url: string;
}): { authorization: string; dpop: string } {
  const pubJwk = createPublicKey(input.devicePublicKeyPem).export({ format: "jwk" }) as {
    kty: string;
    crv: string;
    x: string;
  };
  const header = Buffer.from(
    JSON.stringify({
      typ: "dpop+jwt",
      alg: "EdDSA",
      jwk: { kty: pubJwk.kty, crv: pubJwk.crv, x: pubJwk.x }
    }),
    "utf8"
  ).toString("base64url");
  const parsed = new URL(input.url);
  const payload = Buffer.from(
    JSON.stringify({
      jti: randomBytes(16).toString("base64url"),
      htm: input.method.toUpperCase(),
      htu: `${parsed.origin}${parsed.pathname}`,
      iat: Math.floor(Date.now() / 1000),
      ath: createHash("sha256").update(input.accessToken, "ascii").digest("base64url")
    }),
    "utf8"
  ).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const sig = sign(null, Buffer.from(signingInput, "utf8"), createPrivateKey(input.devicePrivateKeyPem)).toString(
    "base64url"
  );
  return {
    authorization: `DPoP ${input.accessToken}`,
    dpop: `${signingInput}.${sig}`
  };
}

export function countRecoveryEnvelopes(dbPath: string, deviceId: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS count FROM device_refresh_recovery_envelopes WHERE device_id = ?`)
      .get(deviceId) as { count: number };
    return Number(row.count);
  } finally {
    db.close();
  }
}
