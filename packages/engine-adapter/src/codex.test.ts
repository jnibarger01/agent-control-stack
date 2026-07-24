import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexEngineAdapter, buildCodexArgs } from "./codex.js";

describe("buildCodexArgs", () => {
  it("builds a non-interactive exec invocation with the requested sandbox mode", () => {
    const args = buildCodexArgs("do the thing", "workspace-write");
    expect(args).toEqual(["exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "do the thing"]);
  });

  it("never silently escalates to read-only when workspace-write was requested", () => {
    const args = buildCodexArgs("do the thing", "read-only");
    expect(args).toContain("read-only");
    expect(args).not.toContain("workspace-write");
  });
});

describe("CodexEngineAdapter", () => {
  let scriptDir: string | undefined;

  afterEach(() => {
    if (scriptDir) rmSync(scriptDir, { recursive: true, force: true });
    scriptDir = undefined;
  });

  function writeFixtureBinary(script: string): string {
    scriptDir = mkdtempSync(join(tmpdir(), "codex-adapter-test-"));
    const scriptPath = join(scriptDir, "fake-codex.sh");
    writeFileSync(scriptPath, script, "utf8");
    chmodSync(scriptPath, 0o755);
    return scriptPath;
  }

  it("runs the child in the provisioned workspace and reports a completed outcome", async () => {
    const binary = writeFixtureBinary(["#!/bin/sh", 'echo "cwd=$(pwd)"', "exit 0"].join("\n"));
    const workspace = scriptDir as string;
    const adapter = new CodexEngineAdapter({ binary });

    const outcome = await adapter.invoke({
      workItemId: "wrk_test",
      prompt: "do something",
      workspaceHostPath: workspace,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096
    });

    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toContain(`cwd=${workspace}`);
    }
  });

  it("never exposes a planted secret env var to the spawned engine process", async () => {
    const binary = writeFixtureBinary(["#!/bin/sh", "env", "exit 0"].join("\n"));
    const workspace = scriptDir as string;
    const originalEnv = process.env;
    process.env = { ...originalEnv, TOTALLY_FAKE_SECRET: "should-never-reach-child" } as NodeJS.ProcessEnv;
    try {
      const adapter = new CodexEngineAdapter({ binary });
      const outcome = await adapter.invoke({
        workItemId: "wrk_test",
        prompt: "do something",
        workspaceHostPath: workspace,
        timeoutMs: 5_000,
        maxOutputBytes: 4_096
      });
      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.stdout).not.toContain("TOTALLY_FAKE_SECRET");
      }
    } finally {
      process.env = originalEnv;
    }
  });

  it("kills the child and reports timeout when the wall-clock budget is exceeded", async () => {
    const binary = writeFixtureBinary(["#!/usr/bin/env node", "setTimeout(() => {}, 5000);"].join("\n"));
    const workspace = scriptDir as string;
    const adapter = new CodexEngineAdapter({ binary });

    const outcome = await adapter.invoke({
      workItemId: "wrk_test",
      prompt: "do something",
      workspaceHostPath: workspace,
      timeoutMs: 200,
      maxOutputBytes: 4_096
    });

    expect(outcome.status).toBe("timeout");
  });

  it("truncates output past maxOutputBytes rather than buffering unbounded", async () => {
    const binary = writeFixtureBinary(["#!/bin/sh", "yes x | head -c 100000", "exit 0"].join("\n"));
    const workspace = scriptDir as string;
    const adapter = new CodexEngineAdapter({ binary });

    const outcome = await adapter.invoke({
      workItemId: "wrk_test",
      prompt: "do something",
      workspaceHostPath: workspace,
      timeoutMs: 5_000,
      maxOutputBytes: 1_024
    });

    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      expect(outcome.stdoutTruncated).toBe(true);
      expect(Buffer.byteLength(outcome.stdout, "utf8")).toBeLessThanOrEqual(1_024);
    }
  });

  it("respects external cancellation via AbortSignal", async () => {
    const binary = writeFixtureBinary(["#!/usr/bin/env node", "setTimeout(() => {}, 5000);"].join("\n"));
    const workspace = scriptDir as string;
    const adapter = new CodexEngineAdapter({ binary });
    const controller = new AbortController();

    const invocation = adapter.invoke(
      {
        workItemId: "wrk_test",
        prompt: "do something",
        workspaceHostPath: workspace,
        timeoutMs: 5_000,
        maxOutputBytes: 4_096
      },
      controller.signal
    );
    setTimeout(() => controller.abort(), 100);

    const outcome = await invocation;
    expect(outcome.status).toBe("cancelled");
  });
});
