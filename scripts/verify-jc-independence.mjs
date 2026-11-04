/**
 * Build and exercise a physical copy outside the monorepo. No symlinks, parent
 * configs, workspace imports or vendor tree are available to resolve from.
 */
import { mkdtempSync, cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const source = fileURLToPath(new URL("../apps/jace-commander/", import.meta.url));
const temp = mkdtempSync(join("/tmp", "jc-independent-"));
try {
  for (const name of ["src", "test", "deploy", "package.json", "tsconfig.json"])
    cpSync(join(source, name), join(temp, name), { recursive: true });
  if (existsSync(join(temp, "vendor")) || existsSync(join(temp, "node_modules")))
    throw new Error("copy contains external runtime dependencies");
  for (const [command, args] of [
    ["npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"]],
    ["npm", ["test"]]
  ]) {
    const result = spawnSync(command, args, {
      cwd: temp,
      stdio: "inherit",
      timeout: 300000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8" }
    });
    if (result.status !== 0) throw new Error(command + " " + args.join(" ") + " failed (exit " + result.status + ")");
  }
  console.log("PASS: JC built and tested outside the repository, with no Desktop Commander or workspace files");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
