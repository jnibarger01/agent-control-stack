import { ControlStackError, createId } from "@agent-control-stack/shared";
import { z } from "zod";
import { SecretHandle } from "./handle.js";
import type { SecretSource } from "./source.js";

const scopeNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

/**
 * Who a lease is issued to, and who may redeem it. Every field is required:
 * a lease bound to nothing is a lease anyone could claim. Redemption
 * (injectInto) re-checks this exact tuple against whoever is calling it, so
 * a handle that leaks into the wrong engine adapter or gets replayed
 * against a different attempt is refused, not silently honored.
 */
export interface LeasePrincipal {
  workerId: string;
  workItemId: string;
  attemptId: string;
  engineId: string;
}

export const leasePrincipalSchema = z
  .object({
    workerId: identifierSchema,
    workItemId: identifierSchema,
    attemptId: identifierSchema,
    engineId: identifierSchema
  })
  .strict();

export interface SecretScopeConfig {
  /** Longest TTL a caller may request for this scope. lease() fails closed above it. */
  maxTtlMs: number;
  /**
   * The env var name injectInto() writes the secret under. Defaults to the
   * scope name itself, so a scope named e.g. "OPENAI_API_KEY" needs no
   * extra configuration to inject correctly.
   */
  injectAs?: string;
}

export interface LeaseRequest {
  scope: string;
  ttlMs: number;
  /** Who this lease is for. Redemption is refused for anyone else. */
  principal: LeasePrincipal;
  /** Why this lease exists (e.g. "codex-engine-invocation"), for audit - never used for access control decisions. */
  purpose: string;
  /**
   * How many times injectInto() may succeed before the handle is spent.
   * Defaults to 1 (one-time use) - the safe default for a value that gets
   * injected into exactly one subprocess launch. A caller must opt in
   * explicitly to request more, and still bounded to a sane maximum.
   */
  maxUses?: number;
}

/**
 * Structured, non-secret events for lease()/revoke()/redemption calls. This
 * is intentionally not wired into the real hash-chained audit_events table
 * (packages/work-items' SqliteWorkItemStore.appendAuditEvent) - that
 * requires a work item / actor / lease context this package does not have
 * and is out of scope here. A real caller (e.g. apps/worker or
 * apps/gateway, once either actually spawns engine subprocesses that need
 * leased credentials) should pass an onEvent that turns these into real
 * audit events via packages/work-items, the same way other control-plane
 * decisions are recorded.
 */
export type SecretBrokerEvent =
  | {
      type: "secret.lease_granted";
      handleId: string;
      scope: string;
      ttlMs: number;
      principal: LeasePrincipal;
      purpose: string;
      maxUses: number;
      issuedAt: string;
      expiresAt: string;
    }
  | {
      type: "secret.lease_denied";
      scope: string;
      principal?: LeasePrincipal;
      reason:
        | "scope_not_allowlisted"
        | "invalid_ttl"
        | "ttl_exceeds_max"
        | "invalid_max_uses"
        | "secret_unavailable"
        | "not_authorized";
    }
  | {
      type: "secret.redeemed";
      handleId: string;
      scope: string;
      principal: LeasePrincipal;
      usesRemaining: number;
    }
  | {
      type: "secret.redemption_denied";
      handleId: string;
      scope: string;
      reason: "unknown" | "revoked" | "expired" | "principal_mismatch" | "uses_exhausted";
    }
  | {
      type: "secret.revoked";
      handleId: string;
      scope: string;
      reason: "explicit" | "already_inactive";
    };

export interface SecretBrokerOptions {
  /** Deny-by-default allowlist: only scopes listed here can ever be leased. */
  scopes: Record<string, SecretScopeConfig>;
  source: SecretSource;
  /**
   * Optional authoritative authorization hook (e.g. backed by
   * packages/work-items' getCommandAuthority) - if supplied, a lease
   * request is refused unless it returns true. Defaults to allowing any
   * request that already passed the scope/ttl checks, since this package
   * has no store dependency of its own to authorize against; a real
   * deployment should supply one once it has an attempt/lease authority to
   * check against.
   */
  authorize?: (request: LeaseRequest) => boolean;
  onEvent?: (event: SecretBrokerEvent) => void;
  /** Clock injection for deterministic TTL/expiry tests. Defaults to the real clock. */
  now?: () => Date;
}

interface LeaseRecord {
  handleId: string;
  scope: string;
  value: string;
  injectAs: string;
  principal: LeasePrincipal;
  purpose: string;
  maxUses: number;
  usesRemaining: number;
  expiresAt: Date;
  revoked: boolean;
}

const MAX_ALLOWED_USES = 1_000;

/**
 * Scoped credential leasing. Mirrors packages/work-items' lease model
 * (packages/work-items/src/store.ts's leaseAttempt / attempt_leases): a
 * lease is issued with a bounded TTL, is bound to an exact principal
 * (worker/work item/attempt/engine), and becomes unusable the instant it
 * expires, is revoked, is redeemed by the wrong principal, or exhausts its
 * use count - no silent no-op, no stale value, no ambient reuse. Unlike
 * that package's leases, these are in-memory only and hold raw secret
 * material rather than an opaque token, so there is nothing to hash-at-rest
 * here; the equivalent discipline is enforced by SecretHandle never
 * exposing the raw value itself (see handle.ts) and by this broker being
 * the only thing that ever reads `LeaseRecord.value`.
 */
export class SecretBroker {
  private readonly scopes: ReadonlyMap<string, SecretScopeConfig>;
  private readonly source: SecretSource;
  private readonly authorize: (request: LeaseRequest) => boolean;
  private readonly onEvent: (event: SecretBrokerEvent) => void;
  private readonly now: () => Date;
  private readonly leases = new Map<string, LeaseRecord>();

  constructor(options: SecretBrokerOptions) {
    const entries = Object.entries(options.scopes);
    if (entries.length === 0) {
      throw new ControlStackError("secret_broker_no_scopes", "SecretBroker requires at least one configured scope");
    }
    for (const [scope, config] of entries) {
      scopeNameSchema.parse(scope);
      if (!Number.isFinite(config.maxTtlMs) || config.maxTtlMs <= 0) {
        throw new ControlStackError(
          "secret_broker_invalid_scope",
          `scope "${scope}" has an invalid maxTtlMs (must be a positive finite number)`
        );
      }
    }
    this.scopes = new Map(entries);
    this.source = options.source;
    this.authorize = options.authorize ?? (() => true);
    this.onEvent = options.onEvent ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
  }

  async lease(request: LeaseRequest): Promise<SecretHandle> {
    const { scope, ttlMs } = request;
    const principal = leasePrincipalSchema.parse(request.principal);
    if (!request.purpose || request.purpose.trim().length === 0) {
      throw new ControlStackError("secret_lease_invalid_purpose", "purpose is required and must be non-empty");
    }

    const config = this.scopes.get(scope);
    if (!config) {
      this.emit({ type: "secret.lease_denied", scope, principal, reason: "scope_not_allowlisted" });
      throw new ControlStackError("secret_scope_not_allowed", `scope is not allowlisted: ${scope}`);
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      this.emit({ type: "secret.lease_denied", scope, principal, reason: "invalid_ttl" });
      throw new ControlStackError("secret_lease_invalid_ttl", `ttlMs must be a positive number, got: ${ttlMs}`);
    }
    if (ttlMs > config.maxTtlMs) {
      this.emit({ type: "secret.lease_denied", scope, principal, reason: "ttl_exceeds_max" });
      throw new ControlStackError(
        "secret_lease_ttl_exceeds_max",
        `requested ttlMs ${ttlMs} exceeds the max ${config.maxTtlMs} configured for scope "${scope}"`
      );
    }
    const maxUses = request.maxUses ?? 1;
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > MAX_ALLOWED_USES) {
      this.emit({ type: "secret.lease_denied", scope, principal, reason: "invalid_max_uses" });
      throw new ControlStackError(
        "secret_lease_invalid_max_uses",
        `maxUses must be an integer between 1 and ${MAX_ALLOWED_USES}, got: ${maxUses}`
      );
    }
    if (!this.authorize({ ...request, principal, maxUses })) {
      this.emit({ type: "secret.lease_denied", scope, principal, reason: "not_authorized" });
      throw new ControlStackError(
        "secret_lease_not_authorized",
        `lease request for scope "${scope}" was not authorized`
      );
    }

    // Only reachable once scope, ttl, use count, and authorization are all
    // already valid - an unconfigured or unauthorized request never
    // touches the source.
    const value = this.source.resolve(scope);
    if (value === undefined) {
      this.emit({ type: "secret.lease_denied", scope, principal, reason: "secret_unavailable" });
      throw new ControlStackError(
        "secret_unavailable",
        `scope "${scope}" is allowlisted but no secret value is currently available for it`
      );
    }

    const handleId = createId("secret");
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + ttlMs);
    const injectAs = config.injectAs ?? scope;

    this.leases.set(handleId, {
      handleId,
      scope,
      value,
      injectAs,
      principal,
      purpose: request.purpose,
      maxUses,
      usesRemaining: maxUses,
      expiresAt,
      revoked: false
    });

    const handle = new SecretHandle({
      handleId,
      scope,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      principal,
      purpose: request.purpose,
      maxUses,
      inject: (env, redeemer) => this.injectHandle(handleId, env, redeemer)
    });

    this.emit({
      type: "secret.lease_granted",
      handleId,
      scope,
      ttlMs,
      principal,
      purpose: request.purpose,
      maxUses,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString()
    });

    return handle;
  }

  // Idempotent by design: revoking twice, or revoking a handle that has
  // already expired on its own, must never throw - a caller doing best-effort
  // cleanup (e.g. in a finally block after a subprocess exits) shouldn't have
  // to first check whether someone else already revoked it.
  async revoke(handle: SecretHandle): Promise<void> {
    const record = this.leases.get(handle.handleId);
    if (!record || record.revoked) {
      this.emit({ type: "secret.revoked", handleId: handle.handleId, scope: handle.scope, reason: "already_inactive" });
      return;
    }
    record.revoked = true;
    this.emit({ type: "secret.revoked", handleId: handle.handleId, scope: handle.scope, reason: "explicit" });
  }

  private injectHandle(handleId: string, env: NodeJS.ProcessEnv, redeemer: LeasePrincipal): void {
    const record = this.leases.get(handleId);
    if (!record) {
      throw new ControlStackError("secret_handle_unknown", "secret handle is not recognized by this broker");
    }
    if (record.revoked) {
      this.emit({ type: "secret.redemption_denied", handleId, scope: record.scope, reason: "revoked" });
      throw new ControlStackError("secret_handle_revoked", "secret handle has been revoked");
    }
    if (this.now().getTime() >= record.expiresAt.getTime()) {
      this.emit({ type: "secret.redemption_denied", handleId, scope: record.scope, reason: "expired" });
      throw new ControlStackError("secret_handle_expired", "secret handle has expired");
    }
    const parsedRedeemer = leasePrincipalSchema.parse(redeemer);
    if (!principalsEqual(record.principal, parsedRedeemer)) {
      this.emit({ type: "secret.redemption_denied", handleId, scope: record.scope, reason: "principal_mismatch" });
      throw new ControlStackError(
        "secret_handle_principal_mismatch",
        "redeeming context does not match the principal this handle was leased for"
      );
    }
    if (record.usesRemaining <= 0) {
      this.emit({ type: "secret.redemption_denied", handleId, scope: record.scope, reason: "uses_exhausted" });
      throw new ControlStackError(
        "secret_handle_uses_exhausted",
        "secret handle has already been redeemed its maximum number of times"
      );
    }
    // Check-then-decrement is safe here without a separate lock: this
    // package's lease table is only ever mutated synchronously (no I/O,
    // no await, between the check above and this line), so there is no
    // interleaving window a concurrent redemption could land in.
    record.usesRemaining -= 1;
    env[record.injectAs] = record.value;
    this.emit({
      type: "secret.redeemed",
      handleId,
      scope: record.scope,
      principal: record.principal,
      usesRemaining: record.usesRemaining
    });
  }

  private emit(event: SecretBrokerEvent): void {
    this.onEvent(event);
  }
}

function principalsEqual(a: LeasePrincipal, b: LeasePrincipal): boolean {
  return (
    a.workerId === b.workerId &&
    a.workItemId === b.workItemId &&
    a.attemptId === b.attemptId &&
    a.engineId === b.engineId
  );
}
