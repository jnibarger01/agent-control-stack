import { describe, expect, it } from "vitest";
import {
  ACS_DC_SCOPES,
  DC_CAPABILITY_META_KEYS,
  DC_CAPABILITY_OPTIONAL_DISCOVERY_TOOLS,
  DC_TOOL_ARGUMENT_SCHEMAS,
  DC_TRANSPORT_METADATA_ARGUMENT_KEYS,
  DC_TRANSPORT_METADATA_VALUES,
  dcCapabilityToolContract,
  dcCapabilityToolContracts,
  dcToolContract,
  dcToolContracts,
  isAcsAuthorityMetaKey,
  managedToolCoverageDocument
} from "./index.js";

describe("dc-tool-manifest", () => {
  it("lists every tool exactly once, sorted", () => {
    const names = dcToolContracts().map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...names].sort((left, right) => left.localeCompare(right)));
    expect(names).toHaveLength(47);
    expect(dcCapabilityToolContracts()).toHaveLength(31);
  });

  it("gives every capability tool a known scope and a strict schema, and no schema to unsupported tools", () => {
    for (const entry of dcToolContracts()) {
      if (entry.managed === "capability") {
        expect(ACS_DC_SCOPES).toContain(entry.scope);
        expect(entry.argsSchema).toBe(DC_TOOL_ARGUMENT_SCHEMAS[entry.name]);
        // Strict: an unknown key is rejected, never silently stripped.
        const probe = entry.argsSchema.safeParse({ __acs_unknown_field__: true });
        expect(probe.success, `${entry.name} must reject unknown keys`).toBe(false);
      } else {
        expect(entry).not.toHaveProperty("argsSchema");
        expect(dcCapabilityToolContract(entry.name)).toBeUndefined();
      }
    }
    expect(Object.keys(DC_TOOL_ARGUMENT_SCHEMAS).sort()).toEqual(
      dcCapabilityToolContracts().map((entry) => entry.name)
    );
  });

  it("requires approval for every mutating or executing capability tool", () => {
    for (const entry of dcCapabilityToolContracts()) {
      const mutatesOrExecutes =
        entry.toolClass === "filesystem_mutation" ||
        entry.toolClass === "process_execution" ||
        entry.toolClass === "process_control" ||
        entry.toolClass === "configuration_mutation";
      if (mutatesOrExecutes) expect(entry.requiresApproval, entry.name).toBe(true);
      if (entry.scope === "fs.write" || entry.scope === "process.spawn")
        expect(entry.requiresApproval, entry.name).toBe(true);
      if (entry.riskClass === "read_only") expect(entry.requiresApproval, entry.name).toBe(false);
    }
  });

  it("grants no managed tool network scope", () => {
    for (const entry of dcCapabilityToolContracts()) expect(entry.scope.startsWith("network.")).toBe(false);
  });

  it("keeps origin as the only transport-metadata key", () => {
    expect([...DC_TRANSPORT_METADATA_ARGUMENT_KEYS]).toEqual(["origin"]);
    expect([...DC_TRANSPORT_METADATA_VALUES.origin]).toEqual(["ui", "llm"]);
    // Transport metadata is not accepted as an authorization argument.
    for (const entry of dcCapabilityToolContracts()) {
      const shape = (entry.argsSchema as { shape?: Record<string, unknown> }).shape ?? {};
      expect(Object.keys(shape)).not.toContain("origin");
    }
  });

  it("classifies client-supplied ACS authority meta keys for stripping", () => {
    expect(isAcsAuthorityMetaKey(DC_CAPABILITY_META_KEYS.gateway)).toBe(true);
    expect(isAcsAuthorityMetaKey(DC_CAPABILITY_META_KEYS.guard)).toBe(true);
    expect(isAcsAuthorityMetaKey("acsLeaseBinding")).toBe(true);
    expect(isAcsAuthorityMetaKey("progressToken")).toBe(false);
  });

  it("marks only get_runtime_identity as a capability-optional discovery tool", () => {
    expect([...DC_CAPABILITY_OPTIONAL_DISCOVERY_TOOLS]).toEqual(["get_runtime_identity"]);
    const entry = dcToolContract("get_runtime_identity");
    expect(entry?.managed).toBe("capability");
    expect(entry?.managed === "capability" && entry.requiresApproval).toBe(false);
  });

  it("projects the coverage document with scopes only on capability tools", () => {
    const document = managedToolCoverageDocument();
    expect(Object.keys(document.tools)).toEqual(dcToolContracts().map((entry) => entry.name));
    for (const [name, entry] of Object.entries(document.tools)) {
      if (entry.managed === "capability") {
        expect(entry.scopes).toEqual([dcCapabilityToolContract(name)?.scope]);
      } else {
        expect(entry).not.toHaveProperty("scopes");
        expect(entry).not.toHaveProperty("requiresApproval");
      }
    }
  });
});
