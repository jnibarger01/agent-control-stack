import { describe, expect, it } from "vitest";
import { ResourceLockTable, resourceClaimsConflict } from "./locks.js";

describe("ResourceLockTable", () => {
  it("treats a directory claim as overlapping descendant files", () => {
    expect(
      resourceClaimsConflict(
        [{ key: "dir:/repo/src", mode: "shared" }],
        [{ key: "file:/repo/src/deep/a.ts", mode: "exclusive" }]
      )
    ).toBe(true);
  });

  it("does not collide unrelated file mutations", () => {
    expect(
      resourceClaimsConflict(
        [{ key: "file:/repo/src/a.ts", mode: "exclusive" }],
        [{ key: "file:/repo/src/b.ts", mode: "exclusive" }]
      )
    ).toBe(false);
  });

  it("checks hierarchical overlap against locks already held", () => {
    const locks = new ResourceLockTable();
    locks.acquire("reader", [{ key: "dir:/repo/src", mode: "shared" }]);
    expect(
      locks.canAcquire("writer", [
        { key: "file:/repo/src/deep/a.ts", mode: "exclusive" }
      ])
    ).toBe(false);
    locks.release("reader");
    expect(
      locks.canAcquire("writer", [
        { key: "file:/repo/src/deep/a.ts", mode: "exclusive" }
      ])
    ).toBe(true);
  });
});
