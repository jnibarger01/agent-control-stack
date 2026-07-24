import { ControlStackError } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import { SecretBroker, type SecretBrokerEvent } from "./broker.js";
import { EnvSecretSource, type SecretSource } from "./source.js";

const RAW_SECRET_VALUE = "sk-super-secret-do-not-log-me";

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
  overrides: Partial<{ onEvent: (event: SecretBrokerEvent) => void; now: () => Date }> = {}
): SecretBroker {
  const source = new EnvSecretSource({ openai: "TEST_OPENAI_API_KEY" }, { TEST_OPENAI_API_KEY: RAW_SECRET_VALUE });
  return new SecretBroker({
    scopes: { openai: { maxTtlMs: 60_000 } },
    source,
    ...overrides
  });
}

describe("SecretBroker.lease", () => {
  it("returns a handle that injects the real secret value into an env object", async () => {
    const broker = brokerWithEnv();
    const handle = await broker.lease("openai", 10_000);

    const env: NodeJS.ProcessEnv = {};
    handle.injectInto(env);

    expect(env.openai).toBe(RAW_SECRET_VALUE);
  });

  it("injects under the scope's configured injectAs name, not the scope name, when provided", async () => {
    const source = new EnvSecretSource({ openai: "TEST_OPENAI_API_KEY" }, { TEST_OPENAI_API_KEY: RAW_SECRET_VALUE });
    const broker = new SecretBroker({
      scopes: { openai: { maxTtlMs: 60_000, injectAs: "OPENAI_API_KEY" } },
      source
    });

    const handle = await broker.lease("openai", 10_000);
    const env: NodeJS.ProcessEnv = {};
    handle.injectInto(env);

    expect(env.OPENAI_API_KEY).toBe(RAW_SECRET_VALUE);
    expect(env.openai).toBeUndefined();
  });

  it("throws a typed ControlStackError for an unconfigured scope before ever touching the secret source", async () => {
    const { source, resolveCalls } = countingSource(
      new EnvSecretSource({ openai: "TEST_OPENAI_API_KEY" }, { TEST_OPENAI_API_KEY: RAW_SECRET_VALUE })
    );
    const broker = new SecretBroker({ scopes: { openai: { maxTtlMs: 60_000 } }, source });

    await expect(broker.lease("unconfigured-scope", 1_000)).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_scope_not_allowed" })
    );
    expect(resolveCalls).toHaveLength(0);
  });

  it("throws a typed ControlStackError when the requested ttl exceeds the scope's max ttl", async () => {
    const broker = brokerWithEnv();

    await expect(broker.lease("openai", 120_000)).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_lease_ttl_exceeds_max" })
    );
  });

  it("throws a typed ControlStackError for a non-positive ttl", async () => {
    const broker = brokerWithEnv();

    await expect(broker.lease("openai", 0)).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_lease_invalid_ttl" })
    );
    await expect(broker.lease("openai", -5)).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_lease_invalid_ttl" })
    );
  });

  it("throws a typed ControlStackError when the scope is allowlisted but the source has no value", async () => {
    const source = new EnvSecretSource({ openai: "UNSET_TEST_VAR" }, {});
    const broker = new SecretBroker({ scopes: { openai: { maxTtlMs: 60_000 } }, source });

    await expect(broker.lease("openai", 1_000)).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_unavailable" })
    );
  });

  it("rejects an empty scope allowlist at construction time", () => {
    expect(
      () => new SecretBroker({ scopes: {}, source: new EnvSecretSource({}) })
    ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "secret_broker_no_scopes" }));
  });

  it("rejects a scope configured with a non-positive maxTtlMs at construction time", () => {
    expect(
      () => new SecretBroker({ scopes: { openai: { maxTtlMs: 0 } }, source: new EnvSecretSource({}) })
    ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "secret_broker_invalid_scope" }));
  });
});

describe("SecretBroker handle lifecycle", () => {
  it("injectInto throws once the handle's ttl has elapsed, rather than injecting a stale value", async () => {
    const clock = mutableClock(1_000_000);
    const broker = brokerWithEnv({ now: clock.now });
    const handle = await broker.lease("openai", 5_000);

    const env: NodeJS.ProcessEnv = {};
    handle.injectInto(env);
    expect(env.openai).toBe(RAW_SECRET_VALUE);

    clock.advance(5_000); // exactly at expiry - must already be unusable
    const lateEnv: NodeJS.ProcessEnv = {};
    expect(() => handle.injectInto(lateEnv)).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_handle_expired" })
    );
    expect(lateEnv.openai).toBeUndefined();
  });

  it("injectInto throws after explicit revoke, and never mutates the passed env", async () => {
    const broker = brokerWithEnv();
    const handle = await broker.lease("openai", 10_000);

    await broker.revoke(handle);

    const env: NodeJS.ProcessEnv = {};
    expect(() => handle.injectInto(env)).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_handle_revoked" })
    );
    expect(env.openai).toBeUndefined();
  });

  it("revoke is idempotent: revoking twice does not throw", async () => {
    const broker = brokerWithEnv();
    const handle = await broker.lease("openai", 10_000);

    await expect(broker.revoke(handle)).resolves.toBeUndefined();
    await expect(broker.revoke(handle)).resolves.toBeUndefined();
  });

  it("revoke is idempotent: revoking an already-expired handle does not throw", async () => {
    const clock = mutableClock(2_000_000);
    const broker = brokerWithEnv({ now: clock.now });
    const handle = await broker.lease("openai", 1_000);

    clock.advance(1_000);

    await expect(broker.revoke(handle)).resolves.toBeUndefined();
  });

  it("two concurrent leases for the same scope do not interfere with each other's handles", async () => {
    const broker = brokerWithEnv();

    const [handleA, handleB] = await Promise.all([broker.lease("openai", 10_000), broker.lease("openai", 10_000)]);

    expect(handleA.handleId).not.toBe(handleB.handleId);

    await broker.revoke(handleA);

    const envA: NodeJS.ProcessEnv = {};
    expect(() => handleA.injectInto(envA)).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "secret_handle_revoked" })
    );

    // handleB must be entirely unaffected by handleA's revocation.
    const envB: NodeJS.ProcessEnv = {};
    handleB.injectInto(envB);
    expect(envB.openai).toBe(RAW_SECRET_VALUE);
  });
});

describe("SecretHandle secret-exposure surface", () => {
  it("never exposes the raw secret value through Object.keys, Object.values, or JSON.stringify", async () => {
    const broker = brokerWithEnv();
    const handle = await broker.lease("openai", 10_000);

    for (const key of Object.keys(handle)) {
      expect(key).not.toContain("value");
      expect(key).not.toContain("secret");
    }
    for (const value of Object.values(handle)) {
      expect(String(value)).not.toContain(RAW_SECRET_VALUE);
    }
    expect(JSON.stringify(handle)).not.toContain(RAW_SECRET_VALUE);
    expect(Object.getOwnPropertyNames(handle).some((name) => name.includes("inject"))).toBe(false);
  });
});

describe("SecretBroker onEvent", () => {
  it("fires a structured event for a successful lease", async () => {
    const events: SecretBrokerEvent[] = [];
    const broker = brokerWithEnv({ onEvent: (event) => events.push(event) });

    const handle = await broker.lease("openai", 10_000);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "secret.lease_granted", scope: "openai", handleId: handle.handleId });
    expect(JSON.stringify(events)).not.toContain(RAW_SECRET_VALUE);
  });

  it("fires a structured denial event for an unconfigured scope, without ever leaking the reason to include secret data", async () => {
    const events: SecretBrokerEvent[] = [];
    const broker = brokerWithEnv({ onEvent: (event) => events.push(event) });

    await expect(broker.lease("nope", 1_000)).rejects.toThrow();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "secret.lease_denied", scope: "nope", reason: "scope_not_allowlisted" });
  });

  it("fires a structured event for revoke, distinguishing explicit revocation from an already-inactive handle", async () => {
    const events: SecretBrokerEvent[] = [];
    const broker = brokerWithEnv({ onEvent: (event) => events.push(event) });
    const handle = await broker.lease("openai", 10_000);
    events.length = 0;

    await broker.revoke(handle);
    await broker.revoke(handle);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "secret.revoked", reason: "explicit", handleId: handle.handleId });
    expect(events[1]).toMatchObject({ type: "secret.revoked", reason: "already_inactive", handleId: handle.handleId });
  });

  it("works with no onEvent supplied at all", async () => {
    const broker = brokerWithEnv();
    const handle = await broker.lease("openai", 10_000);
    await expect(broker.revoke(handle)).resolves.toBeUndefined();
  });
});
