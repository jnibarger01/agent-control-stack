import { describe, expect, it } from "vitest";
import { WebMcpError, WebMcpErrorCode } from "./contracts.js";
import {
  assertTrustedOrigin,
  normalizeAnnotations,
  parseInputSchema,
  schemaHash,
  validateArguments
} from "./normalize.js";
import { expectCode } from "./test-support.js";

describe("parseInputSchema (live Chrome returns inputSchema as a JSON string)", () => {
  it("converts the JSON string into a structured schema", () => {
    const schema = parseInputSchema(
      JSON.stringify({
        type: "object",
        properties: { day: { type: "string", enum: ["mon", "tue"] } },
        required: ["day"],
        additionalProperties: false
      })
    );
    expect(schema.type).toBe("object");
    expect(schema.properties.day).toEqual({ type: "string", enum: ["mon", "tue"] });
    expect(schema.required).toEqual(["day"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("is stable across the string and object forms (schema conversion is canonical)", () => {
    const parsed = { type: "object", properties: { n: { type: "integer" } }, required: [], additionalProperties: false };
    expect(schemaHash(parseInputSchema(JSON.stringify(parsed)))).toBe(schemaHash(parseInputSchema(parsed)));
  });

  it("defaults a missing required list to empty", () => {
    const schema = parseInputSchema(
      JSON.stringify({ type: "object", properties: {}, additionalProperties: false })
    );
    expect(schema.required).toEqual([]);
  });

  it.each([
    ["not JSON at all", "{ not json", WebMcpErrorCode.SchemaInvalid],
    ["a JSON array", "[]", WebMcpErrorCode.SchemaUnsupported],
    ["a non-object root", JSON.stringify({ type: "string" }), WebMcpErrorCode.SchemaUnsupported],
    [
      "open additionalProperties",
      JSON.stringify({ type: "object", properties: {}, additionalProperties: true }),
      WebMcpErrorCode.SchemaUnsupported
    ],
    [
      "a missing additionalProperties",
      JSON.stringify({ type: "object", properties: {} }),
      WebMcpErrorCode.SchemaUnsupported
    ],
    [
      "unsupported root keywords",
      JSON.stringify({ type: "object", properties: {}, additionalProperties: false, $ref: "#/x" }),
      WebMcpErrorCode.SchemaUnsupported
    ],
    [
      "a nested object property",
      JSON.stringify({ type: "object", properties: { a: { type: "object" } }, additionalProperties: false }),
      WebMcpErrorCode.SchemaUnsupported
    ],
    [
      "an array property",
      JSON.stringify({ type: "object", properties: { a: { type: "array" } }, additionalProperties: false }),
      WebMcpErrorCode.SchemaUnsupported
    ],
    [
      "required naming an undeclared property",
      JSON.stringify({
        type: "object",
        properties: { a: { type: "string" } },
        required: ["b"],
        additionalProperties: false
      }),
      WebMcpErrorCode.SchemaInvalid
    ],
    [
      "an enum whose values do not match the field type",
      JSON.stringify({
        type: "object",
        properties: { a: { type: "string", enum: [1, 2] } },
        required: [],
        additionalProperties: false
      }),
      WebMcpErrorCode.SchemaInvalid
    ],
    [
      "an empty enum",
      JSON.stringify({
        type: "object",
        properties: { a: { type: "string", enum: [] } },
        required: [],
        additionalProperties: false
      }),
      WebMcpErrorCode.SchemaInvalid
    ]
  ])("rejects %s", (_label, input, expected) => {
    try {
      parseInputSchema(input);
      throw new Error("expected parseInputSchema to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(WebMcpError);
      expect((error as WebMcpError).code).toBe(expected);
    }
  });

  it("rejects a missing inputSchema", () => {
    expectCode(() => parseInputSchema(undefined), "webmcp_schema_unsupported");
  });
});

describe("normalizeAnnotations", () => {
  it("maps null/absent to unknown rather than read-only", () => {
    expect(normalizeAnnotations(null)).toBeNull();
    expect(normalizeAnnotations(undefined)).toBeNull();
  });

  it("normalizes the live Chrome annotation shape", () => {
    expect(normalizeAnnotations({ readOnlyHint: true, consequentialHint: false, untrustedContentHint: false })).toEqual({
      readOnlyHint: true,
      consequentialHint: false,
      untrustedContentHint: false
    });
  });

  it("rejects unknown annotation keys and non-boolean values", () => {
    expectCode(() => normalizeAnnotations({ destructiveHint: true }), "webmcp_annotations_invalid");
    expectCode(() => normalizeAnnotations({ readOnlyHint: "yes" }), "webmcp_annotations_invalid");
    expectCode(() => normalizeAnnotations("readonly"), "webmcp_annotations_invalid");
  });
});

describe("validateArguments", () => {
  const schema = parseInputSchema(
    JSON.stringify({
      type: "object",
      properties: { day: { type: "string", enum: ["mon", "tue"] }, count: { type: "integer" } },
      required: ["day"],
      additionalProperties: false
    })
  );

  it("accepts declared, correctly typed arguments", () => {
    expect(validateArguments({ day: "mon", count: 3 }, schema)).toEqual({ day: "mon", count: 3 });
  });

  it.each([
    ["a missing required argument", { count: 1 }],
    ["an undeclared argument", { day: "mon", sneaky: true }],
    ["a value outside the enum", { day: "wed" }],
    ["a wrong scalar type", { day: 7 }],
    ["a non-integer for an integer field", { day: "mon", count: 1.5 }],
    ["a non-object", "day=mon"]
  ])("rejects %s", (_label, args) => {
    expectCode(() => validateArguments(args, schema), "webmcp_arguments_invalid");
  });
});

describe("assertTrustedOrigin", () => {
  it("accepts https and loopback http (Chrome's secure-context set)", () => {
    expect(assertTrustedOrigin("https://showroom.example")).toBe("https://showroom.example");
    expect(assertTrustedOrigin("http://127.0.0.1:8799")).toBe("http://127.0.0.1:8799");
    expect(assertTrustedOrigin("http://localhost:8799")).toBe("http://localhost:8799");
  });

  it.each([
    ["plain http on a public host", "http://showroom.example"],
    ["a credentialed origin", "https://user:pass@showroom.example"],
    ["a non-origin URL with a path", "https://showroom.example/path"],
    ["a scheme-less value", "showroom.example"],
    ["garbage", "not a url"]
  ])("rejects %s", (_label, origin) => {
    expectCode(() => assertTrustedOrigin(origin), "webmcp_origin_untrusted");
  });
});
