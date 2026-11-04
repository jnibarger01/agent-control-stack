/**
 * Environment for child processes JC starts (start_process, git). Only the
 * names below are forwarded; JC's own capability keys, ACS tokens and any
 * other parent secrets never reach a child.
 */
const FORWARDED = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TERM'] as const;

export function jcChildEnv(extra: Readonly<Record<string, string>> = {}, forward: readonly string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [...FORWARDED, ...forward]) {
    const value = process.env[name];
    if (typeof value === 'string') env[name] = value;
  }
  return { ...env, ...extra };
}
