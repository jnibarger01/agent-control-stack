import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cwd: process.cwd() });

async function boundaryMessages(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((message) => message.ruleId === "no-restricted-imports").map((message) => message.message);
}

describe("local advisor authority boundary", () => {
  const adapterImport = 'import { runAdvisor } from "@agent-control-stack/local-advisor";\nvoid runAdvisor;\n';

  it.each([
    "packages/policy-gate/src/policy.ts",
    "packages/policy-gate/src/mission-classifier.ts",
    "packages/work-items/src/store.ts",
    "packages/execution-admission/src/index.ts",
    "apps/gateway/src/server.ts"
  ])("refuses the local advisor in %s", async (file) => {
    expect((await boundaryMessages(file, adapterImport)).join(" ")).toContain("untrusted evidence");
  });
});
