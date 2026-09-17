// RFC 8628 Device Authorization Grant client. Talks to the ACS gateway's
// /oauth/device/code and /oauth/token endpoints (apps/gateway/src/device-auth.ts).
export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export type DevicePollOutcome =
  | {
      status: "success";
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
      scope: string;
      deviceId: string;
      principal: string;
    }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "error"; error: string };

export interface DeviceFlowDeps {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

export async function requestDeviceCode(
  acsUrl: string,
  clientId: string,
  devicePublicKeyPem: string,
  deviceName: string,
  scopes: string[],
  deps: DeviceFlowDeps = {}
): Promise<DeviceCodeResponse> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await fetchImpl(`${trimTrailingSlash(acsUrl)}/oauth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      device_public_key: devicePublicKeyPem,
      device_name: deviceName,
      scope: scopes.join(" ")
    }).toString()
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`device authorization request failed: ${String(body.error ?? response.status)}`);
  }
  return {
    deviceCode: String(body.device_code),
    userCode: String(body.user_code),
    verificationUri: String(body.verification_uri),
    verificationUriComplete: String(body.verification_uri_complete),
    expiresIn: Number(body.expires_in),
    interval: Number(body.interval)
  };
}

/**
 * Polls the token endpoint honoring the server's interval and slow_down semantics.
 * Never busy-loops: every iteration awaits sleepImpl before/between requests.
 */
export async function pollForToken(
  acsUrl: string,
  clientId: string,
  code: DeviceCodeResponse,
  deps: DeviceFlowDeps = {}
): Promise<DevicePollOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleepImpl = deps.sleepImpl ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let intervalMs = code.interval * 1000;
  const deadline = Date.now() + code.expiresIn * 1000;

  while (Date.now() < deadline) {
    await sleepImpl(intervalMs);
    const response = await fetchImpl(`${trimTrailingSlash(acsUrl)}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.deviceCode,
        client_id: clientId
      }).toString()
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (response.ok) {
      return {
        status: "success",
        accessToken: String(body.access_token),
        refreshToken: String(body.refresh_token),
        expiresIn: Number(body.expires_in),
        scope: String(body.scope ?? ""),
        deviceId: String(body.device_id),
        principal: String(body.principal)
      };
    }
    const error = String(body.error ?? "unknown_error");
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      intervalMs += 5_000;
      continue;
    }
    if (error === "access_denied") return { status: "denied" };
    if (error === "expired_token") return { status: "expired" };
    return { status: "error", error };
  }
  return { status: "expired" };
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
