import { execFile, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const suite = fileURLToPath(new URL("../../deploy/systemd/acs-stack/acs-stack.test.sh", import.meta.url));

const systemdAvailable =
  process.platform === "linux" && spawnSync("systemd-analyze", ["--version"], { timeout: 5_000 }).status === 0;

it.runIf(systemdAvailable)(
  "validates ACS startup, installation, and rollback in an isolated systemd fixture",
  async () => {
    const { stdout } = await execFileAsync("bash", [suite], { timeout: 30_000 });
    expect(stdout).toContain("ACS startup controller tests passed");
  },
  35_000
);
