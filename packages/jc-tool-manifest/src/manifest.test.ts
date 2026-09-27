import { describe, expect, it } from "vitest";
import {
  JC_ACTION_KINDS,
  JC_SCOPES,
  JC_TOOL_ARGUMENT_SCHEMAS,
  JC_TOOL_NAMES,
  jcMcpToolDescriptors,
  jcToolContract,
  jcToolContracts,
  jcToolNames
} from "./index.js";

describe("jc-tool-manifest", () => {
  it("lists every tool exactly once, sorted, matching JC_TOOL_NAMES", () => {
    const names = jcToolContracts().map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...names].sort((left, right) => left.localeCompare(right)));
    expect([...names].sort()).toEqual([...JC_TOOL_NAMES].sort());
    expect(jcToolNames()).toEqual(names);
  });

  it("gives every tool a known scope, a known action kind, and a strict schema", () => {
    for (const entry of jcToolContracts()) {
      for (const scope of entry.scopes) expect(JC_SCOPES).toContain(scope);
      expect(JC_ACTION_KINDS).toContain(entry.actionKind);
      expect(entry.argsSchema).toBe(JC_TOOL_ARGUMENT_SCHEMAS[entry.name]);
      // Strict: an unknown key is rejected, never silently stripped.
      const probe = entry.argsSchema.safeParse({ __acs_unknown_field__: true });
      expect(probe.success, `${entry.name} must reject unknown keys`).toBe(false);
    }
  });

  it("gates only privileged_exec behind approval", () => {
    for (const entry of jcToolContracts()) {
      expect(entry.requiresApproval).toBe(entry.name === "privileged_exec");
    }
  });

  it("privileged_exec is the only critical-risk, process.privileged tool", () => {
    const critical = jcToolContracts().filter((entry) => entry.risk === "critical");
    expect(critical.map((entry) => entry.name)).toEqual(["privileged_exec"]);
    expect(critical[0]!.scopes).toEqual(["process.privileged"]);
    expect(critical[0]!.actionKind).toBe("privileged.exec");
  });

  it("jcMcpToolDescriptors matches the tools/list shape Jace Commander advertises", () => {
    const descriptors = jcMcpToolDescriptors();
    expect(descriptors).toHaveLength(jcToolContracts().length);
    for (const descriptor of descriptors) {
      const entry = jcToolContract(descriptor.name);
      expect(entry).toBeDefined();
      expect(descriptor.description).toBe(entry!.description);
      expect(descriptor.inputSchema).toEqual(entry!.inputSchema);
    }
  });

  it("jcToolContract returns undefined for an unknown tool", () => {
    expect(jcToolContract("not_a_real_tool")).toBeUndefined();
  });
});
