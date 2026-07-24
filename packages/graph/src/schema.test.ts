import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { graphDefinitionJsonSchema, nodeExecutionResultSchema } from "./index.js";

const artifactPath = fileURLToPath(new URL("../../../schemas/graph-v0.1.schema.json", import.meta.url));

describe("graph v0.1 JSON Schema artifact", () => {
  it("is generated from the runtime boundary schema without drift", () => {
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as unknown;

    expect(artifact).toEqual(graphDefinitionJsonSchema());
  });

  it("requires the public envelope and canonical node fields without requiring legacy defaults", () => {
    const schema = graphDefinitionJsonSchema() as {
      required?: unknown;
      properties?: {
        nodes?: { items?: { required?: unknown } };
      };
    };

    expect(schema.required).toEqual([
      "graph_id",
      "version",
      "requested_by",
      "intent",
      "nodes",
      "risk",
      "idempotency_key",
      "correlation_id"
    ]);
    expect(schema.properties?.nodes?.items?.required).toEqual([
      "id",
      "function_id",
      "dependencies",
      "input_schema",
      "output_schema",
      "timeout",
      "retry_policy",
      "risk",
      "approval_required",
      "idempotency_key"
    ]);
  });

  it("requires strict result fields and rejects credential-bearing evidence URIs", () => {
    const result = {
      status: "SUCCEEDED",
      output: { output: "ok" },
      evidence: [{ kind: "fixture", uri: "https://example.test?access_token=secret", sha256: "a".repeat(64) }],
      assumptions: [],
      confidence: 1,
      unresolved: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 1 }
    };

    expect(nodeExecutionResultSchema.safeParse(result).success).toBe(false);
    expect(nodeExecutionResultSchema.safeParse({ ...result, retryable: false, evidence: [] }).success).toBe(true);
  });
});
