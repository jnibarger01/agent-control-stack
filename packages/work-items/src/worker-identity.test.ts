import { describe, expect, it } from "vitest";
import { ControlStackError } from "@agent-control-stack/shared";
import { hashWorkerIdentityToken, WorkerIdentityRegistry } from "./worker-identity.js";

describe("WorkerIdentityRegistry", () => {
  it("issues a TTL-bound identity and authenticates before expiry", () => {
    const registry = new WorkerIdentityRegistry();
    const issuedAt = new Date("2026-09-13T12:00:00.000Z");
    const issued = registry.issue({
      workerId: "worker-a",
      ttlMs: 60_000,
      token: "a".repeat(32),
      now: issuedAt
    });

    expect(issued.generation).toBe(1);
    expect(issued.expiresAt).toBe("2026-09-13T12:01:00.000Z");
    expect(hashWorkerIdentityToken(issued.token)).toMatch(/^[a-f0-9]{64}$/);
    expect(registry.authenticate(issued.token, issuedAt).workerId).toBe("worker-a");
  });

  it("rotate-then-authenticate: old token is revoked, new token works", () => {
    const registry = new WorkerIdentityRegistry();
    const now = new Date("2026-09-13T12:00:00.000Z");
    const issued = registry.issue({
      workerId: "worker-a",
      ttlMs: 60_000,
      token: "a".repeat(32),
      now
    });
    const rotated = registry.rotate({
      workerId: "worker-a",
      currentToken: issued.token,
      ttlMs: 60_000,
      newToken: "b".repeat(32),
      now: new Date("2026-09-13T12:00:30.000Z")
    });

    expect(rotated.generation).toBe(2);
    expect(registry.authenticate(rotated.token, new Date("2026-09-13T12:00:30.000Z")).id).toBe(rotated.id);
    expect(registry.resolve(issued.token, new Date("2026-09-13T12:00:30.000Z"))).toEqual({
      ok: false,
      code: "worker_identity_revoked"
    });
  });

  it("expired-then-deny: authenticate fails after TTL and rotate of expired fails", () => {
    const registry = new WorkerIdentityRegistry();
    const issued = registry.issue({
      workerId: "worker-a",
      ttlMs: 1_000,
      token: "a".repeat(32),
      now: new Date("2026-09-13T12:00:00.000Z")
    });
    const afterExpiry = new Date("2026-09-13T12:00:01.000Z");

    expect(registry.resolve(issued.token, afterExpiry)).toEqual({
      ok: false,
      code: "worker_identity_expired"
    });
    expect(() => registry.authenticate(issued.token, afterExpiry)).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "worker_identity_expired" })
    );
    expect(() =>
      registry.rotate({
        workerId: "worker-a",
        currentToken: issued.token,
        ttlMs: 60_000,
        now: afterExpiry
      })
    ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "worker_identity_expired" }));
  });

  it("revoke denies later authenticate and is idempotent", () => {
    const registry = new WorkerIdentityRegistry();
    const now = new Date("2026-09-13T12:00:00.000Z");
    const issued = registry.issue({
      workerId: "worker-a",
      ttlMs: 60_000,
      token: "a".repeat(32),
      now
    });
    registry.revoke({ workerId: "worker-a", token: issued.token, now });
    registry.revoke({ workerId: "worker-a", token: issued.token, now });

    expect(registry.resolve(issued.token, now)).toEqual({
      ok: false,
      code: "worker_identity_revoked"
    });
  });
});
