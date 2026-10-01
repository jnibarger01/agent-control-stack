import { describe, expect, it } from "vitest";
import { defineWebMcpPolicy, escalateRisk, resolveEffectivePolicy } from "./policy.js";
import { expectCode, webmcpTestOrigin } from "./test-support.js";

const policy = defineWebMcpPolicy([
  { origin: webmcpTestOrigin, toolName: "get_showroom_hours", risk: "read_only" },
  { origin: webmcpTestOrigin, toolName: "set_preferred_contact", risk: "reversible_mutation" }
]);

describe("ACS policy is the only source of a decision", () => {
  it("resolves declared tools and denies everything else", () => {
    expect(policy.resolve(webmcpTestOrigin, "get_showroom_hours")?.risk).toBe("read_only");
    expect(policy.resolve(webmcpTestOrigin, "set_preferred_contact")?.requiresApproval).toBe(true);
    expect(policy.resolve(webmcpTestOrigin, "undeclared_tool")).toBeUndefined();
    expect(policy.resolve("https://other.example", "get_showroom_hours")).toBeUndefined();
  });

  it("denies an undeclared tool outright, with no implicit allow", () => {
    expectCode(() =>
      resolveEffectivePolicy(policy, {
        origin: webmcpTestOrigin,
        toolName: "undeclared_tool",
        annotations: { readOnlyHint: true, consequentialHint: false, untrustedContentHint: false }
      })
    , "webmcp_tool_denied");
  });

  it("rejects duplicate entries and contradictory approval flags at definition time", () => {
    expectCode(() =>
      defineWebMcpPolicy([
        { origin: webmcpTestOrigin, toolName: "a", risk: "read_only" },
        { origin: webmcpTestOrigin, toolName: "a", risk: "read_only" }
      ])
    , "webmcp_policy_invalid");
    expectCode(() =>
      defineWebMcpPolicy([{ origin: webmcpTestOrigin, toolName: "a", risk: "read_only", requiresApproval: true }])
    , "webmcp_policy_invalid");
  });
});

describe("annotations cannot reduce ACS risk", () => {
  const readOnly = { readOnlyHint: true, consequentialHint: false, untrustedContentHint: false };

  it("keeps a declared read-only tool read-only when annotations agree", () => {
    const resolved = resolveEffectivePolicy(policy, {
      origin: webmcpTestOrigin,
      toolName: "get_showroom_hours",
      annotations: readOnly
    });
    expect(resolved.risk).toBe("read_only");
    expect(resolved.requiresApproval).toBe(false);
  });

  it("keeps a declared mutation requiring approval even when the page claims read-only", () => {
    const resolved = resolveEffectivePolicy(policy, {
      origin: webmcpTestOrigin,
      toolName: "set_preferred_contact",
      annotations: readOnly
    });
    expect(resolved.risk).toBe("reversible_mutation");
    expect(resolved.requiresApproval).toBe(true);
  });

  it.each([
    ["a consequential hint", { readOnlyHint: true, consequentialHint: true, untrustedContentHint: false }, "annotation_consequential"],
    ["a not-read-only hint", { readOnlyHint: false, consequentialHint: false, untrustedContentHint: false }, "annotation_not_read_only"],
    ["an untrusted-content hint", { readOnlyHint: true, consequentialHint: false, untrustedContentHint: true }, "annotation_untrusted_content"]
  ])("escalates a read-only declaration on %s", (_label, annotations, reason) => {
    const resolved = resolveEffectivePolicy(policy, {
      origin: webmcpTestOrigin,
      toolName: "get_showroom_hours",
      annotations
    });
    expect(resolved.risk).toBe("reversible_mutation");
    expect(resolved.requiresApproval).toBe(true);
    expect(resolved.escalatedBy).toBe(reason);
  });

  it("treats absent (null) annotations as unknown, not safe", () => {
    const resolved = resolveEffectivePolicy(policy, {
      origin: webmcpTestOrigin,
      toolName: "get_showroom_hours",
      annotations: null
    });
    expect(resolved.risk).toBe("reversible_mutation");
    expect(resolved.escalatedBy).toBe("annotation_unknown");
  });

  it("never downgrades a mutation, whatever the page claims", () => {
    expect(escalateRisk("reversible_mutation", null)).toBeUndefined();
    expect(escalateRisk("reversible_mutation", readOnly)).toBeUndefined();
  });
});
