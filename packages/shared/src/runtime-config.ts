import { z } from "zod";

/** Versioned, process-independent runtime configuration contract. */
export const RUNTIME_CONFIG_VERSION = 1 as const;

const optionalUrl = z.string().url();
const authSchema = z
  .object({
    mode: z.enum(["none", "local_bearer", "oauth", "tunnel_id"]),
    localBearerToken: z.string().min(1).optional(),
    oauthIssuer: optionalUrl.optional(),
    oauthAudience: optionalUrl.optional(),
    oauthJwksUri: optionalUrl.optional(),
    trustedTunnelProxy: z.string().min(1).optional()
  })
  .strict()
  .superRefine((auth, ctx) => {
    const oauth = [auth.oauthIssuer, auth.oauthAudience, auth.oauthJwksUri];
    if (oauth.some(Boolean) && !oauth.every(Boolean)) {
      ctx.addIssue({
        code: "custom",
        path: ["oauth"],
        message: "OAuth issuer, audience, and JWKS URI must be set together"
      });
    }
    if (auth.mode === "oauth" && !oauth.every(Boolean)) {
      ctx.addIssue({ code: "custom", path: ["mode"], message: "oauth mode requires complete OAuth settings" });
    }
    if (auth.mode === "tunnel_id" && !auth.trustedTunnelProxy) {
      ctx.addIssue({
        code: "custom",
        path: ["trustedTunnelProxy"],
        message: "tunnel_id mode requires a trusted tunnel proxy"
      });
    }
    if (auth.mode !== "oauth" && oauth.some(Boolean)) {
      ctx.addIssue({ code: "custom", path: ["mode"], message: "OAuth settings require oauth mode" });
    }
    if (auth.mode !== "tunnel_id" && auth.trustedTunnelProxy) {
      ctx.addIssue({ code: "custom", path: ["mode"], message: "trusted tunnel proxy requires tunnel_id mode" });
    }
  });

export const runtimeConfigSchema = z
  .object({
    version: z.literal(RUNTIME_CONFIG_VERSION),
    environment: z.enum(["development", "test", "production"]),
    gateway: z.object({ host: z.string().min(1), port: z.number().int().min(1).max(65_535) }).strict(),
    database: z.object({ path: z.string().min(1) }).strict(),
    auth: authSchema,
    scheduler: z.object({ configPath: z.string().min(1).optional() }).strict(),
    machineController: z.object({ configPath: z.string().min(1).optional() }).strict(),
    sandbox: z.object({ integration: z.boolean() }).strict()
  })
  .strict()
  .superRefine((config, ctx) => {
    const remote = !["127.0.0.1", "::1", "localhost"].includes(config.gateway.host);
    if (config.environment === "production" && remote && config.auth.mode === "none") {
      ctx.addIssue({
        code: "custom",
        path: ["auth", "mode"],
        message: "remote production binding requires authentication"
      });
    }
    if (config.environment === "production" && config.auth.mode === "local_bearer") {
      ctx.addIssue({
        code: "custom",
        path: ["auth", "mode"],
        message: "local bearer authentication is development-only"
      });
    }
  });

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
export const RUNTIME_SECRET_FIELDS = ["auth.localBearerToken"] as const;

const knownAcsKeys = new Set([
  "ACS_CONFIG_VERSION",
  "ACS_DB_PATH",
  "ACS_GATEWAY_TOKEN",
  "ACS_AUTH_MODE",
  "ACS_OAUTH_ISSUER",
  "ACS_OAUTH_AUDIENCE",
  "ACS_OAUTH_JWKS_URI",
  "ACS_TRUSTED_TUNNEL_PROXY",
  "ACS_SCHEDULE_CONFIG_PATH",
  "ACS_MACHINE_CONTROLLER_CONFIG",
  "ACS_SANDBOX_INTEGRATION"
]);

function value(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function boolean(value: string | undefined, key: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error(`${key} must be true, false, 1, or 0`);
}

/** Load once at process startup. Unknown ACS_* keys are rejected in production. */
export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const production = env.NODE_ENV === "production";
  const unknown = Object.keys(env).filter((key) => key.startsWith("ACS_") && !knownAcsKeys.has(key));
  if (production && unknown.length > 0)
    throw new Error(`unknown runtime configuration keys: ${unknown.sort().join(", ")}`);

  // Compatibility migration: HOST/PORT remain accepted for one release; ACS_CONFIG_VERSION
  // makes the migration explicit without allowing a second parser to emerge.
  const version = value(env, "ACS_CONFIG_VERSION");
  if (version !== undefined && version !== String(RUNTIME_CONFIG_VERSION))
    throw new Error(`unsupported ACS_CONFIG_VERSION: ${version}`);
  const environment = env.NODE_ENV === "production" ? "production" : env.NODE_ENV === "test" ? "test" : "development";
  const mode = (value(env, "ACS_AUTH_MODE") ??
    (value(env, "ACS_OAUTH_ISSUER") || value(env, "ACS_OAUTH_AUDIENCE") || value(env, "ACS_OAUTH_JWKS_URI")
      ? "oauth"
      : value(env, "ACS_GATEWAY_TOKEN") || value(env, "ACS_MCP_BEARER_TOKEN")
        ? "local_bearer"
        : "none")) as RuntimeConfig["auth"]["mode"];
  const parsed = runtimeConfigSchema.safeParse({
    version: RUNTIME_CONFIG_VERSION,
    environment,
    gateway: {
      host: value(env, "HOST") ?? "127.0.0.1",
      port: value(env, "PORT") === undefined ? 3000 : Number(value(env, "PORT"))
    },
    database: { path: value(env, "ACS_DB_PATH") ?? "storage/local.db" },
    auth: {
      mode,
      localBearerToken: value(env, "ACS_GATEWAY_TOKEN") ?? value(env, "ACS_MCP_BEARER_TOKEN"),
      oauthIssuer: value(env, "ACS_OAUTH_ISSUER"),
      oauthAudience: value(env, "ACS_OAUTH_AUDIENCE"),
      oauthJwksUri: value(env, "ACS_OAUTH_JWKS_URI"),
      trustedTunnelProxy: value(env, "ACS_TRUSTED_TUNNEL_PROXY")
    },
    scheduler: { configPath: value(env, "ACS_SCHEDULE_CONFIG_PATH") },
    machineController: { configPath: value(env, "ACS_MACHINE_CONTROLLER_CONFIG") },
    sandbox: { integration: boolean(value(env, "ACS_SANDBOX_INTEGRATION"), "ACS_SANDBOX_INTEGRATION") ?? false }
  });
  if (!parsed.success) throw new Error(`invalid runtime configuration: ${formatRuntimeConfigIssues(parsed.error)}`);
  return parsed.data;
}

export function formatRuntimeConfigIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ");
}

export function redactRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
  return {
    ...config,
    auth: { ...config.auth, localBearerToken: config.auth.localBearerToken ? "[REDACTED]" : undefined }
  };
}
