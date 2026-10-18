import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const srcDir = fileURLToPath(new URL(".", import.meta.url));

function walk(dir: string, keep: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "dist" || name === "node_modules" || name === ".git") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, keep));
    else if (keep(full)) out.push(full);
  }
  return out;
}

const isSource = (path: string): boolean =>
  path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith(".test-support.ts");

/** Comments may describe what is forbidden; only executable text is scanned. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:"'`])\/\/.*$/gmu, "$1");
}

const files = walk(srcDir, isSource);
const code = files
  .map((file) => `\n/* ${relative(repoRoot, file)} */\n${stripComments(readFileSync(file, "utf8"))}`)
  .join("\n");

describe("Outcome Engine architecture (a verdict is evidence, never authority)", () => {
  it("finds the source it is meant to police", () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it("never spawns processes, opens a database, makes network calls, or reaches a write endpoint", () => {
    for (const [pattern, why] of [
      [/child_process/u, "spawns processes"],
      [/node:sqlite|DatabaseSync/u, "opens its own database"],
      [/\bfetch\(/u, "makes network calls"],
      [/gh pr\b/u, "drives gh pr"],
      [/--method\b/u, "passes --method"],
      [/["'`]-X["'`]/u, "passes -X"],
      [/\bmutation\b/iu, "issues a GraphQL mutation"],
      [
        /\.merge\(|mergePullRequest|enableAutoMerge|markReadyForReview|addComment|addLabels|createReview/u,
        "reaches a write operation"
      ],
      [/\bcreateEvent\(|appendAuditEvent/u, "bypasses the three-method port"],
      [/CREATE\s+TABLE|INSERT\s+INTO|ALTER\s+TABLE/iu, "runs DDL or SQL"],
      [/process\.env/u, "reads ambient environment (credentials come from the composition root)"]
    ] as const) {
      expect(code, why).not.toMatch(pattern);
    }
  });

  it("reaches the store only through the three allowed methods", () => {
    const allowed = new Set(["recordSystemEvent", "readEvents", "verifyAuditChain"]);
    const used = new Set([...code.matchAll(/\b(?:store|port)\.(\w+)/gu)].map((match) => match[1] as string));
    expect(used.size).toBeGreaterThan(0);
    expect([...used].filter((name) => !allowed.has(name))).toEqual([]);
  });

  it("imports nothing that can execute, approve, publish or run an app", () => {
    const imports = [...code.matchAll(/from\s+["']([^"']+)["']/gu)].map((match) => match[1] as string);
    const allowedPackages = new Set([
      "@agent-control-stack/shared",
      "@agent-control-stack/work-items",
      "@agent-control-stack/integration-manager",
      "zod",
      "node:crypto"
    ]);
    for (const specifier of imports) {
      if (specifier.startsWith(".")) continue;
      expect(allowedPackages.has(specifier), `unexpected import ${specifier}`).toBe(true);
    }
  });

  it("is the only package that records outcome.* audit events", () => {
    const offenders = [...walk(join(repoRoot, "packages"), isSource), ...walk(join(repoRoot, "apps"), isSource)]
      .filter((file) => !file.startsWith(join(repoRoot, "packages", "outcome-engine")))
      .filter((file) => /["'`]outcome\.(accepted|evaluation_recorded)["'`]/u.test(readFileSync(file, "utf8")));
    expect(offenders.map((file) => relative(repoRoot, file))).toEqual([]);
  });
});
