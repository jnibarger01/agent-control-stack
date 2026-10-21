import { describe, expect, it } from "vitest";
import { displayLeaseStatus, isCurrentLease } from "./lease.js";

describe("lease expiry boundary", () => {
  const expiresAt = "2026-01-01T00:00:00.000Z";
  const expiresMs = Date.parse(expiresAt);

  it("a lease is current one millisecond before expiry", () => {
    expect(isCurrentLease({ status: "active", expiresAt }, expiresMs - 1)).toBe(true);
  });

  it("a lease is no longer current at the exact expiry instant", () => {
    expect(isCurrentLease({ status: "active", expiresAt }, expiresMs)).toBe(false);
    expect(displayLeaseStatus({ status: "active", expiresAt }, expiresMs)).toBe("expired");
  });
});
