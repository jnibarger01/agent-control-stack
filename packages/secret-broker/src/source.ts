/**
 * A pluggable backend that resolves the raw secret material for a scope.
 *
 * `resolve` must not throw for a scope it simply has no material for - it
 * returns `undefined` and lets SecretBroker.lease() turn that into a
 * fail-closed ControlStackError. This keeps "scope is not allowlisted" and
 * "scope is allowlisted but the source has nothing for it right now" as two
 * distinct, deliberate broker-side decisions instead of letting an arbitrary
 * source implementation decide how to fail.
 */
export interface SecretSource {
  resolve(scope: string): string | undefined;
}

/**
 * The only SecretSource this repository actually has real backing for
 * today: a fixed scope -> environment-variable-name mapping read from
 * `process.env` (or an injected map, for tests). No secrets-manager
 * integration (Vault, AWS Secrets Manager, etc.) exists anywhere in this
 * codebase yet, so this class does not pretend to be one - wiring a real
 * secrets manager in later is a matter of implementing SecretSource against
 * that backend; SecretBroker itself does not need to change.
 */
export class EnvSecretSource implements SecretSource {
  private readonly mapping: ReadonlyMap<string, string>;
  private readonly source: NodeJS.ProcessEnv;

  constructor(scopeToEnvVarName: Record<string, string>, source: NodeJS.ProcessEnv = process.env) {
    this.mapping = new Map(Object.entries(scopeToEnvVarName));
    this.source = source;
  }

  resolve(scope: string): string | undefined {
    const envVarName = this.mapping.get(scope);
    if (envVarName === undefined) return undefined;
    return this.source[envVarName];
  }
}
