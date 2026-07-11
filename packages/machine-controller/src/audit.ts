import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redactValue } from "@agent-control-stack/shared";
import type { RiskLevel } from "./command.js";

export interface ToolAuditRecord {
  timestamp: string;
  tool: string;
  args: unknown;
  cwd?: string;
  risk: RiskLevel | "unknown";
  approvalStatus: "not_required" | "required" | "approved" | "rejected";
  ok: boolean;
  durationMs: number;
  exitCode?: number | null;
  resultSummary?: unknown;
  error?: string;
}

export class JsonlAuditLogger {
  constructor(private readonly logPath: string) {}

  log(record: ToolAuditRecord): void {
    mkdirSync(dirname(this.logPath), { recursive: true });
    appendFileSync(this.logPath, `${JSON.stringify(redactValue(record))}\n`, "utf8");
  }
}
