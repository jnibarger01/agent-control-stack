import { describe, expect, it } from "vitest";
import { ACS_CLI_VERSION, AcsUsageError, parseAcsArgs } from "./parse.js";

describe("parseAcsArgs", () => {
  it("parses help and version", () => {
    expect(parseAcsArgs([])).toEqual({ kind: "help" });
    expect(parseAcsArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseAcsArgs(["--version"])).toEqual({ kind: "version" });
    expect(ACS_CLI_VERSION).toBe("0.1.0-alpha");
  });

  it("parses actor list --available --json", () => {
    expect(parseAcsArgs(["actor", "list", "--available", "--json"])).toEqual({
      kind: "actor-list-available",
      json: true
    });
  });

  it("requires --available on actor list", () => {
    expect(() => parseAcsArgs(["actor", "list", "--json"])).toThrow(AcsUsageError);
  });

  it("accepts optional run/serve adapters and --config", () => {
    expect(parseAcsArgs(["worker"])).toEqual({ kind: "worker", forwarded: [] });
    expect(parseAcsArgs(["worker", "run"])).toEqual({ kind: "worker", forwarded: [] });
    expect(parseAcsArgs(["scheduler", "run"])).toEqual({ kind: "scheduler", forwarded: [] });
    expect(parseAcsArgs(["mcp", "--config", "config.yml"])).toEqual({
      kind: "mcp",
      forwarded: ["--config", "config.yml"]
    });
    expect(parseAcsArgs(["mcp", "serve", "--config", "config.yml"])).toEqual({
      kind: "mcp",
      forwarded: ["--config", "config.yml"]
    });
    expect(parseAcsArgs(["gateway", "serve"])).toEqual({ kind: "gateway", forwarded: [] });
  });

  it("parses skills operator commands", () => {
    expect(parseAcsArgs(["skills", "list"])).toEqual({ kind: "skills", args: ["list"] });
    expect(parseAcsArgs(["skills", "retrieve", "--problem", "invalid hook call"])).toEqual({
      kind: "skills",
      args: ["retrieve", "--problem", "invalid hook call"]
    });
  });

  it("rejects unknown commands and flags", () => {
    expect(() => parseAcsArgs(["widgets"])).toThrow(/unknown command/);
    expect(() => parseAcsArgs(["worker", "--daemon"])).toThrow(/invalid worker argument/);
    expect(() => parseAcsArgs(["mcp", "--listen"])).toThrow(/invalid mcp argument/);
  });
});
