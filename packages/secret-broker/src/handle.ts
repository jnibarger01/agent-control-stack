import type { LeasePrincipal } from "./broker.js";

/**
 * A capability token for a single leased secret, never a container for the
 * secret itself.
 *
 * SecretBroker keeps the raw value in its own private lease table, keyed by
 * handleId; this class only ever holds a closure (`#inject`) back into that
 * table. That closure is a genuine ECMAScript private field (`#inject`, not
 * TypeScript's compile-time-only `private`), so it is not an own enumerable
 * property - it is invisible to `Object.keys`, `Object.values`,
 * `JSON.stringify`, `for...in`, and `Object.getOwnPropertyNames`. There is
 * no getter, no `toString`/`toJSON` override, and no other path that turns
 * the raw secret into a string a caller could log or interpolate into an
 * engine prompt: the only way to observe the secret is to call
 * `injectInto`, which writes it directly into a subprocess env object.
 *
 * `handleId`, `scope`, `issuedAt`, `expiresAt`, `principal`, `purpose`, and
 * `maxUses` are plain public fields - none of them are secret, and exposing
 * them is what makes the handle auditable.
 */
export class SecretHandle {
  readonly handleId: string;
  readonly scope: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly principal: LeasePrincipal;
  readonly purpose: string;
  readonly maxUses: number;

  readonly #inject: (env: NodeJS.ProcessEnv, redeemer: LeasePrincipal) => void;

  constructor(params: {
    handleId: string;
    scope: string;
    issuedAt: string;
    expiresAt: string;
    principal: LeasePrincipal;
    purpose: string;
    maxUses: number;
    inject: (env: NodeJS.ProcessEnv, redeemer: LeasePrincipal) => void;
  }) {
    this.handleId = params.handleId;
    this.scope = params.scope;
    this.issuedAt = params.issuedAt;
    this.expiresAt = params.expiresAt;
    this.principal = params.principal;
    this.purpose = params.purpose;
    this.maxUses = params.maxUses;
    this.#inject = params.inject;
  }

  /**
   * Mutates `env` in place, setting the secret's target variable to the
   * live raw value - or throws if this handle's lease is no longer active
   * (expired, revoked, or already redeemed its maximum number of times), or
   * if `redeemer` does not match the principal this handle was leased for.
   * Never returns the value; there is no other way to read it out of this
   * object.
   */
  injectInto(env: NodeJS.ProcessEnv, redeemer: LeasePrincipal): void {
    this.#inject(env, redeemer);
  }
}
