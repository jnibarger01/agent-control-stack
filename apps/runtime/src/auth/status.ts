import {
  CredentialsFileCorruptError,
  credentialsPath,
  readCredentials,
  type StoredCredentials
} from "./credential-store.js";

export interface StatusOptions {
  credentialsPathOverride?: string;
  env?: NodeJS.ProcessEnv;
  print?: (line: string) => void;
  now?: Date;
}

export type ConnectionState = "not_authenticated" | "authenticated" | "token_expired" | "credentials_corrupt";

export interface StatusReport {
  connectionState: ConnectionState;
  acsUrl?: string;
  deviceId?: string;
  deviceName?: string;
  principal?: string;
  accessTokenExpiresAt?: string;
  scopes?: string[];
}

export function runStatus(options: StatusOptions = {}): StatusReport {
  const print = options.print ?? ((line: string) => console.log(line));
  const path = options.credentialsPathOverride ?? credentialsPath(options.env);
  const now = options.now ?? new Date();

  let credentials: StoredCredentials | undefined;
  try {
    credentials = readCredentials(path);
  } catch (error) {
    // A corrupt credentials file is the one state `acs auth status` must survive: it is the
    // command an operator runs to diagnose a broken CLI. Report it as a state, not a crash.
    if (!(error instanceof CredentialsFileCorruptError)) throw error;
    print(error.message);
    return { connectionState: "credentials_corrupt" };
  }

  if (!credentials?.session) {
    print("Not authenticated. Run `acs auth login`.");
    return { connectionState: "not_authenticated" };
  }

  const expired = Date.parse(credentials.session.accessTokenExpiresAt) <= now.getTime();
  const report: StatusReport = {
    connectionState: expired ? "token_expired" : "authenticated",
    acsUrl: credentials.acsUrl,
    deviceId: credentials.session.deviceId,
    deviceName: credentials.deviceName,
    principal: credentials.session.principal,
    accessTokenExpiresAt: credentials.session.accessTokenExpiresAt,
    scopes: credentials.session.scopes
  };

  print(`User: ${report.principal}`);
  print(`Device: ${report.deviceName}`);
  print(`Device ID: ${report.deviceId}`);
  print(`ACS: ${report.acsUrl}`);
  print(`Scopes: ${report.scopes?.join(", ") ?? ""}`);
  print(`Token expires: ${report.accessTokenExpiresAt}`);
  print(`Connection state: ${report.connectionState}${expired ? " (run `acs auth login` again)" : ""}`);

  return report;
}
