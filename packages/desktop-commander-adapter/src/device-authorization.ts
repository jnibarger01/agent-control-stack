/**
 * Phase 15 - device authorization boundary (design interface only).
 *
 * This is deliberately NOT wired into the execution-authorization path. The
 * local Desktop Commander MCP backend works entirely offline and must not
 * depend on any hosted device-authorization service (Desktop Commander's own
 * `mcp.desktopcommander.app` / Supabase device backend included).
 *
 * When OAuth Device Authorization + PKCE onboarding through Jace Auth is added,
 * an implementation of `DeviceAuthorizationProvider` will sit *in front of* the
 * ACS Gateway - issuing the actor identity and scopes the gateway already
 * consumes - never inside `authorizeDesktopCommanderExecution`.
 */

export interface DeviceAuthorizationGrant {
  deviceId: string;
  actorId: string;
  scopes: string[];
  issuedAt: string;
  expiresAt: string;
}

export interface DeviceAuthorizationProvider {
  /** Begin an OAuth 2.0 Device Authorization Grant (RFC 8628) + PKCE flow. */
  beginDeviceAuthorization(input: { clientId: string; scopes: string[] }): Promise<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string;
    expiresIn: number;
    interval: number;
  }>;
  /** Poll for completion; resolves with a grant once the user approves. */
  pollDeviceAuthorization(input: { deviceCode: string; codeVerifier: string }): Promise<DeviceAuthorizationGrant>;
  /** Exchange/refresh is out of scope for this interface stub. */
}

/** No-op provider so nothing accidentally depends on a hosted service. */
export const disabledDeviceAuthorizationProvider: DeviceAuthorizationProvider = {
  async beginDeviceAuthorization() {
    throw new Error("device authorization is not enabled in this build");
  },
  async pollDeviceAuthorization() {
    throw new Error("device authorization is not enabled in this build");
  }
};
