import { clearSession, credentialsPath, readCredentials } from "./credential-store.js";

export interface LogoutOptions {
  credentialsPathOverride?: string;
  env?: NodeJS.ProcessEnv;
  print?: (line: string) => void;
}

/**
 * Local logout only: clears the locally stored session (access/refresh tokens) but
 * keeps the device keypair so a future `acs auth login` is recognized as the same
 * device. This does NOT revoke the device server-side - that is a separate, explicit
 * operator action (POST /devices/:id/revoke), by design (see docs/oauth-authentication.md).
 */
export function runLogout(options: LogoutOptions = {}): { ok: true; hadSession: boolean } {
  const print = options.print ?? ((line: string) => console.log(line));
  const path = options.credentialsPathOverride ?? credentialsPath(options.env);
  const hadSession = Boolean(readCredentials(path)?.session);
  clearSession(path);
  print(hadSession ? "Logged out locally." : "Already logged out.");
  print("This does not revoke the device on the server. Ask an operator to revoke it remotely if needed.");
  return { ok: true, hadSession };
}
