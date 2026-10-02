import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cwd: process.cwd() });

async function boundaryMessages(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((m) => m.ruleId === "no-restricted-imports").map((m) => m.message);
}

describe("Jev authority boundary (ADR 0020)", () => {
  const adapterImport = 'import { classifyJev } from "@agent-control-stack/jev-advisor";\nvoid classifyJev;\n';

  it.each([
    "packages/policy-gate/src/policy.ts",
    "packages/policy-gate/src/mission-classifier.ts",
    "packages/work-items/src/store.ts",
    "packages/execution-admission/src/index.ts",
    "apps/gateway/src/server.ts"
  ])("refuses the Jev adapter in %s", async (file) => {
    expect((await boundaryMessages(file, adapterImport)).join(" ")).toContain("advisory-only");
  });

  it("refuses the shadow hook in policy decision modules", async () => {
    const messages = await boundaryMessages(
      "packages/policy-gate/src/policy.ts",
      'import { runJevShadow } from "./jev-shadow.js";\nvoid runJevShadow;\n'
    );
    expect(messages.join(" ")).toContain("shadow hook");
  });

  it.each([
    "packages/work-items/src/store.ts",
    "packages/execution-admission/src/index.ts",
    "apps/gateway/src/server.ts"
  ])("refuses Jev shadow hooks re-exported by policy-gate in %s", async (file) => {
    const messages = await boundaryMessages(
      file,
      'import { maybeRunJevShadowAdvisory } from "@agent-control-stack/policy-gate";\nvoid maybeRunJevShadowAdvisory;\n'
    );
    expect(messages.join(" ")).toContain("advisory-only");
  });

  it("refuses cross-package deep imports of the Jev shadow module", async () => {
    const messages = await boundaryMessages(
      "packages/work-items/src/store.ts",
      'import { maybeRunJevShadowAdvisory } from "../../policy-gate/src/jev-shadow.js";\nvoid maybeRunJevShadowAdvisory;\n'
    );
    expect(messages.join(" ")).toContain("deep-import");
  });

  it("allows the policy-gate shadow hook only in the gateway MCP observation path", async () => {
    expect(
      await boundaryMessages(
        "apps/gateway/src/mcp.ts",
        'import { maybeRunJevShadowAdvisory } from "@agent-control-stack/policy-gate";\nvoid maybeRunJevShadowAdvisory;\n'
      )
    ).toEqual([]);
  });

  it.each(["packages/policy-gate/src/jev-shadow.ts", "packages/evidence/src/observation-worker.ts"])(
    "allows the adapter in %s",
    async (file) => {
      expect(await boundaryMessages(file, adapterImport)).toEqual([]);
    }
  );
});
