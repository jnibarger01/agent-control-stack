import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProductionConfigError,
  isStrictConfigMode,
  reportProductionConfigFailure,
  validateProductionConfig
} from "./production-config.js";
import { startGateway } from "./server.js";

const VALID_CREDENTIALS = JSON.stringify([
  {
    id: "operator",
    token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    actor: "operator",
    actorId: "operator-1",
    roles: ["operator"],
    scopes: ["acs:read", "acs:write"]
  }
]);

async function freeLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate loopback port")));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

const OAUTH = {
  ACS_OAUTH_ISSUER: "https://issuer.example",
  ACS_OAUTH_AUDIENCE: "https://acs.example/mcp",
  ACS_OAUTH_JWKS_URI: "https://issuer.example/jwks"
} as const;

describe("production config fail-fast validator", () => {
  const envSnapshots: Array<{ key: string; value: string | undefined }> = [];

  afterEach(() => {
    while (envSnapshots.length > 0) {
      const entry = envSnapshots.pop()!;
      if (entry.value === undefined) delete process.env[entry.key];
      else process.env[entry.key] = entry.value;
    }
  });

  function setEnv(key: string, value: string | undefined): void {
    envSnapshots.push({ key, value: process.env[key] });
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  it("treats production and ACS_STRICT_CONFIG as strict", () => {
    expect(isStrictConfigMode({})).toBe(false);
    expect(isStrictConfigMode({ NODE_ENV: "development" })).toBe(false);
    expect(isStrictConfigMode({ NODE_ENV: "production" })).toBe(true);
    expect(isStrictConfigMode({ ACS_STRICT_CONFIG: "1" })).toBe(true);
  });

  it("stays permissive for local/dev omissions", () => {
    expect(() =>
      validateProductionConfig({
        HOST: "0.0.0.0",
        NODE_ENV: "development"
      })
    ).not.toThrow();
  });

  it("collects missing production keys into one structured error", () => {
    expect(() =>
      validateProductionConfig({
        NODE_ENV: "production",
        HOST: "0.0.0.0",
        ACS_DB_PATH: join("/proc", "acs-no-write", "control.db")
      })
    ).toThrow(ProductionConfigError);

    try {
      validateProductionConfig({
        NODE_ENV: "production",
        HOST: "0.0.0.0",
        ACS_DB_PATH: join("/proc", "acs-no-write", "control.db")
      });
      expect.unreachable("expected ProductionConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ProductionConfigError);
      const typed = error as ProductionConfigError;
      expect(typed.toJSON()).toMatchObject({ error: "production_config_invalid" });
      const keys = typed.issues.map((issue) => issue.key);
      expect(keys).toContain("ACS_GATEWAY_CREDENTIALS_JSON");
      expect(keys).toContain("ACS_MCP_ALLOWED_ORIGINS");
      expect(keys).toContain("ACS_AUTH_MODE");
      expect(keys).toContain("ACS_DB_PATH");
    }
  });

  it("accepts a complete remote production configuration", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-prod-config-"));
    try {
      expect(() =>
        validateProductionConfig({
          NODE_ENV: "production",
          HOST: "0.0.0.0",
          ACS_DB_PATH: join(dir, "control.db"),
          ACS_GATEWAY_CREDENTIALS_JSON: VALID_CREDENTIALS,
          ACS_MCP_ALLOWED_ORIGINS: "https://acs.example",
          ...OAUTH
        })
      ).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts trusted tunnel auth instead of OAuth for remote bind", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-prod-config-"));
    try {
      expect(() =>
        validateProductionConfig({
          ACS_STRICT_CONFIG: "1",
          HOST: "0.0.0.0",
          ACS_DB_PATH: join(dir, "control.db"),
          ACS_GATEWAY_CREDENTIALS_JSON: VALID_CREDENTIALS,
          ACS_MCP_ALLOWED_ORIGINS: "https://acs.example",
          ACS_AUTH_MODE: "tunnel_id",
          ACS_TRUSTED_TUNNEL_PROXY: "10.0.0.1"
        })
      ).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects incomplete OAuth and local-dev opt-in in strict mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-prod-config-"));
    try {
      try {
        validateProductionConfig({
          NODE_ENV: "production",
          HOST: "127.0.0.1",
          ACS_DB_PATH: join(dir, "control.db"),
          ACS_GATEWAY_CREDENTIALS_JSON: VALID_CREDENTIALS,
          ACS_OAUTH_ISSUER: "https://issuer.example",
          ACS_ENABLE_TEST_AGENT_RUN_FOR_LOCAL_DEVELOPMENT: "1"
        });
        expect.unreachable("expected ProductionConfigError");
      } catch (error) {
        const typed = error as ProductionConfigError;
        const keys = typed.issues.map((issue) => issue.key);
        expect(keys).toContain("ACS_OAUTH_AUDIENCE");
        expect(keys).toContain("ACS_OAUTH_JWKS_URI");
        expect(keys).toContain("ACS_ENABLE_TEST_AGENT_RUN_FOR_LOCAL_DEVELOPMENT");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unwritable database directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-prod-config-ro-"));
    try {
      chmodSync(dir, 0o555);
      try {
        validateProductionConfig({
          NODE_ENV: "production",
          HOST: "127.0.0.1",
          ACS_DB_PATH: join(dir, "nested", "control.db"),
          ACS_GATEWAY_CREDENTIALS_JSON: VALID_CREDENTIALS
        });
        expect.unreachable("expected ProductionConfigError");
      } catch (error) {
        expect((error as ProductionConfigError).issues.some((issue) => issue.key === "ACS_DB_PATH")).toBe(true);
      }
    } finally {
      chmodSync(dir, 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints one structured error payload", () => {
    const error = new ProductionConfigError([
      { key: "ACS_GATEWAY_CREDENTIALS_JSON", message: "required" },
      { key: "ACS_DB_PATH", message: "not writable" }
    ]);
    const write = vi.fn();
    reportProductionConfigFailure(error, { write });
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(write.mock.calls[0]![0]).trim())).toEqual({
      error: "production_config_invalid",
      issues: error.issues
    });
  });

  it("production boot with a required key missing exits before listen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-boot-fail-"));
    try {
      setEnv("NODE_ENV", "production");
      setEnv("HOST", "127.0.0.1");
      setEnv("PORT", "0");
      setEnv("ACS_GATEWAY_CREDENTIALS_JSON", undefined);
      setEnv("ACS_STRICT_CONFIG", undefined);
      setEnv("ACS_DB_PATH", join(dir, "control.db"));
      setEnv("ACS_OAUTH_ISSUER", undefined);
      setEnv("ACS_OAUTH_AUDIENCE", undefined);
      setEnv("ACS_OAUTH_JWKS_URI", undefined);
      setEnv("ACS_AUTH_MODE", undefined);
      setEnv("ACS_MCP_ALLOWED_ORIGINS", undefined);
      setEnv("ACS_ENABLE_TEST_AGENT_RUN_FOR_LOCAL_DEVELOPMENT", undefined);

      await expect(startGateway()).rejects.toBeInstanceOf(ProductionConfigError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("local/dev boot with the same omission still starts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-boot-ok-"));
    const port = await freeLoopbackPort();
    setEnv("NODE_ENV", "development");
    setEnv("HOST", "127.0.0.1");
    setEnv("PORT", String(port));
    setEnv("ACS_GATEWAY_CREDENTIALS_JSON", undefined);
    setEnv("ACS_STRICT_CONFIG", undefined);
    setEnv("ACS_DB_PATH", join(dir, "control.db"));
    setEnv("ACS_OAUTH_ISSUER", undefined);
    setEnv("ACS_OAUTH_AUDIENCE", undefined);
    setEnv("ACS_OAUTH_JWKS_URI", undefined);
    setEnv("ACS_AUTH_MODE", undefined);
    setEnv("ACS_MCP_ALLOWED_ORIGINS", undefined);
    setEnv("ACS_ENABLE_TEST_AGENT_RUN_FOR_LOCAL_DEVELOPMENT", undefined);
    setEnv("ACS_GATEWAY_TOKEN", undefined);

    const app = await startGateway();
    try {
      expect(app.server.listening).toBe(true);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
