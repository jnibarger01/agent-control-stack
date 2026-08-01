import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detonatePlugin } from "./plugin-detonation.js";

describe("plugin detonation", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("static-scans a plugin and reports dangerous capabilities without mounting secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "acs-plugin-fixture-"));
    directories.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "index.js"), "import { execSync } from 'node:child_process'; process.env.TOKEN;\n");

    const report = await detonatePlugin({ pluginId: "fixture", pluginPath: root });
    expect(report.requestedCapabilities).toEqual(["process", "secrets"]);
    expect(report.verdict).toBe("fail");
    expect(report.observedBehavior.networkHosts).toEqual([]);
    expect(report.recommendedPolicy.find((rule) => rule.capability === "secrets")?.decision).toBe("deny");
  });

  it("fails closed when a smoke test cannot be network-isolated", async () => {
    const root = await mkdtemp(join(tmpdir(), "acs-plugin-smoke-"));
    directories.push(root);
    await writeFile(join(root, "package.json"), "{}\n");
    const report = await detonatePlugin({
      pluginId: "smoke",
      pluginPath: root,
      smokeCommand: ["/bin/true"],
      commandRunner: async () => ({
        ok: false,
        timedOut: false,
        output: "network isolation unavailable",
        processesSpawned: []
      })
    });
    expect(report.verdict).toBe("fail");
    expect(report.smokeTest.attempted).toBe(true);
    expect(report.smokeTest.ok).toBe(false);
  });

  it("captures added, modified, and deleted files from the smoke test", async () => {
    const root = await mkdtemp(join(tmpdir(), "acs-plugin-diff-"));
    directories.push(root);
    await writeFile(join(root, "modified.txt"), "before\n");
    await writeFile(join(root, "deleted.txt"), "remove\n");

    const report = await detonatePlugin({
      pluginId: "diff",
      pluginPath: root,
      smokeCommand: ["fixture"],
      commandRunner: async (_command, cwd) => {
        await writeFile(join(cwd, "modified.txt"), "after\n");
        await writeFile(join(cwd, "added.txt"), "new\n");
        await unlink(join(cwd, "deleted.txt"));
        return { ok: true, timedOut: false, output: "", processesSpawned: [] };
      }
    });

    expect(report.verdict).toBe("pass");
    expect(report.observedBehavior.filesWritten).toEqual(["added.txt", "deleted.txt", "modified.txt"]);
  });
});
