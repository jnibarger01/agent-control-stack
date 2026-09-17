import { tryOpenBrowser } from "./browser.js";
import { credentialsPath, writeSession } from "./credential-store.js";
import { loadOrCreateDeviceIdentity } from "./device-identity.js";
import { pollForToken, requestDeviceCode, type DeviceFlowDeps } from "./device-flow.js";

export const DEFAULT_CLI_CLIENT_ID = "acs-cli";
export const DEFAULT_CLI_SCOPES = ["acs:device"];

export interface LoginOptions {
  acsUrl: string;
  clientId?: string;
  scopes?: string[];
  openBrowser?: boolean;
  credentialsPathOverride?: string;
  env?: NodeJS.ProcessEnv;
  deps?: DeviceFlowDeps;
  print?: (line: string) => void;
  openBrowserImpl?: (url: string) => void;
}

export type LoginResult =
  | { ok: true; deviceId: string; principal: string; acsUrl: string }
  | { ok: false; reason: "denied" | "expired" | "error"; detail?: string };

export async function runLogin(options: LoginOptions): Promise<LoginResult> {
  const print = options.print ?? ((line: string) => console.log(line));
  const clientId = options.clientId ?? DEFAULT_CLI_CLIENT_ID;
  const scopes = options.scopes ?? DEFAULT_CLI_SCOPES;
  const path = options.credentialsPathOverride ?? credentialsPath(options.env);
  const openBrowserImpl = options.openBrowserImpl ?? tryOpenBrowser;

  const identity = loadOrCreateDeviceIdentity(options.acsUrl, clientId, {
    credentialsPathOverride: path,
    env: options.env
  });

  print("Starting device authorization...");
  const code = await requestDeviceCode(
    options.acsUrl,
    clientId,
    identity.devicePublicKeyPem,
    identity.deviceName,
    scopes,
    options.deps
  );

  print("");
  print("Open:");
  print(code.verificationUriComplete);
  print("");
  print("Code:");
  print(code.userCode);
  print("");
  if (options.openBrowser !== false) {
    openBrowserImpl(code.verificationUriComplete);
  }
  print("Waiting for authorization...");

  const outcome = await pollForToken(options.acsUrl, clientId, code, options.deps);

  if (outcome.status === "denied") {
    print("");
    print("Authorization denied.");
    return { ok: false, reason: "denied" };
  }
  if (outcome.status === "expired") {
    print("");
    print("Authorization request expired. Run `acs auth login` again.");
    return { ok: false, reason: "expired" };
  }
  if (outcome.status === "error") {
    print("");
    print(`Authorization failed: ${outcome.error}`);
    return { ok: false, reason: "error", detail: outcome.error };
  }

  writeSession(path, {
    deviceId: outcome.deviceId,
    principal: outcome.principal,
    accessToken: outcome.accessToken,
    accessTokenExpiresAt: new Date(Date.now() + outcome.expiresIn * 1000).toISOString(),
    refreshToken: outcome.refreshToken,
    scopes: outcome.scope.split(/\s+/).filter(Boolean)
  });

  print("");
  print("Authorization successful");
  print("Device registered");
  print("");
  print(`User: ${outcome.principal}`);
  print(`Device: ${identity.deviceName}`);
  print(`Device ID: ${outcome.deviceId}`);
  print(`ACS: ${options.acsUrl}`);

  return { ok: true, deviceId: outcome.deviceId, principal: outcome.principal, acsUrl: options.acsUrl };
}
