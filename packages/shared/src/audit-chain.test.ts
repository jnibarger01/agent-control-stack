import { describe, expect, it } from "vitest";
import { auditEventHash, exportAuditEventsJsonl, verifyAuditChain, type AuditChainEvent } from "./audit-chain.js";

describe("audit chain export", () => {
  it("exports redacted JSONL and preserves tamper evidence", () => {
    const event: Omit<AuditChainEvent, "eventHash"> = {
      sequence: 1,
      id: "evt_1",
      name: "tool.completed",
      timeUnixNano: "1",
      attributes: {},
      body: { token: "do-not-persist" },
      previousHash: ""
    };
    const chained = { ...event, eventHash: auditEventHash(event) };
    expect(exportAuditEventsJsonl([chained])).toContain("[redacted]");
    expect(exportAuditEventsJsonl([chained])).not.toContain("do-not-persist");
    expect(verifyAuditChain([chained])).toMatchObject({ ok: true, eventCount: 1 });
  });
});
