import { describe, expect, it } from "vitest";
import { z } from "zod";
import { canonicalJsonSchema, toolSchemaFingerprint } from "./schema-fingerprint.js";

const base = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1, maxLength: 4096 },
    depth: { type: "integer", minimum: 1, maximum: 8 }
  },
  required: ["path"],
  additionalProperties: false
};

describe("toolSchemaFingerprint — presentation invariance", () => {
  it("is identical for reordered keys and stripped descriptions/titles/examples", () => {
    const a = toolSchemaFingerprint({ inputSchema: base });
    const b = toolSchemaFingerprint({
      inputSchema: {
        additionalProperties: false,
        title: "List directory",
        description: "reads a directory",
        required: ["path"],
        properties: {
          depth: { maximum: 8, description: "how deep", type: "integer", minimum: 1, default: 1 },
          path: { maxLength: 4096, type: "string", minLength: 1, examples: ["/tmp"] }
        },
        type: "object",
        $comment: "internal"
      }
    });
    expect(b).toBe(a);
  });

  it("is identical for reordered `required` and `enum` and `anyOf` members", () => {
    const a = toolSchemaFingerprint({
      inputSchema: { type: "object", required: ["a", "b"], properties: { m: { enum: ["x", "y", "z"] }, u: { anyOf: [{ type: "string" }, { type: "number" }] } } }
    });
    const b = toolSchemaFingerprint({
      inputSchema: { type: "object", required: ["b", "a"], properties: { u: { anyOf: [{ type: "number" }, { type: "string" }] }, m: { enum: ["z", "x", "y"] } } }
    });
    expect(b).toBe(a);
  });
});

describe("toolSchemaFingerprint — security-significant changes flip it", () => {
  const baseline = toolSchemaFingerprint({ inputSchema: base });

  it("parameter added", () => {
    const changed = toolSchemaFingerprint({
      inputSchema: { ...base, properties: { ...base.properties, isUrl: { type: "boolean" } } }
    });
    expect(changed).not.toBe(baseline);
  });

  it("parameter removed", () => {
    const changed = toolSchemaFingerprint({ inputSchema: { ...base, properties: { path: base.properties.path } } });
    expect(changed).not.toBe(baseline);
  });

  it("parameter type change", () => {
    const changed = toolSchemaFingerprint({
      inputSchema: { ...base, properties: { ...base.properties, depth: { type: "string" } } }
    });
    expect(changed).not.toBe(baseline);
  });

  it("requiredness change (required -> optional)", () => {
    const changed = toolSchemaFingerprint({ inputSchema: { ...base, required: [] } });
    expect(changed).not.toBe(baseline);
  });

  it("requiredness change (optional -> required)", () => {
    const changed = toolSchemaFingerprint({ inputSchema: { ...base, required: ["path", "depth"] } });
    expect(changed).not.toBe(baseline);
  });

  it("constraint change (max bound)", () => {
    const changed = toolSchemaFingerprint({
      inputSchema: { ...base, properties: { ...base.properties, depth: { type: "integer", minimum: 1, maximum: 64 } } }
    });
    expect(changed).not.toBe(baseline);
  });

  it("constraint change (pattern added)", () => {
    const changed = toolSchemaFingerprint({
      inputSchema: { ...base, properties: { ...base.properties, path: { type: "string", minLength: 1, maxLength: 4096, pattern: "^/" } } }
    });
    expect(changed).not.toBe(baseline);
  });

  it("enum value set change", () => {
    const a = toolSchemaFingerprint({ inputSchema: { type: "object", properties: { m: { enum: ["x", "y"] } } } });
    const b = toolSchemaFingerprint({ inputSchema: { type: "object", properties: { m: { enum: ["x", "y", "z"] } } } });
    expect(b).not.toBe(a);
  });

  it("result-schema change flips the fingerprint when ACS relies on it", () => {
    const a = toolSchemaFingerprint({ inputSchema: base, outputSchema: { type: "object", properties: { ok: { type: "boolean" } } } });
    const b = toolSchemaFingerprint({ inputSchema: base, outputSchema: { type: "object", properties: { ok: { type: "string" } } } });
    expect(b).not.toBe(a);
    // and: adding an output schema at all is a change
    expect(toolSchemaFingerprint({ inputSchema: base })).not.toBe(a);
  });
});

describe("Zod <-> JSON Schema parity", () => {
  it("the ACS Zod argsSchema and the equivalent advertised JSON Schema fingerprint the same", () => {
    const zodSchema = z
      .object({
        path: z.string().min(1).max(4096),
        depth: z.number().int().min(1).max(8).optional()
      })
      .strict();
    const advertised = {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", minLength: 1, maxLength: 4096 },
        depth: { type: "integer", minimum: 1, maximum: 8 }
      },
      required: ["path"]
    };
    expect(toolSchemaFingerprint({ inputSchema: zodSchema })).toBe(toolSchemaFingerprint({ inputSchema: advertised }));
  });

  it("a Zod requiredness change diverges from the pinned JSON fingerprint", () => {
    const advertised = {
      type: "object",
      additionalProperties: false,
      properties: { path: { type: "string", minLength: 1 } },
      required: ["path"]
    };
    const drifted = z.object({ path: z.string().min(1).optional() }).strict();
    expect(toolSchemaFingerprint({ inputSchema: drifted })).not.toBe(toolSchemaFingerprint({ inputSchema: advertised }));
  });
});

describe("canonicalJsonSchema", () => {
  it("drops non-semantic keywords entirely", () => {
    const canon = canonicalJsonSchema({ type: "string", description: "d", title: "t", $id: "x", default: "y", examples: ["z"], minLength: 1 });
    expect(canon).toEqual({ type: "string", minLength: 1 });
  });
});
