import { readFileSync, statSync } from "node:fs";
import { delimiter } from "node:path";
import type { HealthTarget, QueryConfig } from "@agent-control-stack/looptrace-query";

/**
 * Environment contract (all optional except the DB and a grant + key):
 *   LOOPTRACE_ACS_DB            ACS control-plane SQLite (opened read-only)
 *   LOOPTRACE_GRANT / _FILE     signed grant token for THIS server process (bound at start)
 *   LOOPTRACE_GRANT_KEY_FILE    file with the HMAC key (hex or raw, >=16 bytes, mode 0600/0400)
 *   LOOPTRACE_RELEASE_ROOTS     path-list of release roots, e.g. $HOME/releases
 *   LOOPTRACE_HEALTH_TARGETS    JSON object name -> http(s) URL (operator allowlist for service_healthy)
 *   LOOPTRACE_JC_TRACE_ROOTS    path-list (reserved; JC chain correlation is not enabled in this build)
 *   LOOPTRACE_HERMES_STATE_DB   path (reserved; Hermes correlation is not enabled in this build)
 */
export function readKeyFile(path: string): Buffer {
  const st = statSync(path);
  if (!st.isFile()) throw new Error("grant key path is not a regular file");
  if ((st.mode & 0o077) !== 0) throw new Error("grant key file must not be group/world accessible (use chmod 600)");
  const raw = readFileSync(path, "utf8").trim();
  const key = /^[a-f0-9]{32,}$/iu.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "utf8");
  if (key.length < 16) throw new Error("grant key is shorter than 16 bytes");
  return key;
}

export function configFromEnv(env: NodeJS.ProcessEnv, now: () => Date = () => new Date()): { config: QueryConfig; grant: string | null } {
  const grant = env.LOOPTRACE_GRANT ?? (env.LOOPTRACE_GRANT_FILE ? readFileSync(env.LOOPTRACE_GRANT_FILE, "utf8").trim() : null);
  const health: HealthTarget[] = [];
  if (env.LOOPTRACE_HEALTH_TARGETS) {
    const parsed = JSON.parse(env.LOOPTRACE_HEALTH_TARGETS) as Record<string, unknown>;
    for (const [name, url] of Object.entries(parsed)) {
      if (typeof url !== "string" || !/^https?:\/\//u.test(url) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name)) {
        throw new Error(`invalid LOOPTRACE_HEALTH_TARGETS entry '${name.slice(0, 30)}'`);
      }
      health.push({ name, url });
    }
  }
  const list = (v: string | undefined): string[] => (v ? v.split(delimiter).filter(Boolean) : []);
  return {
    grant,
    config: {
      acsDbPath: env.LOOPTRACE_ACS_DB ?? null,
      jcTraceRoots: list(env.LOOPTRACE_JC_TRACE_ROOTS),
      hermesStateDb: env.LOOPTRACE_HERMES_STATE_DB ?? null,
      releaseRoots: list(env.LOOPTRACE_RELEASE_ROOTS),
      healthTargets: health,
      grantKey: env.LOOPTRACE_GRANT_KEY_FILE ? readKeyFile(env.LOOPTRACE_GRANT_KEY_FILE) : null,
      now
    }
  };
}
