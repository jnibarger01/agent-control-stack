import { describe, expect, it } from "vitest";
import { classifyBreakingChanges, type CompatibilitySurface } from "./public-contract-compatibility.js";

const baseline: CompatibilitySurface = {
  operations: {
    "POST /work-items": {
      required: ["title"],
      properties: ["intent", "title"],
      propertyTypes: { intent: "string", title: "string" },
      propertyEnums: {}
    }
  },
  tools: {
    list_work_items: {
      required: [],
      properties: ["status"],
      propertyTypes: { status: "string" },
      propertyEnums: { status: ["approved", "blocked"] }
    }
  }
};

describe("public contract compatibility classification", () => {
  it("allows additive optional properties and operations", () => {
    expect(
      classifyBreakingChanges(baseline, {
        operations: {
          ...baseline.operations,
          "GET /health": { required: [], properties: [], propertyTypes: {}, propertyEnums: {} },
          "POST /work-items": {
            required: ["title"],
            properties: ["intent", "risk", "title"],
            propertyTypes: { intent: "string", risk: "string", title: "string" },
            propertyEnums: {}
          }
        },
        tools: baseline.tools
      })
    ).toEqual([]);
  });

  it("classifies removed surfaces, removed properties, and new requirements", () => {
    expect(
      classifyBreakingChanges(baseline, {
        operations: {
          "POST /work-items": {
            required: ["risk", "title"],
            properties: ["risk", "title"],
            propertyTypes: { risk: "string", title: "number" },
            propertyEnums: {}
          }
        },
        tools: {}
      })
    ).toEqual([
      "operation-property-removed:POST /work-items:intent",
      "operation-property-type-changed:POST /work-items:title",
      "operation-required-added:POST /work-items:risk",
      "tool-removed:list_work_items"
    ]);
  });

  it("classifies removed enum values", () => {
    expect(
      classifyBreakingChanges(baseline, {
        operations: baseline.operations,
        tools: {
          list_work_items: {
            required: [],
            properties: ["status"],
            propertyTypes: { status: "string" },
            propertyEnums: { status: ["approved"] }
          }
        }
      })
    ).toEqual(["tool-enum-value-removed:list_work_items:status:blocked"]);
  });
});
