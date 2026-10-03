import { execFile, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

// Runs the Bash sandbox test for scripts/deploy-gateway-release.sh inside the authoritative Vitest suite so the
// lock, rollback and --resume safety regressions fail CI. The script under test is driven with stub systemctl/curl/
// node, a temporary HOME and an isolated user bus; it cannot reach a real service, database or release.
//
// It must be asynchronous: the script takes about a minute on a loaded CI runner, and a synchronous child process
// (execFileSync) blocks this worker's event loop for that long, so Vitest's worker RPC times out
// ("Timeout calling onTaskUpdate") and the run fails with an unhandled error even though every test passed.
const script = fileURLToPath(new URL("../../scripts/deploy-gateway-release.test.sh", import.meta.url));

const has = (tool: string) => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;
const toolsAvailable = has("bash") && has("sqlite3") && has("flock") && has("git");

describe("deploy-gateway-release.sh sandbox test", () => {
  it.skipIf(!toolsAvailable)(
    "passes every activation, rollback, --resume, lock and guard check",
    async () => {
      let output: string;
      try {
        ({ stdout: output } = await execFileAsync("bash", [script], { encoding: "utf8", timeout: 240_000 }));
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string };
        throw new Error(`deploy script sandbox test failed:\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`, {
          cause: error
        });
      }
      expect(output).toContain("all checks passed");
    },
    300_000
  );
});
