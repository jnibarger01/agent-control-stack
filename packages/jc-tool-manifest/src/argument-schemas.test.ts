import { describe, expect, it } from "vitest";
import { jcToolContract } from "./index.js";

describe("herdr argument schemas", () => {
  it("rejects unknown fields and shell metacharacters in terminal IDs", () => {
    expect(jcToolContract("herdr_status")!.argsSchema.safeParse({ extra: true }).success).toBe(false);
    expect(jcToolContract("herdr_terminals")!.argsSchema.safeParse({ all: true, extra: 1 }).success).toBe(false);
    const read = jcToolContract("herdr_read")!.argsSchema;
    expect(read.safeParse({ terminal: "t1; rm -rf /" }).success).toBe(false);
    expect(read.safeParse({ terminal: "machine/t1" }).success).toBe(true);
  });

  it("never injects a default into signed arguments and enforces the inclusive 0..2000 range", () => {
    const read = jcToolContract("herdr_read")!.argsSchema;
    expect(read.parse({ terminal: "t1" })).toEqual({ terminal: "t1" });
    expect(read.safeParse({ terminal: "t1", lines: 0 }).success).toBe(true);
    expect(read.safeParse({ terminal: "t1", lines: 2000 }).success).toBe(true);
    expect(read.safeParse({ terminal: "t1", lines: 2001 }).success).toBe(false);
    expect(read.safeParse({ terminal: "t1", lines: -1 }).success).toBe(false);
    expect(read.safeParse({ terminal: "t1", lines: 1.5 }).success).toBe(false);
  });
});
