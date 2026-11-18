import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./plan.ts", import.meta.url)), "utf8");

describe("factory has no authority side effects", () => {
  it("imports only the Node hash primitive", () => {
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/gu)].map((match) => match[1]);
    expect(imports).toEqual(["node:crypto"]);
  });

  it("does not import a network, scheduler, permission, database or subprocess API", () => {
    for (const pattern of [/node:child_process/u, /node:sqlite/u, /node:http/u, /node:fs/u,
      /@agent-control-stack\/(?:policy-gate|publication|work-items|sandbox|execution-controller)/u,
      /\bfetch\(/u, /\bspawn\(/u, /\bexecFile\(/u, /\bprocess\.env\b/u]) {
      expect(source, String(pattern)).not.toMatch(pattern);
    }
  });
});

