import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

/** Every non-test module in this package and the only imports it may use. */
const allowedImports: Record<string, string[]> = {
  "./plan.ts": ["node:crypto"],
  // F1 preview stays pure: the read-only repository reader is injected by the gateway.
  "./preview.ts": ["node:crypto", "./plan.js"],
  "./admission.ts": ["node:crypto", "./preview.js"],
  "./dag.ts": ["node:crypto", "./plan.js"]
};

describe("factory has no authority side effects", () => {
  for (const [file, expected] of Object.entries(allowedImports)) {
    const source = read(file);

    it(file + " imports only the allowed pure modules", () => {
      const imports = [...source.matchAll(/from\s+["']([^"']+)["']/gu)].map((match) => match[1]);
      expect(imports).toEqual(expected);
    });

    it(file + " does not import a network, scheduler, permission, database or subprocess API", () => {
      for (const pattern of [/node:child_process/u, /node:sqlite/u, /node:http/u, /node:fs/u,
        /@agent-control-stack\/(?:policy-gate|publication|work-items|sandbox|execution-controller)/u,
        /\bfetch\(/u, /\bspawn\(/u, /\bexecFile\(/u, /\bprocess\.env\b/u]) {
        expect(source, String(pattern)).not.toMatch(pattern);
      }
    });
  }
});
