import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductionConfigError, validateProductionConfig } from "./production-config.js";

/**
 * ACS-03: the production preflight must enforce the SAME credential contract the runtime parser
 * (gatewayCredentialSchema) enforces. Otherwise a config the preflight accepts crashes at boot with an
 * unstructured error. All tokens here are synthetic.
 */
import { buildGateway } from "./server.js";

const TOKEN = "SYNTHETIC-token-0123456789abcdef0123456789";
const OAUTH = {
  ACS_OAUTH_ISSUER: "https://issuer.example",
  ACS_OAUTH_AUDIENCE: "https://acs.example/mcp",
  ACS_OAUTH_JWKS_URI: "https://issuer.example/jwks"
} as const;
const good = {
  id: "operator",
  token: TOKEN,
  actor: "user",
  actorId: "operator-1",
  roles: ["operator"],
  scopes: ["acs:read", "acs:write"]
};

function issuesFor(credentials: unknown, extraEnv: Record<string, string> = {}): string[] {
  const dir = mkdtempSync(join(tmpdir(), "acs-cred-shape-"));
  try {
    validateProductionConfig({
      NODE_ENV: "production",
      HOST: "0.0.0.0",
      ACS_DB_PATH: join(dir, "control.db"),
      ACS_MCP_ALLOWED_ORIGINS: "https://acs.example",
      ...OAUTH,
      ...(credentials === undefined ? {} : { ACS_GATEWAY_CREDENTIALS_JSON: JSON.stringify(credentials) }),
      ...extraEnv
    });
    return [];
  } catch (error) {
    if (!(error instanceof ProductionConfigError)) throw error;
    return error.issues.filter((issue) => issue.key === "ACS_GATEWAY_CREDENTIALS_JSON").map((issue) => issue.message);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("ACS_GATEWAY_CREDENTIALS_JSON credential shape (matches the runtime parser)", () => {
  it("accepts the documented shape, including optional expiresAt and status", () => {
    expect(issuesFor([good])).toEqual([]);
    expect(issuesFor([{ ...good, expiresAt: "2030-01-01T00:00:00Z", status: "active" }])).toEqual([]);
  });

  it("rejects a credential with no roles or scopes", () => {
    const { roles: _roles, ...noRoles } = good;
    const { scopes: _scopes, ...noScopes } = good;
    expect(issuesFor([noRoles]).join("|")).toMatch(/roles/);
    expect(issuesFor([noScopes]).join("|")).toMatch(/scopes/);
  });

  it("rejects empty roles or scopes arrays", () => {
    expect(issuesFor([{ ...good, roles: [] }]).join("|")).toMatch(/roles/);
    expect(issuesFor([{ ...good, scopes: [] }]).join("|")).toMatch(/scopes/);
  });

  it("rejects an unknown role", () => {
    expect(issuesFor([{ ...good, roles: ["admin"] }]).join("|")).toMatch(/roles/);
  });

  it("rejects duplicate credential ids", () => {
    expect(issuesFor([good, { ...good, token: `${TOKEN}-2` }]).join("|")).toMatch(/duplicate/);
  });

  it("rejects a malformed expiresAt and an unknown status", () => {
    expect(issuesFor([{ ...good, expiresAt: "tomorrow" }]).join("|")).toMatch(/expiresAt/);
    expect(issuesFor([{ ...good, status: "paused" }]).join("|")).toMatch(/status/);
  });
});

describe("recovery variables are not a credential source", () => {
  it("setting ACS_RECOVERY_* does not satisfy ACS_GATEWAY_CREDENTIALS_JSON", () => {
    const issues = issuesFor(undefined, {
      ACS_RECOVERY_TOKEN: TOKEN,
      ACS_RECOVERY_CREDENTIALS_JSON: JSON.stringify([good])
    });
    expect(issues.join("|")).toMatch(/required/);
  });
});

describe("preflight/runtime credential parity", () => {
  afterEach(() => vi.unstubAllEnvs());
  const cases: [string, unknown, boolean][] = [
    ["valid", [good], true],
    ["valid optional fields", [{ ...good, expiresAt: "2030-01-01T00:00:00+00:00", status: "revoked" }], true],
    ["empty collection", [], false],
    ["not an array", good, false],
    ["null entry", [null], false],
    ["array entry", [[]], false],
    ["missing roles", [{ ...good, roles: undefined }], false],
    ["empty roles", [{ ...good, roles: [] }], false],
    ["invalid role", [{ ...good, roles: ["admin"] }], false],
    ["missing scopes", [{ ...good, scopes: undefined }], false],
    ["empty scopes", [{ ...good, scopes: [] }], false],
    ["empty scope", [{ ...good, scopes: [""] }], false],
    ["duplicate ids", [good, { ...good, token: TOKEN + "2" }], false],
    ["null expiry", [{ ...good, expiresAt: null }], false],
    ["invalid expiry", [{ ...good, expiresAt: "tomorrow" }], false],
    ["invalid status", [{ ...good, status: "paused" }], false],
    ["null status", [{ ...good, status: null }], false],
    ["short token", [{ ...good, token: "short" }], false],
    ["missing actor id", [{ ...good, actorId: undefined }], false]
  ];
  it.each(cases)("agrees for %s", async (_name, credentials, accepted) => {
    expect(issuesFor(credentials).length === 0).toBe(accepted);
    expect(issuesFor(credentials, { NODE_ENV: "development", ACS_STRICT_CONFIG: "1" }).length === 0).toBe(accepted);
    const directory = mkdtempSync(join(tmpdir(), "acs-credential-runtime-"));
    vi.stubEnv("ACS_GATEWAY_CREDENTIALS_JSON", JSON.stringify(credentials));
    vi.stubEnv("ACS_GATEWAY_TOKEN", "");
    try {
      if (!accepted) {
        expect(() => buildGateway({ dbPath: join(directory, "control.db"), logger: false })).toThrow();
      } else {
        const app = buildGateway({ dbPath: join(directory, "control.db"), logger: false });
        try {
          await app.ready();
        } finally {
          await app.close();
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("does not echo credential secrets in structured preflight errors", () => {
    const issues = issuesFor([{ ...good, scopes: [] }]).join("|");
    expect(issues).not.toContain(TOKEN);
  });
});
