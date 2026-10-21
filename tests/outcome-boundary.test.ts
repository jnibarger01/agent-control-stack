import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cwd: process.cwd() });
const FILE = "packages/outcome-engine/src/engine.ts";

async function restricted(code: string, filePath = FILE): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((m) => m.ruleId === "no-restricted-imports").map((m) => m.message);
}

describe("Outcome Engine import boundary", () => {
  it.each([
    ['import { spawn } from "node:child_process";\nvoid spawn;\n', "never spawns processes"],
    ['import { exec } from "child_process";\nvoid exec;\n', "never spawns processes"],
    ['import { DatabaseSync } from "node:sqlite";\nvoid DatabaseSync;\n', "four-method OutcomeStorePort"],
    ['import { x } from "@agent-control-stack/coding-mission";\nvoid x;\n', "never authority"],
    ['import { x } from "@agent-control-stack/policy-gate";\nvoid x;\n', "never authority"],
    ['import { x } from "@agent-control-stack/secret-broker";\nvoid x;\n', "never authority"],
    ['import { x } from "../../../apps/gateway/src/server.js";\nvoid x;\n', "never authority"]
  ])("refuses %#", async (code, expected) => {
    expect((await restricted(code)).join(" ")).toContain(expected);
  });

  it("still carries the global Jev, local-advisor and guidance bans (the override composes, never replaces)", async () => {
    expect((await restricted('import { x } from "@agent-control-stack/jev-advisor";\nvoid x;\n')).join(" ")).toContain(
      "advisory-only"
    );
    expect(
      (await restricted('import { x } from "@agent-control-stack/local-advisor";\nvoid x;\n')).join(" ")
    ).toContain("untrusted evidence");
    expect(
      (await restricted('import { x } from "@agent-control-stack/advisory/guidance";\nvoid x;\n')).join(" ")
    ).toContain("ADR 0027");
  });

  it("allows what the package legitimately depends on", async () => {
    expect(
      await restricted(
        'import { redactValue } from "@agent-control-stack/shared";\nimport type { PullRequestReader } from "@agent-control-stack/integration-manager";\nvoid redactValue;\n'
      )
    ).toEqual([]);
  });
});
