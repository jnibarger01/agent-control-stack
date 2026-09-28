import { describe, expect, it } from "vitest";
import {
  JC_FS_LIMITS,
  JC_TOOL_GROUPS,
  jcPortableManifest,
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
      expect(Object.isFrozen(entry.scopes), `${entry.name} scopes must be immutable`).toBe(true);
      expect(JC_ACTION_KINDS).toContain(entry.actionKind);
      expect(entry.argsSchema).toBe(JC_TOOL_ARGUMENT_SCHEMAS[entry.name]);
      // Strict: an unknown key is rejected, never silently stripped.
      const probe = entry.argsSchema.safeParse({ __acs_unknown_field__: true });
      expect(probe.success, `${entry.name} must reject unknown keys`).toBe(false);
      if (!probe.success) {
        expect(
          probe.error.issues.some(
            (issue) => issue.code === "unrecognized_keys" && issue.keys.includes("__acs_unknown_field__")
          ),
          `${entry.name} must reject the unknown key specifically`
        ).toBe(true);
      }
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

  it("puts every tool in a known group and gives filesystem tools ACS path containment", () => {
    for (const entry of jcToolContracts()) {
      expect(JC_TOOL_GROUPS).toContain(entry.group);
      if (entry.group === "filesystem") {
        expect(entry.scopes).toEqual(["fs.read"]);
        expect(entry.actionKind).toBe("jc.fs.read");
        expect(entry.pathArguments.length, `${entry.name} must declare its path arguments`).toBeGreaterThan(0);
      }
    }
  });

  it("maps each CLI verb to exactly one tool", () => {
    const verbs = jcToolContracts().flatMap((entry) => entry.cliCommands);
    expect(new Set(verbs).size).toBe(verbs.length);
    expect(jcToolContract("read_file")!.cliCommands).toEqual(["read", "cat"]);
    expect(jcToolContract("list_directory")!.cliCommands).toEqual(["ls"]);
    expect(jcToolContract("get_file_info")!.cliCommands).toEqual(["stat"]);
  });

  it("filesystem schemas require absolute paths and enforce the shared limits", () => {
    const read = jcToolContract("read_file")!.argsSchema;
    expect(read.safeParse({ path: "/tmp/x" }).success).toBe(true);
    expect(read.safeParse({ path: "relative/x" }).success).toBe(false);
    expect(read.safeParse({ path: "~/x" }).success).toBe(false);
    expect(read.safeParse({ path: "/tmp/x", length: JC_FS_LIMITS.maxReadLines + 1 }).success).toBe(false);
    expect(read.safeParse({ path: "/tmp/x", offset: -5 }).success).toBe(true);
    const many = jcToolContract("read_multiple_files")!.argsSchema;
    expect(many.safeParse({ paths: [] }).success).toBe(false);
    expect(many.safeParse({ paths: Array.from({ length: JC_FS_LIMITS.maxMultipleFiles + 1 }, (_, i) => `/f${i}`) }).success).toBe(false);
    const ls = jcToolContract("list_directory")!.argsSchema;
    expect(ls.safeParse({ path: "/tmp", depth: JC_FS_LIMITS.maxListDepth + 1 }).success).toBe(false);
  });

  it("portable manifest is JSON-safe, sorted, and its hash tracks content", () => {
    const portable = jcPortableManifest();
    expect(JSON.parse(JSON.stringify(portable))).toEqual(portable);
    expect(portable.tools.map((tool) => tool.name)).toEqual(jcToolNames());
    expect(portable.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(jcPortableManifest().manifestHash).toBe(portable.manifestHash);
  });

  it("jcToolContract returns undefined for an unknown tool", () => {
    expect(jcToolContract("not_a_real_tool")).toBeUndefined();
  });
});
