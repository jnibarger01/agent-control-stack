import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertHermesPathContained,
  fingerprintHermesState,
  inspectHermesInstallation,
  prepareHermesE2eFixture,
  type HermesFixture
} from "./hermes-e2e-fixture.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Hermes fixture path confinement", () => {
  it("accepts fixture paths and rejects paths or symlinks that resolve outside", () => {
    const parent = mkdtempSync(join(tmpdir(), "acs-hermes-path-check-"));
    roots.push(parent);
    const fixture = join(parent, "fixture");
    const outside = join(parent, "outside");
    mkdirSync(fixture);
    mkdirSync(outside);
    symlinkSync(outside, join(fixture, "escape"));

    expect(assertHermesPathContained(fixture, join(fixture, "not-yet-created", "state.db")))
      .toBe(join(fixture, "not-yet-created", "state.db"));
    expect(() => assertHermesPathContained(fixture, join(fixture, "escape", "state.db")))
      .toThrow(/escapes fixture root/);
    expect(() => assertHermesPathContained(fixture, outside)).toThrow(/escapes fixture root/);
  });

  it("prepares an isolated fixture without changing persistent Hermes", async () => {
    const state = (property: string) => execFileSync("systemctl", ["--user", "show", "hermes-gateway.service", `-p${property}`, "--value"], { encoding: "utf8" }).trim();
    expect(state("ActiveState")).toBe("inactive");
    expect(state("MainPID")).toBe("0");
    expect(execFileSync("systemctl", ["--user", "list-jobs", "--no-legend"], { encoding: "utf8" }).trim()).toBe("");
    const restartCountBefore = state("NRestarts");
    const processes = execFileSync("ps", ["-eo", "pid=,comm=,args="], { encoding: "utf8" });
    const activeWriters = processes.split("\n").filter((line) => {
      const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
      if (!match) return false;
      const pid = Number(match[1]);
      const command = match[2] ?? "";
      const args = match[3] ?? "";
      if (pid === process.pid || args.includes("hermes-e2e-fixture.test")) return false;
      return /^(hermes|hermes-acp|hermes-gateway)$/i.test(command) ||
        /source.?completion|hermes_cli\.(update|venv_sync|main)/.test(args);
    });
    expect(activeWriters).toEqual([]);

    const installation = inspectHermesInstallation("/home/jacen/.local/bin/hermes");
    const persistentLaunchers = [installation.launcher, join(installation.sourceRoot, ".hermes", "bin", "hermes-acp")];
    const launcherBytesBefore = persistentLaunchers.map((path) => readFileSync(path));
    const manifestRoots = [
      ...persistentLaunchers,
      join(installation.sourceRoot, ".hermes", "bin"),
      join(installation.sourceRoot, "install-stamp.json"),
      join(installation.sourceRoot, ".hermes-bootstrap-complete"),
      join(installation.installState, "facts.json"),
      join(installation.installState, "pm-runtime"),
      join(installation.installState, "inputs"),
      join(installation.environment, "pyvenv.cfg"),
      join(installation.environment, "bin"),
      join(installation.runtimeRoot, "facts.json"),
      join(installation.hermesHome, "config.yaml"),
      ...readdirSync(join(installation.hermesHome, "profiles"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(installation.hermesHome, "profiles", entry.name, "config.yaml"))
    ];
    const manifestBefore = await fingerprintHermesState(manifestRoots);
    const fixtureDirectory = mkdtempSync(join(tmpdir(), "acs-hermes-fixture-preparation-"));
    roots.push(fixtureDirectory);
    process.stderr.write(`Hermes preparation-only fixture: ${fixtureDirectory}\n`);
    let fixture: HermesFixture | undefined;
    let preparationError: unknown;
    try {
      fixture = prepareHermesE2eFixture("/home/jacen/.local/bin/hermes", fixtureDirectory);
    } catch (error) {
      preparationError = error;
    }
    try {
      const manifestAfter = await fingerprintHermesState(manifestRoots);
      const previous = new Map(manifestBefore.map((entry) => [entry.path, JSON.stringify(entry)]));
      const current = new Map(manifestAfter.map((entry) => [entry.path, JSON.stringify(entry)]));
      const changed = [...new Set([...previous.keys(), ...current.keys()])]
        .filter((path) => previous.get(path) !== current.get(path));
      const launcherBytesAfter = persistentLaunchers.map((path) => readFileSync(path));
      process.stderr.write(`Hermes preparation-only persistent changes: ${JSON.stringify(changed)}\n`);
      expect(launcherBytesAfter.map((bytes) => createHash("sha256").update(bytes).digest("hex")))
        .toEqual(launcherBytesBefore.map((bytes) => createHash("sha256").update(bytes).digest("hex")));
      expect(changed, `persistent Hermes paths changed: ${changed.join(", ")}`).toEqual([]);
      expect(state("ActiveState")).toBe("inactive");
      expect(state("MainPID")).toBe("0");
      expect(state("NRestarts")).toBe(restartCountBefore);
      if (preparationError) throw preparationError;
      expect(fixture).toBeDefined();
      const fixturePaths = [
        fixture!.fixtureRoot,
        fixture!.fixtureHome,
        fixture!.fixtureRuntime,
        fixture!.fixtureState,
        fixture!.fixtureEnvironment,
        fixture!.fixturePython,
        fixture!.fixtureLauncher,
        fixture!.fixtureAcPLauncher
      ];
      for (const path of fixturePaths) assertHermesPathContained(fixtureDirectory, path);
      process.stderr.write(`Hermes preparation-only fixture paths: ${JSON.stringify(fixturePaths)}\n`);
    } finally {
      rmSync(fixtureDirectory, { recursive: true, force: true });
      roots.splice(roots.indexOf(fixtureDirectory), 1);
    }
  }, 300_000);
});
