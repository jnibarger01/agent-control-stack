import { ControlStackError } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import { SecretBroker, type LeasePrincipal, type LeaseRequest, type SecretBrokerEvent } from "./broker.js";
import { EnvSecretSource, type SecretSource } from "./source.js";

const RAW_SECRET_VALUE = "sk-super-secret-do-not-log-me";

function principal(overrides: Partial<LeasePrincipal> = {}): LeasePrincipal {
  return {
    workerId: "worker_1",
    workItemId: "wrk_1",
    attemptId: "attempt_1",
    engineId: "codex",
    ...overrides
  };
}

function mutableClock(startMs: number): { now: () => Date; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    }
  };
}

function countingSource(source: SecretSource): { source: SecretSource; resolveCalls: string[] } {
  const resolveCalls: string[] = [];
  return {
    resolveCalls,
    source: {
      resolve(scope: string) {
        resolveCalls.push(scope);
        return source.resolve(scope);
      }
    }
  };
}

function brokerWithEnv(
  overrides: Partial<{
    onEvent: (event: SecretBrokerEvent) => void;
    now: () => Date;
    authorize: (request: LeaseRequest) => boolean;
    maxLeases: number;
  }> = {}
): SecretBroker {
  const source = new EnvSecretSource({ openai: "TEST_OPENAI_API_KEY" }, { TEST_OPENAI_API_KEY: RAW_SECRET_VALUE });
  return new SecretBroker({
    scopes: { openai: { maxTtlMs: 60_000 } },
    source,
    ...overrides
  });
}

function leaseRequest(overrides: Partial<LeaseRequest> = {}): LeaseRequest {
  return {
    scope: "openai",
    ttlMs: 10_000,
    principal: principal(),
    purpose: "engine-invocation",
    ...overrides
  };
}

describe("SecretBroker.lease", () => {
  it("returns a handle that injects the real secret value into an env object for the leased principal", async () => {
    const broker = brokerWithEnv();
    const handle = await broker.lease(leaseRequest());

    const env: NodeJS.ProcessEnv = {};
    handle.injectInto(env, principal());

    expect(env.openai).toBe(RAW_SECRET_VALUE);
  });

  it("injects under the scope's configured injectAs name, not the scope name, when provided", async () => {
    const source = new EnvSecretSource({ openai: "TEST_OPENAI_API_KEY" }, { TEST_OPENAI_API_KEY: RAW_SECRET_VALUE });
    const broker = new SecretBroker({
      scopes: { openai: { maxTtlMs: 60_000, injectAs: "OPENAI_API_KEY" } },
      source
    });

    const handle = await broker.lease(leaseRequest());
    const env: NodeJS.ProcessEnv = {};
    handle.injectInto(env, principal());

    expect(env.OPENAI_API_KEY).toBe(RAW_SECRET_VALUE);
    expect(env.openai).toBeUndefined();
  });

  it("throws a typed ControlStackError for an unconfigured scope before ever touching the secret source", async () => {
    const { source, resolveCalls } = countingSource(
      new EnvSecretSource({ openai: "TEST_OPENAI_API_KEY" }, { TEST_OPENAI_API_KEY: RAW_SECRET_VALUE })
    );
    const broker = new SecretBroker({ scopes: { openai: { maxTtlMs: 60_000 } }, source });

    await expect(broker.lease(leaseRequest({ scope: "unconfigured-scope" }))).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_scope_not_allowed" })
    );
    expect(resolveCalls).toHaveLength(0);
  });

  it("throws a typed ControlStackError when the requested ttl exceeds the scope's max ttl", async () => {
    const broker = brokerWithEnv();

    await expect(broker.lease(leaseRequest({ ttlMs: 120_000 }))).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_lease_ttl_exceeds_max" })
    );
  });

  it("throws a typed ControlStackError for a non-positive ttl", async () => {
    const broker = brokerWithEnv();

    await expect(broker.lease(leaseRequest({ ttlMs: 0 }))).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_lease_invalid_ttl" })
    );
    await expect(broker.lease(leaseRequest({ ttlMs: -5 }))).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_lease_invalid_ttl" })
    );
  });

  it("throws a typed ControlStackError when the scope is allowlisted but the source has no value", async () => {
    const source = new EnvSecretSource({ openai: "UNSET_TEST_VAR" }, {});
    const broker = new SecretBroker({ scopes: { openai: { maxTtlMs: 60_000 } }, source });

    await expect(broker.lease(leaseRequest())).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_unavailable" })
    );
  });

  it("rejects an empty scope allowlist at construction time", () => {
    expect(() => new SecretBroker({ scopes: {}, source: new EnvSecretSource({}) })).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_broker_no_scopes" })
    );
  });

  it("rejects a scope configured with a non-positive maxTtlMs at construction time", () => {
    expect(
      () => new SecretBroker({ scopes: { openai: { maxTtlMs: 0 } }, source: new EnvSecretSource({}) })
    ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "secret_broker_invalid_scope" }));
  });

  it("requires every principal field and rejects a request missing one", async () => {
    const broker = brokerWithEnv();
    await expect(broker.lease({ ...leaseRequest(), principal: { ...principal(), workerId: "" } })).rejects.toThrow();
  });

  it("requires a non-empty purpose", async () => {
    const broker = brokerWithEnv();
    await expect(broker.lease(leaseRequest({ purpose: "" }))).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_lease_invalid_purpose" })
    );
  });

  it("rejects an invalid maxUses (zero, negative, or absurdly large)", async () => {
    const broker = brokerWithEnv();
    await expect(broker.lease(leaseRequest({ maxUses: 0 }))).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_lease_invalid_max_uses" })
    );
    await expect(broker.lease(leaseRequest({ maxUses: -1 }))).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_lease_invalid_max_uses" })
    );
    await expect(broker.lease(leaseRequest({ maxUses: 1_000_000 }))).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_lease_invalid_max_uses" })
    );
  });

  it("defaults maxUses to 1 (one-time use) when not specified", async () => {
    const broker = brokerWithEnv();
    const handle = await broker.lease(leaseRequest());
    expect(handle.maxUses).toBe(1);
  });

  it("refuses a lease request the authorize hook rejects, and never touches the secret source", async () => {
    const { source, resolveCalls } = countingSource(
      new EnvSecretSource({ openai: "TEST_OPENAI_API_KEY" }, { TEST_OPENAI_API_KEY: RAW_SECRET_VALUE })
    );
    const broker = new SecretBroker({
      scopes: { openai: { maxTtlMs: 60_000 } },
      source,
      authorize: () => false
    });

    await expect(broker.lease(leaseRequest())).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_lease_not_authorized" })
    );
    expect(resolveCalls).toHaveLength(0);
  });
});

describe("SecretBroker handle lifecycle", () => {
  it("injectInto throws once the handle's ttl has elapsed, rather than injecting a stale value", async () => {
    const clock = mutableClock(1_000_000);
    const broker = brokerWithEnv({ now: clock.now });
    const handle = await broker.lease(leaseRequest({ ttlMs: 5_000 }));

    const env: NodeJS.ProcessEnv = {};
    handle.injectInto(env, principal());
    expect(env.openai).toBe(RAW_SECRET_VALUE);

    clock.advance(5_000); // exactly at expiry - must already be unusable
    const lateEnv: NodeJS.ProcessEnv = {};
    expect(() => handle.injectInto(lateEnv, principal())).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_handle_expired" })
    );
    expect(lateEnv.openai).toBeUndefined();
  });

  it("injectInto throws after explicit revoke, and never mutates the passed env", async () => {
    const broker = brokerWithEnv();
    const handle = await broker.lease(leaseRequest());

    await broker.revoke(handle);

    const env: NodeJS.ProcessEnv = {};
    expect(() => handle.injectInto(env, principal())).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_handle_revoked" })
    );
    expect(env.openai).toBeUndefined();
  });

  it("revoke is idempotent: revoking twice does not throw", async () => {
    const broker = brokerWithEnv();
    const handle = await broker.lease(leaseRequest());

    await expect(broker.revoke(handle)).resolves.toBeUndefined();
    await expect(broker.revoke(handle)).resolves.toBeUndefined();
  });

  it("revoke is idempotent: revoking an already-expired handle does not throw", async () => {
    const clock = mutableClock(2_000_000);
    const broker = brokerWithEnv({ now: clock.now });
    const handle = await broker.lease(leaseRequest({ ttlMs: 1_000 }));

    clock.advance(1_000);

    await expect(broker.revoke(handle)).resolves.toBeUndefined();
  });

  it("two concurrent leases for the same scope do not interfere with each other's handles", async () => {
    const broker = brokerWithEnv();

    const [handleA, handleB] = await Promise.all([broker.lease(leaseRequest()), broker.lease(leaseRequest())]);

    expect(handleA.handleId).not.toBe(handleB.handleId);

    await broker.revoke(handleA);

    const envA: NodeJS.ProcessEnv = {};
    expect(() => handleA.injectInto(envA, principal())).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_handle_revoked" })
    );

    // handleB must be entirely unaffected by handleA's revocation.
    const envB: NodeJS.ProcessEnv = {};
    handleB.injectInto(envB, principal());
    expect(envB.openai).toBe(RAW_SECRET_VALUE);
  });
});

describe("SecretBroker principal binding and use accounting (R7)", () => {
  it("refuses redemption by a worker other than the one the lease was issued to", async () => {
    const broker = brokerWithEnv();
    const handle = await broker.lease(leaseRequest({ principal: principal({ workerId: "worker_1" }) }));

    const env: NodeJS.ProcessEnv = {};
    expect(() => handle.injectInto(env, principal({ workerId: "worker_2" }))).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_handle_principal_mismatch" })
    );
    expect(env.openai).toBeUndefined();
  });

  it("refuses redemption for a different work item, attempt, or engine even when the worker matches", async () => {
    const broker = brokerWithEnv();
    const leased = principal();

    for (const field of ["workItemId", "attemptId", "engineId"] as const) {
      const handle = await broker.lease(leaseRequest({ principal: leased }));
      const env: NodeJS.ProcessEnv = {};
      expect(() => handle.injectInto(env, { ...leased, [field]: "someone-elses-" + field })).toThrowError(
        expect.objectContaining<Partial<ControlStackError>>({ code: "secret_handle_principal_mismatch" })
      );
    }
  });

  it("a one-time-use (default) handle cannot be redeemed twice, even by the correct principal", async () => {
    const broker = brokerWithEnv();
    const handle = await broker.lease(leaseRequest());
    const who = principal();

    const first: NodeJS.ProcessEnv = {};
    handle.injectInto(first, who);
    expect(first.openai).toBe(RAW_SECRET_VALUE);

    const second: NodeJS.ProcessEnv = {};
    expect(() => handle.injectInto(second, who)).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_handle_uses_exhausted" })
    );
    expect(second.openai).toBeUndefined();
  });

  it("an explicit maxUses > 1 allows exactly that many redemptions and no more", async () => {
    const broker = brokerWithEnv();
    const handle = await broker.lease(leaseRequest({ maxUses: 3 }));
    const who = principal();

    for (let i = 0; i < 3; i += 1) {
      const env: NodeJS.ProcessEnv = {};
      handle.injectInto(env, who);
      expect(env.openai).toBe(RAW_SECRET_VALUE);
    }

    const fourth: NodeJS.ProcessEnv = {};
    expect(() => handle.injectInto(fourth, who)).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_handle_uses_exhausted" })
    );
  });

  it("does not decrement the use count on a rejected redemption (wrong principal doesn't burn a use)", async () => {
    const broker = brokerWithEnv();
    const handle = await broker.lease(leaseRequest({ maxUses: 1, principal: principal({ workerId: "worker_1" }) }));

    expect(() => handle.injectInto({}, principal({ workerId: "attacker" }))).toThrow();

    const env: NodeJS.ProcessEnv = {};
    handle.injectInto(env, principal({ workerId: "worker_1" }));
    expect(env.openai).toBe(RAW_SECRET_VALUE);
  });
});

describe("SecretHandle secret-exposure surface", () => {
  it("never exposes the raw secret value through Object.keys, Object.values, or JSON.stringify", async () => {
    const broker = brokerWithEnv();
    const handle = await broker.lease(leaseRequest());

    for (const key of Object.keys(handle)) {
      expect(key).not.toContain("value");
      expect(key).not.toContain("secret");
    }
    for (const value of Object.values(handle)) {
      expect(JSON.stringify(value)).not.toContain(RAW_SECRET_VALUE);
    }
    expect(JSON.stringify(handle)).not.toContain(RAW_SECRET_VALUE);
    expect(Object.getOwnPropertyNames(handle).some((name) => name.includes("inject"))).toBe(false);
  });
});

describe("SecretBroker onEvent", () => {
  it("fires a structured event for a successful lease, carrying principal and purpose but never the secret", async () => {
    const events: SecretBrokerEvent[] = [];
    const broker = brokerWithEnv({ onEvent: (event) => events.push(event) });

    const handle = await broker.lease(leaseRequest());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "secret.lease_granted",
      scope: "openai",
      handleId: handle.handleId,
      principal: principal(),
      purpose: "engine-invocation"
    });
    expect(JSON.stringify(events)).not.toContain(RAW_SECRET_VALUE);
  });

  it("fires a structured denial event for an unconfigured scope, without ever leaking the reason to include secret data", async () => {
    const events: SecretBrokerEvent[] = [];
    const broker = brokerWithEnv({ onEvent: (event) => events.push(event) });

    await expect(broker.lease(leaseRequest({ scope: "nope" }))).rejects.toThrow();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "secret.lease_denied", scope: "nope", reason: "scope_not_allowlisted" });
  });

  it("fires a structured event for revoke, distinguishing explicit revocation from an already-inactive handle", async () => {
    const events: SecretBrokerEvent[] = [];
    const broker = brokerWithEnv({ onEvent: (event) => events.push(event) });
    const handle = await broker.lease(leaseRequest());
    events.length = 0;

    await broker.revoke(handle);
    await broker.revoke(handle);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "secret.revoked", reason: "explicit", handleId: handle.handleId });
    expect(events[1]).toMatchObject({ type: "secret.revoked", reason: "already_inactive", handleId: handle.handleId });
  });

  it("fires a redemption_denied event for a principal mismatch, and a redeemed event for a genuine redemption", async () => {
    const events: SecretBrokerEvent[] = [];
    const broker = brokerWithEnv({ onEvent: (event) => events.push(event) });
    const handle = await broker.lease(leaseRequest());
    events.length = 0;

    expect(() => handle.injectInto({}, principal({ workerId: "attacker" }))).toThrow();
    handle.injectInto({}, principal());

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "secret.redemption_denied", reason: "principal_mismatch" });
    expect(events[1]).toMatchObject({ type: "secret.redeemed", handleId: handle.handleId, usesRemaining: 0 });
  });

  it("works with no onEvent supplied at all", async () => {
    const broker = brokerWithEnv();
    const handle = await broker.lease(leaseRequest());
    await expect(broker.revoke(handle)).resolves.toBeUndefined();
  });
});

describe("SecretBroker lease-table hygiene (bounds, sweeps, scrubbing)", () => {
  /** White-box access to the in-memory lease table, for asserting scrubbing/bounds. */
  function leaseTable(broker: SecretBroker): Map<string, { value: string }> {
    return (broker as unknown as { leases: Map<string, { value: string }> }).leases;
  }

  it("sweeps expired leases on the next lease() so dead records do not accumulate", async () => {
    const clock = mutableClock(1_000_000);
    const events: SecretBrokerEvent[] = [];
    const broker = brokerWithEnv({ now: clock.now, onEvent: (event) => events.push(event) });

    const handleA = await broker.lease(leaseRequest({ ttlMs: 5_000 }));
    clock.advance(6_000); // handleA is now expired
    await broker.lease(leaseRequest());

    const table = leaseTable(broker);
    expect(table.size).toBe(1);
    expect(table.has(handleA.handleId)).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "secret.lease_expired_swept", handleId: handleA.handleId, scope: "openai" })
    );
    expect(JSON.stringify(events)).not.toContain(RAW_SECRET_VALUE);
  });

  it("a lease whose record was already swept still reports secret_handle_expired, not unknown", async () => {
    const clock = mutableClock(1_000_000);
    const events: SecretBrokerEvent[] = [];
    const broker = brokerWithEnv({ now: clock.now, onEvent: (event) => events.push(event) });

    const handleA = await broker.lease(leaseRequest({ ttlMs: 1_000 }));
    clock.advance(1_000);
    await broker.lease(leaseRequest()); // sweeps handleA's record

    const env: NodeJS.ProcessEnv = {};
    expect(() => handleA.injectInto(env, principal())).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_handle_expired" })
    );
    expect(env.openai).toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({ type: "secret.redemption_denied", handleId: handleA.handleId, reason: "expired" })
    );
  });

  it("revocation scrubs the raw value from the lease table while keeping the revoked error code", async () => {
    const broker = brokerWithEnv();
    const handle = await broker.lease(leaseRequest());

    await broker.revoke(handle);

    const table = leaseTable(broker);
    expect(table.get(handle.handleId)?.value).toBe("");

    const env: NodeJS.ProcessEnv = {};
    expect(() => handle.injectInto(env, principal())).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_handle_revoked" })
    );
    expect(env.openai).toBeUndefined();
  });

  it("scrubs the raw value when a redemption is refused for expiry, before the next sweep", async () => {
    const clock = mutableClock(1_000_000);
    const broker = brokerWithEnv({ now: clock.now });
    const handle = await broker.lease(leaseRequest({ ttlMs: 5_000 }));

    clock.advance(5_000);
    expect(() => handle.injectInto({}, principal())).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_handle_expired" })
    );

    const table = leaseTable(broker);
    expect(table.get(handle.handleId)?.value).toBe("");
  });

  it("scrubs the raw value after the final redemption, never before it", async () => {
    const broker = brokerWithEnv();
    const handle = await broker.lease(leaseRequest({ maxUses: 1 }));
    const who = principal();

    const env: NodeJS.ProcessEnv = {};
    handle.injectInto(env, who);
    expect(env.openai).toBe(RAW_SECRET_VALUE); // the final legitimate use still receives the secret

    const table = leaseTable(broker);
    expect(table.get(handle.handleId)?.value).toBe(""); // scrubbed only after delivery

    const second: NodeJS.ProcessEnv = {};
    expect(() => handle.injectInto(second, who)).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_handle_uses_exhausted" })
    );
    expect(second.openai).toBeUndefined();
  });

  it("fails closed at maxLeases live leases rather than evicting one, and live leases keep working", async () => {
    const events: SecretBrokerEvent[] = [];
    const broker = brokerWithEnv({ onEvent: (event) => events.push(event), maxLeases: 2 });

    const first = await broker.lease(leaseRequest({ principal: principal({ workItemId: "wrk_1" }) }));
    const second = await broker.lease(leaseRequest({ principal: principal({ workItemId: "wrk_2" }) }));

    await expect(broker.lease(leaseRequest({ principal: principal({ workItemId: "wrk_3" }) }))).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_lease_capacity_exceeded" })
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "secret.lease_denied", reason: "capacity_exceeded" })
    );

    // Neither live lease was disturbed by the refused third lease.
    const envA: NodeJS.ProcessEnv = {};
    first.injectInto(envA, principal({ workItemId: "wrk_1" }));
    expect(envA.openai).toBe(RAW_SECRET_VALUE);
    const envB: NodeJS.ProcessEnv = {};
    second.injectInto(envB, principal({ workItemId: "wrk_2" }));
    expect(envB.openai).toBe(RAW_SECRET_VALUE);
  });

  it("a capacity refusal never touches the secret source", async () => {
    const { source, resolveCalls } = countingSource(
      new EnvSecretSource({ openai: "TEST_OPENAI_API_KEY" }, { TEST_OPENAI_API_KEY: RAW_SECRET_VALUE })
    );
    const broker = new SecretBroker({
      scopes: { openai: { maxTtlMs: 60_000 } },
      source,
      maxLeases: 1
    });

    await broker.lease(leaseRequest());
    await expect(broker.lease(leaseRequest({ principal: principal({ workItemId: "wrk_2" }) }))).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_lease_capacity_exceeded" })
    );

    expect(resolveCalls).toHaveLength(1);
  });

  it("revocation frees a capacity slot immediately", async () => {
    const broker = brokerWithEnv({ maxLeases: 1 });

    const first = await broker.lease(leaseRequest());
    await expect(broker.lease(leaseRequest())).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_lease_capacity_exceeded" })
    );

    await broker.revoke(first);
    const second = await broker.lease(leaseRequest());
    expect(second.handleId).not.toBe(first.handleId);
    // The revoked record lingers (value-free) for error-code fidelity, the live lease is present too.
    expect(leaseTable(broker).size).toBe(2);
  });

  it("expiry frees a capacity slot via the sweep", async () => {
    const clock = mutableClock(1_000_000);
    const broker = brokerWithEnv({ now: clock.now, maxLeases: 1 });

    await broker.lease(leaseRequest({ ttlMs: 1_000 }));
    await expect(broker.lease(leaseRequest())).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_lease_capacity_exceeded" })
    );

    clock.advance(1_000);
    const second = await broker.lease(leaseRequest());
    expect(second).toBeDefined();
    expect(leaseTable(broker).size).toBe(1);
  });

  it("rejects an invalid maxLeases at construction time", () => {
    for (const invalid of [0, -1, 1.5, Number.NaN]) {
      expect(
        () =>
          new SecretBroker({
            scopes: { openai: { maxTtlMs: 60_000 } },
            source: new EnvSecretSource({ openai: "TEST_OPENAI_API_KEY" }, { TEST_OPENAI_API_KEY: RAW_SECRET_VALUE }),
            maxLeases: invalid
          })
      ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "secret_broker_invalid_max_leases" }));
    }
  });
});
