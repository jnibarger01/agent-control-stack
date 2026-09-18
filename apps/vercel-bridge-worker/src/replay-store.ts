import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  bridgeResultEnvelopeSchema,
  type BridgeRequestEnvelope,
  type BridgeResultEnvelope
} from "@agent-control-stack/vercel-bridge-contract";

export class BridgeReplayConflictError extends Error {
  constructor(message = "bridge replay request conflicts with persisted result") {
    super(message);
    this.name = "BridgeReplayConflictError";
  }
}

interface ReplayRow {
  request_id: string;
  request_hash: string;
  result_json: string;
  completed_at: string;
}

export function bridgeRequestHash(request: BridgeRequestEnvelope): string {
  return createHash("sha256").update(stableJson(request), "utf8").digest("hex");
}

export class SqliteBridgeReplayStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA busy_timeout = 5000;" +
        "CREATE TABLE IF NOT EXISTS vercel_bridge_replay (" +
        "request_id TEXT PRIMARY KEY," +
        "request_hash TEXT NOT NULL," +
        "result_json TEXT NOT NULL," +
        "completed_at TEXT NOT NULL" +
        ");"
    );
  }
  close(): void {
    this.db.close();
  }

  get(request: BridgeRequestEnvelope): BridgeResultEnvelope | undefined {
    const row = this.row(request.requestId);
    if (!row) return undefined;
    this.requireSameRequest(row, request);
    return bridgeResultEnvelopeSchema.parse(JSON.parse(row.result_json));
  }

  put(request: BridgeRequestEnvelope, result: BridgeResultEnvelope): void {
    const parsedResult = bridgeResultEnvelopeSchema.parse(result);
    if (parsedResult.requestId !== request.requestId) {
      throw new BridgeReplayConflictError("bridge result request id does not match request");
    }

    const existing = this.row(request.requestId);
    if (existing) {
      this.requireSameRequest(existing, request);
      if (existing.result_json !== stableJson(parsedResult)) {
        throw new BridgeReplayConflictError("bridge result conflicts with persisted result");
      }
      return;
    }

    this.db
      .prepare(
        "INSERT INTO vercel_bridge_replay " +
          "(request_id, request_hash, result_json, completed_at) VALUES (?, ?, ?, ?)"
      )
      .run(request.requestId, bridgeRequestHash(request), stableJson(parsedResult), new Date().toISOString());
  }

  debugRawRow(requestId: string): ReplayRow | undefined {
    return this.row(requestId);
  }
  private row(requestId: string): ReplayRow | undefined {
    return this.db
      .prepare(
        "SELECT request_id, request_hash, result_json, completed_at " + "FROM vercel_bridge_replay WHERE request_id = ?"
      )
      .get(requestId) as ReplayRow | undefined;
  }

  private requireSameRequest(row: ReplayRow, request: BridgeRequestEnvelope): void {
    if (row.request_hash !== bridgeRequestHash(request)) {
      throw new BridgeReplayConflictError();
    }
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)])
    );
  }
  return value;
}
