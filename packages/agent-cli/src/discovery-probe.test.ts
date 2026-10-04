import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeExecutableVersion } from "./discovery-probe.js";

function script(body: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "acs-probe-"));
  const path = join(dir, "tool.sh");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return { dir, path };
}

describe("probeExecutableVersion", () => {
  it("reports ok for a zero exit", async () => {
    const { dir, path } = script("echo 1.2.3");
    try {
      expect(await probeExecutableVersion(path, ["--version"])).toEqual({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a non-zero exit with sanitized, bounded output", async () => {
    const { dir, path } = script("printf 'boom\\n\\tline2\\n' >&2; exit 3");
    try {
      const result = await probeExecutableVersion(path, ["--version"]);
      expect(result.ok).toBe(false);
      expect(result.timedOut).toBeUndefined();
      expect(result.error).toContain("exited with 3");
      expect(result.error).not.toMatch(/[\n\t]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kills a hung probe and reports a timeout", async () => {
    const { dir, path } = script("sleep 30");
    try {
      const started = Date.now();
      const result = await probeExecutableVersion(path, ["--version"], 200);
      expect(result).toMatchObject({ ok: false, timedOut: true });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a missing executable instead of throwing", async () => {
    const result = await probeExecutableVersion("/nonexistent/acs-probe-target", ["--version"]);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("does not forward provider credentials or ACS secrets", async () => {
    const { dir, path } = script('[ -z "$ACS_PROBE_SECRET" ] && [ -z "$OPENAI_API_KEY" ] || exit 9');
    process.env.ACS_PROBE_SECRET = "s3cret-value";
    process.env.OPENAI_API_KEY = "sk-test";
    try {
      expect(await probeExecutableVersion(path, [])).toEqual({ ok: true });
    } finally {
      delete process.env.ACS_PROBE_SECRET;
      delete process.env.OPENAI_API_KEY;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
