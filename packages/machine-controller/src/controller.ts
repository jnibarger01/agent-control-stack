import { cpus, freemem, loadavg, platform, release, totalmem, uptime } from "node:os";
import { redactValue } from "@agent-control-stack/shared";
import { JsonlAuditLogger } from "./audit.js";
import { previewCommand, runReadonlyCommand, type RiskLevel } from "./command.js";
import type { MachineControllerConfig } from "./config.js";
import { listFiles, readTextFile, searchNames, statPath } from "./filesystem.js";

export const machineToolNames = [
  "system.status",
  "fs.list",
  "fs.stat",
  "fs.read",
  "fs.search_name",
  "cmd.preview",
  "cmd.run"
] as const;

export type MachineToolName = (typeof machineToolNames)[number];

interface DispatchResult {
  result: unknown;
  risk: RiskLevel;
  cwd?: string;
  exitCode?: number | null;
}

export class MachineController {
  private readonly audit: JsonlAuditLogger;

  constructor(private readonly config: MachineControllerConfig) {
    this.audit = new JsonlAuditLogger(config.audit.logPath);
  }

  async callTool(name: string, args: unknown = {}): Promise<unknown> {
    const started = Date.now();
    try {
      const dispatched = await this.dispatch(name, args);
      const result = this.config.security.redactSecrets ? redactValue(dispatched.result) : dispatched.result;
      this.audit.log({
        timestamp: new Date().toISOString(),
        tool: name,
        args,
        cwd: dispatched.cwd,
        risk: dispatched.risk,
        approvalStatus: dispatched.risk === "read_only" ? "not_required" : "required",
        ok: true,
        durationMs: Date.now() - started,
        exitCode: dispatched.exitCode,
        resultSummary: summarize(result)
      });
      return result;
    } catch (error) {
      this.audit.log({
        timestamp: new Date().toISOString(),
        tool: name,
        args,
        risk: "unknown",
        approvalStatus: "rejected",
        ok: false,
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : "unknown error"
      });
      throw error;
    }
  }

  private async dispatch(name: string, args: unknown): Promise<DispatchResult> {
    switch (name) {
      case "system.status":
        return { result: systemStatus(this.config), risk: "read_only" };
      case "fs.list":
        return { result: listFiles(this.config, args), risk: "read_only" };
      case "fs.stat":
        return { result: statPath(this.config, args), risk: "read_only" };
      case "fs.read":
        return { result: readTextFile(this.config, args), risk: "read_only" };
      case "fs.search_name":
        return { result: searchNames(this.config, args), risk: "read_only" };
      case "cmd.preview": {
        const preview = previewCommand(this.config, args);
        return { result: preview, risk: preview.risk, cwd: preview.cwd };
      }
      case "cmd.run": {
        const result = await runReadonlyCommand(this.config, args);
        return { result, risk: result.preview.risk, cwd: result.preview.cwd, exitCode: result.exitCode };
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }
}

function systemStatus(config: MachineControllerConfig) {
  return {
    os: { platform: platform(), release: release(), cpus: cpus().length },
    uptimeSeconds: uptime(),
    memory: { totalBytes: totalmem(), freeBytes: freemem() },
    loadAverage: loadavg(),
    server: { name: config.server.name, version: config.server.version, transport: config.server.transport }
  };
}

function summarize(result: unknown): unknown {
  if (typeof result === "string") {
    return result.slice(0, 500);
  }
  if (result && typeof result === "object") {
    return Object.fromEntries(Object.entries(result as Record<string, unknown>).slice(0, 8));
  }
  return result;
}
