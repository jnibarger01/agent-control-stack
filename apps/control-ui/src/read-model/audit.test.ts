import { describe, expect, it } from "vitest";
import { parseAuditReadModel } from "@agent-control-stack/mission-control-contract";
import type { StoredAuditEvent } from "@agent-control-stack/work-items";
import { toAuditReadModel } from "./audit.js";

const ev = (sequence: number, name: string, attributes: Record<string, string | number | boolean> = {}, body: Record<string, unknown> = {}) =>
  ({ sequence, id: `e${sequence}`, name, timeUnixNano: "1792411200000000000", attributes, body, previousHash: "p".repeat(8), eventHash: "h".repeat(8) }) as StoredAuditEvent;

describe("toAuditReadModel", () => {
  it("redacts secret-named attributes and secret-looking values, and never forwards the raw body", () => {
    const out = toAuditReadModel([ev(5, "connector.registered", { apiToken: `${["xyz", "secret", "1"].join("-")}`, note: `use Bearer ${["abc", "def", "ghi-123"].join(".")}`, "work_item.id": "wrk_1" }, { privateKey: `${["-----BEGIN PRIVATE", " KEY-----"].join("")}zzz${["-----END PRIVATE", " KEY-----"].join("")}` })], 50);
    expect(parseAuditReadModel(JSON.parse(JSON.stringify(out))).ok).toBe(true);
    const json = JSON.stringify(out);
    for (const bad of [`${["xyz", "secret", "1"].join("-")}`, `${["abc", "def", "ghi-123"].join(".")}`, "BEGIN PRIVATE KEY", "privateKey"]) expect(json, bad).not.toContain(bad);
    expect(out.events[0]?.attributes["work_item.id"]).toBe("wrk_1");
    expect(out.events[0]?.attributes.apiToken).toBe("[redacted]");
  });

  it("is newest first and paginates only when a full page may have older events behind it", () => {
    const events = [ev(1, "a"), ev(2, "b"), ev(3, "c")];
    const full = toAuditReadModel(events, 2);
    expect(full.events.map((e) => e.sequence)).toEqual([3, 2]);
    expect(full.nextBefore).toBe(2);
    const short = toAuditReadModel(events, 10);
    expect(short.events.map((e) => e.sequence)).toEqual([3, 2, 1]);
    expect(short.nextBefore).toBeNull();
    expect(toAuditReadModel([], 10).nextBefore).toBeNull();
  });

  it("extracts only the policy decision fields for policy.decided", () => {
    const out = toAuditReadModel([ev(9, "policy.decided", {}, { decision: "require_approval", reason: "high risk work requires approval", matchedRules: ["approval:risk"], requiredApprover: "user", context: { actor: "secret-ish", cwd: "/home/x" } })], 10);
    expect(out.events[0]?.policy).toEqual({ decision: "require_approval", reason: "high risk work requires approval", matchedRules: ["approval:risk"], requiredApprover: "user" });
    expect(JSON.stringify(out)).not.toContain("/home/x");
    expect(toAuditReadModel([ev(1, "work_item.created", {}, { decision: "x" })], 10).events[0]?.policy).toBeUndefined();
  });

  it("converts timestamps and bounds oversized attribute sets", () => {
    const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, "v".repeat(500)]));
    const out = toAuditReadModel([ev(1, "x", many)], 10);
    expect(out.events[0]?.at).toBe("2026-10-19T12:00:00.000Z");
    expect(Object.keys(out.events[0]!.attributes)).toHaveLength(40);
    expect(Object.values(out.events[0]!.attributes).every((v) => String(v).length <= 300)).toBe(true);
  });
});
