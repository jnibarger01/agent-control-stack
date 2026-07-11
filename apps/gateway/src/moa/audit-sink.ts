import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditSink, MoaAuditEvent } from "@agent-control-stack/moa-orchestrator";
import { auditEventHash, createEvent, type AuditChainEvent } from "@agent-control-stack/shared";

export class HashChainedJsonlAuditSink implements AuditSink {
  private sequence: number;
  private previousHash: string;

  constructor(private readonly logPath: string) {
    const tail = readTail(logPath);
    this.sequence = tail.sequence;
    this.previousHash = tail.previousHash;
  }

  record(event: MoaAuditEvent): void {
    const base = createEvent(`moa.${event.type}`, event.data, {
      "moa.task_id": event.task_id,
      "moa.session_id": event.session_id,
      "moa.origin": event.origin,
      "moa.preset": event.preset,
      "moa.actor": event.actor
    });
    const chained: Omit<AuditChainEvent, "eventHash"> = {
      ...base,
      sequence: this.sequence + 1,
      previousHash: this.previousHash
    };
    const record = { ...chained, eventHash: auditEventHash(chained) };
    mkdirSync(dirname(this.logPath), { recursive: true });
    appendFileSync(this.logPath, `${JSON.stringify(record)}\n`, "utf8");
    this.sequence = record.sequence;
    this.previousHash = record.eventHash;
  }
}

function readTail(path: string): { sequence: number; previousHash: string } {
  if (!existsSync(path)) return { sequence: 0, previousHash: "" };
  const last = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).at(-1);
  if (!last) return { sequence: 0, previousHash: "" };
  const parsed = JSON.parse(last) as { sequence?: unknown; eventHash?: unknown };
  if (typeof parsed.sequence !== "number" || typeof parsed.eventHash !== "string") {
    throw new Error(`MoA audit log is malformed at ${path}`);
  }
  return { sequence: parsed.sequence, previousHash: parsed.eventHash };
}
