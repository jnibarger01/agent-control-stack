import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProductionConfigError, validateProductionConfig } from "./production-config.js";

/**
 * ACS-03: the production preflight must enforce the SAME credential contract the runtime parser
 * (gatewayCredentialSchema) enforces. Otherwise a config the preflight accepts crashes at boot with an
 * unstructured error. All tokens here are synthetic.
 */
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
