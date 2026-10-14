import { readFileSync } from "node:fs";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cwd: process.cwd() });
const guidanceImport =
  'import { consultAdvisorModel } from "@agent-control-stack/advisory/guidance";\nvoid consultAdvisorModel;\n';

async function boundaryMessages(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? [])
    .filter((message) => message.ruleId === "no-restricted-imports")
    .map((message) => message.message);
}

describe("advisor guidance boundary (ADR 0027)", () => {
  it.each([
    "packages/policy-gate/src/policy.ts",
    "packages/actor-router/src/authoritative.ts",
    "packages/work-items/src/store.ts",
    "apps/gateway/src/mcp.ts"
  ])("refuses the guidance module in %s", async (file) => {
    expect((await boundaryMessages(file, guidanceImport)).join(" ")).toContain("ADR 0027");
  });

  it("allows the guidance module only in the consult wrapper", async () => {
    expect(await boundaryMessages("apps/gateway/src/advisor-consultation.ts", guidanceImport)).toEqual([]);
  });

  it("keeps the Jev adapter banned in the consult wrapper", async () => {
    const messages = await boundaryMessages(
      "apps/gateway/src/advisor-consultation.ts",
      'import { classifyJev } from "@agent-control-stack/jev-advisor";\nvoid classifyJev;\n'
    );
    expect(messages.join(" ")).toContain("advisory-only");
  });

  it("keeps guidance text out of the disposition module", () => {
    const source = readFileSync("packages/advisory/src/advisor-consultation.ts", "utf8");
    expect(source).not.toMatch(/from\s+["'][^"']*advisor-guidance/);
    expect(source).not.toContain("guidanceText");
  });
});
