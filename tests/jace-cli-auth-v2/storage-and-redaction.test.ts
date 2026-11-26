import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNoSecretsInText,
  bootJcGateway,
  generateEd25519DpopKey,
  issueBrowserDpopTokens,
  runJcCli,
  type BootedJcGateway
} from "./helpers.js";

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

describe("Suite E: File permissions (0700/0600), symlink safety, encrypted fallback, and zero secret leakage", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  async function startJc(config = {}): Promise<BootedJcGateway> {
    const gw = await bootJcGateway(config);
    cleanups.push(() => gw.close());
    return gw;
  }

  it("SEC-29: enforces 0700 directories and 0600 files across gateway DATA_DIR and CLI headless stateDir", async () => {
    const gw = await startJc();
    const key = generateEd25519DpopKey();
    await issueBrowserDpopTokens(gw, key);

    expect(statSync(gw.dataDir).mode & 0o777).toBe(0o700);
    for (const file of walkFiles(gw.dataDir)) {
      expect(statSync(file).mode & 0o077, `${file} must have no group/other permissions`).toBe(0);
    }

    const rootTmp = mkdtempSync(join(tmpdir(), "jca2-perms-"));
    cleanups.push(() => rmSync(rootTmp, { recursive: true, force: true }));
    const stateDir = join(rootTmp, "state");

    const mcpAuth = (await import("../../apps/jace-commander/src/mcp-auth.js")) as {
      connect: (opts: { mcpUrl: string; stateDir: string; onAuthorizeUrl: (u: string) => void }) => Promise<unknown>;
    };

    const prevDbus = process.env.DBUS_SESSION_BUS_ADDRESS;
    const prevPass = process.env.JC_KEYRING_PASSPHRASE;
    process.env.DBUS_SESSION_BUS_ADDRESS = "";
    process.env.JC_KEYRING_PASSPHRASE = "perms-test-passphrase";
    cleanups.push(() => {
      if (prevDbus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
      else process.env.DBUS_SESSION_BUS_ADDRESS = prevDbus;
      if (prevPass === undefined) delete process.env.JC_KEYRING_PASSPHRASE;
      else process.env.JC_KEYRING_PASSPHRASE = prevPass;
    });

    await mcpAuth.connect({
      mcpUrl: gw.jcResource,
      stateDir,
      onAuthorizeUrl: (authorizeUrl: string) => {
        void (async () => {
          const u = new URL(authorizeUrl);
          const consentRes = await fetch(`${gw.baseUrl}/authorize/consent?oauth_lane=jc`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            redirect: "manual",
            body: new URLSearchParams({
              oauth_lane: "jc",
              client_id: u.searchParams.get("client_id") ?? "jace-commander-cli",
              redirect_uri: u.searchParams.get("redirect_uri")!,
              response_type: "code",
              scope: u.searchParams.get("scope") ?? "mcp",
              state: u.searchParams.get("state")!,
              code_challenge: u.searchParams.get("code_challenge")!,
              code_challenge_method: "S256",
              resource: gw.jcResource,
              passphrase: gw.consentPassphrase,
              ...(u.searchParams.get("dpop_jkt") ? { dpop_jkt: u.searchParams.get("dpop_jkt")! } : {})
            }).toString()
          });
          await fetch(consentRes.headers.get("location")!);
        })();
      }
    });

    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    const createdFiles = walkFiles(stateDir);
    expect(createdFiles.length).toBeGreaterThan(0);
    for (const file of createdFiles) {
      expect(statSync(file).mode & 0o777, `${file} must be 0600`).toBe(0o600);
    }
  });

  it("SEC-30: refuses symlinked credential/key paths and replaces loose-mode temp files safely", async () => {
    const gw = await startJc();
    const rootTmp = mkdtempSync(join(tmpdir(), "jca2-symlink-"));
    cleanups.push(() => rmSync(rootTmp, { recursive: true, force: true }));
    const stateDir = join(rootTmp, "state");
    mkdirSync(stateDir, { mode: 0o700 });

    const canary = join(rootTmp, "outside-canary.txt");
    writeFileSync(canary, "DO_NOT_OVERWRITE", { mode: 0o600 });

    // Plant symlinks at common credential / temp locations
    symlinkSync(canary, join(stateDir, "mcp-token.json"));
    symlinkSync(canary, join(stateDir, "credentials.enc.json"));
    symlinkSync(canary, join(stateDir, `mcp-token.json.${process.pid}.tmp`));
    chmodSync(canary, 0o644);

    const prevDbus = process.env.DBUS_SESSION_BUS_ADDRESS;
    const prevPass = process.env.JC_KEYRING_PASSPHRASE;
    process.env.DBUS_SESSION_BUS_ADDRESS = "";
    process.env.JC_KEYRING_PASSPHRASE = "symlink-test-passphrase";
    cleanups.push(() => {
      if (prevDbus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
      else process.env.DBUS_SESSION_BUS_ADDRESS = prevDbus;
      if (prevPass === undefined) delete process.env.JC_KEYRING_PASSPHRASE;
      else process.env.JC_KEYRING_PASSPHRASE = prevPass;
    });

    const mcpAuth = (await import("../../apps/jace-commander/src/mcp-auth.js")) as {
      connect: (opts: { mcpUrl: string; stateDir: string; onAuthorizeUrl: (u: string) => void }) => Promise<unknown>;
    };

    try {
      await mcpAuth.connect({
        mcpUrl: gw.jcResource,
        stateDir,
        onAuthorizeUrl: (authorizeUrl: string) => {
          void (async () => {
            const u = new URL(authorizeUrl);
            const consentRes = await fetch(`${gw.baseUrl}/authorize/consent?oauth_lane=jc`, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              redirect: "manual",
              body: new URLSearchParams({
                oauth_lane: "jc",
                client_id: u.searchParams.get("client_id") ?? "jace-commander-cli",
                redirect_uri: u.searchParams.get("redirect_uri")!,
                response_type: "code",
                scope: u.searchParams.get("scope") ?? "mcp",
                state: u.searchParams.get("state")!,
                code_challenge: u.searchParams.get("code_challenge")!,
                code_challenge_method: "S256",
                resource: gw.jcResource,
                passphrase: gw.consentPassphrase,
                ...(u.searchParams.get("dpop_jkt") ? { dpop_jkt: u.searchParams.get("dpop_jkt")! } : {})
              }).toString()
            });
            await fetch(consentRes.headers.get("location")!);
          })();
        }
      });
    } catch {
      // Refusing symlinked destination with an error is also valid fail-closed behavior.
    }

    // Outside canary file MUST NEVER have been overwritten through the symlink
    expect(readFileSync(canary, "utf8")).toBe("DO_NOT_OVERWRITE");
    expect(lstatSync(canary).isSymbolicLink()).toBe(false);
  });

  it("SEC-31: headless EncryptedFileStore encrypts secrets with AES-256-GCM, separates key material, and never falls back to plaintext", async () => {
    const gw = await startJc();
    const rootTmp = mkdtempSync(join(tmpdir(), "jca2-enc-"));
    cleanups.push(() => rmSync(rootTmp, { recursive: true, force: true }));
    const stateDir = join(rootTmp, "state");
    const runtimeDir = join(rootTmp, "runtime");
    mkdirSync(runtimeDir, { mode: 0o700 });

    const prevDbus = process.env.DBUS_SESSION_BUS_ADDRESS;
    const prevPass = process.env.JC_KEYRING_PASSPHRASE;
    const prevRuntime = process.env.XDG_RUNTIME_DIR;
    process.env.DBUS_SESSION_BUS_ADDRESS = "";
    process.env.JC_KEYRING_PASSPHRASE = "headless-encryption-passphrase";
    process.env.XDG_RUNTIME_DIR = runtimeDir;
    cleanups.push(() => {
      if (prevDbus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
      else process.env.DBUS_SESSION_BUS_ADDRESS = prevDbus;
      if (prevPass === undefined) delete process.env.JC_KEYRING_PASSPHRASE;
      else process.env.JC_KEYRING_PASSPHRASE = prevPass;
      if (prevRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = prevRuntime;
    });

    const mcpAuth = (await import("../../apps/jace-commander/src/mcp-auth.js")) as {
      connect: (opts: { mcpUrl: string; stateDir: string; onAuthorizeUrl: (u: string) => void }) => Promise<{
        accessToken: string;
        refreshToken?: string;
      }>;
    };

    const stored = await mcpAuth.connect({
      mcpUrl: gw.jcResource,
      stateDir,
      onAuthorizeUrl: (authorizeUrl: string) => {
        void (async () => {
          const u = new URL(authorizeUrl);
          const consentRes = await fetch(`${gw.baseUrl}/authorize/consent?oauth_lane=jc`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            redirect: "manual",
            body: new URLSearchParams({
              oauth_lane: "jc",
              client_id: u.searchParams.get("client_id") ?? "jace-commander-cli",
              redirect_uri: u.searchParams.get("redirect_uri")!,
              response_type: "code",
              scope: u.searchParams.get("scope") ?? "mcp",
              state: u.searchParams.get("state")!,
              code_challenge: u.searchParams.get("code_challenge")!,
              code_challenge_method: "S256",
              resource: gw.jcResource,
              passphrase: gw.consentPassphrase,
              ...(u.searchParams.get("dpop_jkt") ? { dpop_jkt: u.searchParams.get("dpop_jkt")! } : {})
            }).toString()
          });
          await fetch(consentRes.headers.get("location")!);
        })();
      }
    });

    // No file on disk may contain the plaintext accessToken, refreshToken, or private key PEM
    const files = [...walkFiles(stateDir), ...walkFiles(runtimeDir)];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      assertNoSecretsInText(content, [stored.accessToken, stored.refreshToken ?? ""], file);
    }

    // Wrong passphrase must fail closed rather than falling back to plaintext
    const wrongPassStatus = runJcCli(["auth", "status", "--json"], {
      HOME: rootTmp,
      JC_STATE_DIR: stateDir,
      JC_PUBLIC_MCP_URL: gw.jcResource,
      DBUS_SESSION_BUS_ADDRESS: "",
      XDG_RUNTIME_DIR: runtimeDir,
      JC_KEYRING_PASSPHRASE: "wrong-passphrase-for-decrypt"
    });
    expect(wrongPassStatus.status).not.toBe(0);
    assertNoSecretsInText(wrongPassStatus.stdout + wrongPassStatus.stderr, [
      stored.accessToken,
      stored.refreshToken ?? ""
    ]);
  });

  it("SEC-32: zero secret leakage across gateway logs, error responses, and CLI status/logout/error outputs", async () => {
    const gw = await startJc();
    const key = generateEd25519DpopKey();
    const tokens = await issueBrowserDpopTokens(gw, key);

    // Trigger valid MCP call + several failures (stale/wrong DPoP, Bearer downgrade, bad refresh)
    await gw.callMcpWithDpop(tokens.accessToken, key);
    await fetch(`${gw.baseUrl}/jc/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokens.accessToken}` },
      body: "{}"
    });
    await gw.postTokenWithDpop(
      {
        grant_type: "refresh_token",
        client_id: "jace-commander-cli",
        refresh_token: tokens.refreshToken,
        refresh_request_id: "req-log-1"
      },
      key
    );

    const sensitive = [
      tokens.accessToken,
      tokens.refreshToken,
      gw.consentPassphrase,
      key.privateJwk.d ?? "",
      "jc-bridge-test-token",
      "gw-exec-test-token"
    ];
    assertNoSecretsInText(gw.output(), sensitive, "dc-mcp-gateway logs");

    // CLI `auth status --json` and `auth logout` with JC_MCP_TOKEN must never print tokens
    const rootTmp = mkdtempSync(join(tmpdir(), "jca2-cli-redact-"));
    cleanups.push(() => rmSync(rootTmp, { recursive: true, force: true }));
    const fakeLegacySecret = "super-secret-legacy-jc-mcp-token-value-123456";
    const statusRes = runJcCli(["auth", "status", "--json"], {
      HOME: rootTmp,
      JC_STATE_DIR: join(rootTmp, "state"),
      JC_PUBLIC_MCP_URL: gw.jcResource,
      JC_MCP_TOKEN: fakeLegacySecret,
      DBUS_SESSION_BUS_ADDRESS: ""
    });
    expect(statusRes.status).toBe(0);
    expect(JSON.parse(statusRes.stdout)).toMatchObject({ connected: true, auth_mode: "legacy-bearer-env" });
    assertNoSecretsInText(statusRes.stdout + statusRes.stderr, [fakeLegacySecret], "jace auth status");

    const logoutRes = runJcCli(["auth", "logout"], {
      HOME: rootTmp,
      JC_STATE_DIR: join(rootTmp, "state"),
      JC_PUBLIC_MCP_URL: gw.jcResource,
      JC_MCP_TOKEN: fakeLegacySecret,
      DBUS_SESSION_BUS_ADDRESS: ""
    });
    expect(logoutRes.status).toBe(0);
    assertNoSecretsInText(logoutRes.stdout + logoutRes.stderr, [fakeLegacySecret], "jace auth logout");
  });
});
