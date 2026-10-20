import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * compose.production.yml enumerates the gateway container's environment explicitly, so a flag set in the host
 * shell (as the Mission Control rollout runbook instructs) only reaches the gateway if it is listed there.
 */
describe("production Compose passes the Mission Control web rollout flags", () => {
  const compose = readFileSync(new URL("../../../compose.production.yml", import.meta.url), "utf8");
  const source = readFileSync(new URL("./mission-control-web.ts", import.meta.url), "utf8");

  it("lists every ACS_MC_WEB* flag the gateway reads, defaulting to off", () => {
    const flags = [...new Set(source.match(/process\.env\.(ACS_MC_WEB\w*)/g)?.map((m) => m.replace("process.env.", "")))];
    expect(flags.sort()).toEqual(["ACS_MC_WEB", "ACS_MC_WEB_DEFAULT"]);
    for (const flag of flags) expect(compose, flag).toMatch(new RegExp(`^\\s+${flag}: \\$\\{${flag}:-0\\}$`, "m"));
  });
});
