import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Runs the Bash sandbox test for scripts/deploy-gateway-release.sh inside the authoritative Vitest suite so the
// lock, rollback and --resume safety regressions fail CI. The script under test is driven with stub systemctl/curl/
// node, a temporary HOME and an isolated user bus; it cannot reach a real service, database or release.
const script = fileURLToPath(new URL("../../scripts/deploy-gateway-release.test.sh", import.meta.url));

const has = (tool: string) => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;
const toolsAvailable = has("bash") && has("sqlite3") && has("flock") && has("git");

describe("deploy-gateway-release.sh sandbox test", () => {
  it.skipIf(!toolsAvailable)(
    "passes every activation, rollback, --resume, lock and guard check",
    () => {
      const run = (): string => {
        try {
          return execFileSync("bash", [script], {
            encoding: "utf8",
            timeout: 240_000,
            stdio: ["ignore", "pipe", "pipe"]
          });
        } catch (error) {
          const failure = error as { stdout?: string; stderr?: string };
          throw new Error(`deploy script sandbox test failed:\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`, {
            cause: error
          });
        }
      };
      const output = run();
      expect(output).toContain("all checks passed");
    },
    300_000
  );
});
