import { ControlStackError, createId } from "@agent-control-stack/shared";
import { z } from "zod";
import { SecretHandle } from "./handle.js";
import type { SecretSource } from "./source.js";

const scopeNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

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

/**
 * Structured, non-secret events for lease()/revoke() calls. This is
 * intentionally not wired into the real hash-chained audit_events table
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
      issuedAt: string;
      expiresAt: string;
    }
  | {
      type: "secret.lease_denied";
      scope: string;
      reason: "scope_not_allowlisted" | "invalid_ttl" | "ttl_exceeds_max" | "secret_unavailable";
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
  onEvent?: (event: SecretBrokerEvent) => void;
  /** Clock injection for deterministic TTL/expiry tests. Defaults to the real clock. */
  now?: () => Date;
}

interface LeaseRecord {
  handleId: string;
  scope: string;
  value: string;
  injectAs: string;
  expiresAt: Date;
  revoked: boolean;
}

/**
 * Scoped credential leasing. Mirrors packages/work-items' lease model
 * (packages/work-items/src/store.ts's claimNextApprovedWorkItem /
 * failExpiredLeases / hashLeaseToken): a lease is issued with a bounded
 * TTL, is single-owner, and becomes unusable the instant it expires or is
 * revoked - no silent no-op, no stale value. Unlike that package's leases,
 * these are in-memory only and hold raw secret material rather than an
 * opaque token, so there is nothing to hash-at-rest here; the equivalent
 * discipline is enforced by SecretHandle never exposing the raw value
 * itself (see handle.ts) and by this broker being the only thing that ever
 * reads `LeaseRecord.value`.
 */
export class SecretBroker {
  private readonly scopes: ReadonlyMap<string, SecretScopeConfig>;
  private readonly source: SecretSource;
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
    this.onEvent = options.onEvent ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
  }

  async lease(scope: string, ttlMs: number): Promise<SecretHandle> {
    const config = this.scopes.get(scope);
    if (!config) {
      this.emit({ type: "secret.lease_denied", scope, reason: "scope_not_allowlisted" });
      throw new ControlStackError("secret_scope_not_allowed", `scope is not allowlisted: ${scope}`);
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      this.emit({ type: "secret.lease_denied", scope, reason: "invalid_ttl" });
      throw new ControlStackError("secret_lease_invalid_ttl", `ttlMs must be a positive number, got: ${ttlMs}`);
    }
    if (ttlMs > config.maxTtlMs) {
      this.emit({ type: "secret.lease_denied", scope, reason: "ttl_exceeds_max" });
      throw new ControlStackError(
        "secret_lease_ttl_exceeds_max",
        `requested ttlMs ${ttlMs} exceeds the max ${config.maxTtlMs} configured for scope "${scope}"`
      );
    }

    // Only reachable once scope + ttl are both already valid - an
    // unconfigured scope never touches the source.
    const value = this.source.resolve(scope);
    if (value === undefined) {
      this.emit({ type: "secret.lease_denied", scope, reason: "secret_unavailable" });
      throw new ControlStackError(
        "secret_unavailable",
        `scope "${scope}" is allowlisted but no secret value is currently available for it`
      );
    }

    const handleId = createId("secret");
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + ttlMs);
    const injectAs = config.injectAs ?? scope;

    this.leases.set(handleId, { handleId, scope, value, injectAs, expiresAt, revoked: false });

    const handle = new SecretHandle({
      handleId,
      scope,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      inject: (env) => this.injectHandle(handleId, env)
    });

    this.emit({
      type: "secret.lease_granted",
      handleId,
      scope,
      ttlMs,
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

  private injectHandle(handleId: string, env: NodeJS.ProcessEnv): void {
    const record = this.leases.get(handleId);
    if (!record) {
      throw new ControlStackError("secret_handle_unknown", "secret handle is not recognized by this broker");
    }
    if (record.revoked) {
      throw new ControlStackError("secret_handle_revoked", "secret handle has been revoked");
    }
    if (this.now().getTime() >= record.expiresAt.getTime()) {
      throw new ControlStackError("secret_handle_expired", "secret handle has expired");
    }
    env[record.injectAs] = record.value;
  }

  private emit(event: SecretBrokerEvent): void {
    this.onEvent(event);
  }
}
