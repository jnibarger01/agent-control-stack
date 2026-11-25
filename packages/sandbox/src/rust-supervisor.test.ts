import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultRustSupervisorPath,
  maxObservationFrameBytes,
  parseFrame,
  requireRustSupervisor,
  scopeSupervisorFromEnvironment,
  superviseWithRust,
  type SuperviseOptions
} from "./rust-supervisor.js";

const unitName = "acs-sandbox-attempt-1-abcd1234.scope";
const sessionId = "ss-0123456789abcdef0123";
const binding = {
  workItemId: "wi-1",
  attemptId: "attempt-1",
  leaseId: "lease-1",
  workerId: "worker-1",
  fencingToken: 7
};
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "acs-rust-supervisor-"));
  dirs.push(dir);
  return dir;
}

function script(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function observation(overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    type: "observation",
    sessionId,
    ...binding,
    unitName,
    trigger: null,
    signalFailed: false,
    terminationError: null,
    launchError: null,
    exitCode: 0,
    signal: null,
    cleanup: "verified",
    stdout: Buffer.from("ok\n").toString("base64"),
    stderr: "",
    stdoutBytes: 3,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    protocolViolation: null,
    parentLost: false,
    abandoned: false,
    durationMs: 5,
    ...overrides
  };
}

/** A fake helper that drains stdin and prints one canned frame. */
function cannedHelper(frame: unknown, exitCode = 0): string {
  const dir = tempDir();
  const framePath = join(dir, "frame.json");
  writeFileSync(framePath, typeof frame === "string" ? frame : `${JSON.stringify(frame)}\n`);
  return script(dir, "helper", `head -n 1 >/dev/null\ncat '${framePath}'\nexit ${exitCode}`);
}

function options(binaryPath: string, extra: Partial<SuperviseOptions> = {}): SuperviseOptions {
  return {
    binaryPath,
    binding,
    invocation: { command: "/usr/bin/systemd-run", args: ["--user", "--scope", `--unit=${unitName}`], unitName },
    systemctlPath: "/usr/bin/systemctl",
    limits: { wallClockMs: 5_000, terminationGraceMs: 50, outputBytes: 4_096 },
    launcherEnvironment: { PATH: "/usr/bin:/bin" },
    forceStopScope: vi.fn(async () => {}),
    sessionId,
    ...extra
  };
}

describe("Rust scope supervisor client", () => {
  it("accepts an observation bound to this session, attempt, lease and fence", async () => {
    const run = await superviseWithRust(options(cannedHelper(observation())));
    expect(run).toMatchObject({ exitCode: 0, signal: null, cleanup: "verified" });
    expect(Buffer.concat(run.output.stdout).toString()).toBe("ok\n");
  });

  it.each([
    ["session", { sessionId: "ss-ffffffffffffffffffff" }],
    ["attempt", { attemptId: "attempt-2" }],
    ["lease", { leaseId: "lease-0" }],
    ["worker", { workerId: "worker-9" }],
    ["fence", { fencingToken: 6 }],
    ["scope", { unitName: "acs-sandbox-other-1.scope" }]
  ])("treats a %s binding mismatch as helper loss", async (name, override) => {
    const opts = options(cannedHelper(observation(override)));
    const run = await superviseWithRust(opts);
    expect(run.cleanup).toBe("unknown");
    expect(run.terminationError).toContain(`${name} binding mismatch`);
    expect(opts.forceStopScope).toHaveBeenCalledOnce();
  });

  it.each([
    ["byte counts", { stdoutBytes: 2 }],
    ["non-canonical base64", { stdout: "b2sK=" }],
    ["budget", { stdout: Buffer.alloc(5_000).toString("base64"), stdoutBytes: 5_000 }]
  ])("rejects output that fails %s accounting", async (_name, override) => {
    const run = await superviseWithRust(options(cannedHelper(observation(override))));
    expect(run.cleanup).toBe("unknown");
    expect(run.output.stdoutBytes).toBe(0);
  });

  it.each([
    ["a protocol violation", { protocolViolation: "control_fence_stale", trigger: "cancelled" }, "violation"],
    ["parent loss", { parentLost: true, trigger: "cancelled" }, "lost its control channel"],
    ["an abandoned launcher", { abandoned: true, cleanup: "unknown" }, "did not close"]
  ])("downgrades cleanup to unknown after %s", async (_name, override, message) => {
    const run = await superviseWithRust(options(cannedHelper(observation(override))));
    expect(run.cleanup).toBe("unknown");
    expect(run.terminationError).toContain(message);
  });

  it("treats rejection, malformed frames, extra frames and helper failure as loss", async () => {
    for (const [helper, reason] of [
      [cannedHelper({ version: 2, type: "rejected", code: "scope_binding_invalid" }, 1), "rejected the session"],
      [cannedHelper("not json\n"), "malformed"],
      [cannedHelper(`${JSON.stringify(observation())}\n${JSON.stringify(observation())}\n`), "one observation"],
      [cannedHelper({ ...observation(), extra: 1 }), "failed validation"],
      [cannedHelper(observation(), 3), "exited with code 3"],
      [script(tempDir(), "helper", "exit 1"), "one observation"]
    ] as const) {
      const opts = options(helper);
      const run = await superviseWithRust(opts);
      expect(run.cleanup, reason).toBe("unknown");
      expect(run.terminationError).toContain(reason);
      expect(opts.forceStopScope).toHaveBeenCalledOnce();
    }
  });

  it("kills a helper whose frame exceeds the bound", async () => {
    const dir = tempDir();
    const helper = script(dir, "helper", "head -n 1 >/dev/null\nhead -c 3000000 /dev/zero");
    const run = await superviseWithRust(options(helper));
    expect(run.terminationError).toContain("frame limit");
    expect(run.cleanup).toBe("unknown");
  });

  it("sends one fence-bound cancel frame on abort and stays unknown when the scope cannot be forced", async () => {
    const dir = tempDir();
    const log = join(dir, "stdin.log");
    const helper = script(dir, "helper", `head -n 2 > '${log}'`);
    const controller = new AbortController();
    const opts = options(helper, {
      signal: controller.signal,
      forceStopScope: vi.fn(async () => {
        throw new Error("systemctl unavailable");
      })
    });
    const pending = superviseWithRust(opts);
    controller.abort();
    controller.abort();
    const run = await pending;
    expect(run.cleanup).toBe("unknown");
    const lines = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ version: 2, type: "start", session: { sessionId, ...binding, unitName } });
    expect(lines[1]).toEqual({ version: 2, sessionId, fencingToken: 7, seq: 1, event: { type: "cancel" } });
  });

  it("bounds the observation frame by the output budget", () => {
    expect(maxObservationFrameBytes(1_024 * 1_024)).toBeLessThan(3 * 1_024 * 1_024);
    expect(parseFrame(Buffer.from(""), null, "SIGKILL")).toMatchObject({ ok: false });
  });

  it("selects TypeScript by default and fails closed on an unusable Rust selection", () => {
    expect(scopeSupervisorFromEnvironment({})).toEqual({ backend: "typescript" });
    expect(
      scopeSupervisorFromEnvironment({ ACS_SANDBOX_SUPERVISOR_BACKEND: "rust", ACS_SCOPE_SUPERVISOR_PATH: "/x" })
    ).toEqual({ backend: "rust", binaryPath: "/x" });
    expect(() => scopeSupervisorFromEnvironment({ ACS_SANDBOX_SUPERVISOR_BACKEND: "auto" })).toThrow(
      "must be typescript or rust"
    );
    expect(() => requireRustSupervisor({ backend: "rust", binaryPath: "relative/helper" })).toThrow("absolute");
    expect(() => requireRustSupervisor({ backend: "rust", binaryPath: "/nonexistent/helper" })).toThrow(
      "not executable"
    );
  });

  it("negative, typescript: a broken Rust path is never required or substituted", () => {
    // Selecting TypeScript must not consult the Rust helper, even with a path set.
    const selection = scopeSupervisorFromEnvironment({
      ACS_SANDBOX_SUPERVISOR_BACKEND: "typescript",
      ACS_SCOPE_SUPERVISOR_PATH: "/nonexistent/helper"
    });
    expect(selection.backend).toBe("typescript");
    expect(() => requireRustSupervisor({ ...selection, backend: "rust" })).toThrow("not executable");
  });
});

const realBinary = existsSync(defaultRustSupervisorPath) && process.env.ACS_TEST_SCOPE_SUPERVISOR === "1";

describe.runIf(realBinary)("Rust scope supervisor client with the compiled helper", () => {
  function fakeHost(state: "inactive" | "active") {
    const dir = tempDir();
    const launcher = script(
      dir,
      "fake-run",
      'while [ $# -gt 0 ]; do case "$1" in --*) shift;; *) break;; esac; done\nexec "$@"'
    );
    const systemctl = script(
      dir,
      "fake-systemctl",
      state === "inactive"
        ? 'case "$2" in is-active) echo inactive; exit 3;; kill) exit 0;; esac\nexit 1'
        : 'case "$2" in is-active) echo active; exit 0;; kill) exit 0;; esac\nexit 1'
    );
    return { launcher, systemctl };
  }

  function realOptions(host: ReturnType<typeof fakeHost>, shell: string, extra: Partial<SuperviseOptions> = {}) {
    return options(defaultRustSupervisorPath, {
      invocation: {
        command: host.launcher,
        args: ["--user", "--scope", `--unit=${unitName}`, "/bin/sh", "-c", shell],
        unitName
      },
      systemctlPath: host.systemctl,
      sessionId: undefined,
      ...extra
    });
  }

  it("round-trips a verified exit with a fresh session id", async () => {
    const run = await superviseWithRust(realOptions(fakeHost("inactive"), "printf hi; printf err >&2"));
    expect(run).toMatchObject({ exitCode: 0, cleanup: "verified" });
    expect(Buffer.concat(run.output.stdout).toString()).toBe("hi");
    expect(Buffer.concat(run.output.stderr).toString()).toBe("err");
  });

  it("cancels through the bound control channel", async () => {
    const controller = new AbortController();
    const pending = superviseWithRust(realOptions(fakeHost("inactive"), "sleep 30", { signal: controller.signal }));
    setTimeout(() => controller.abort(), 100);
    const run = await pending;
    expect(run).toMatchObject({ trigger: "cancelled", signal: "SIGTERM", cleanup: "verified" });
  });

  it("cancels immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = await superviseWithRust(realOptions(fakeHost("inactive"), "sleep 30", { signal: controller.signal }));
    expect(run.trigger).toBe("cancelled");
  });

  it("reports a scope that stays active as failed cleanup", async () => {
    const run = await superviseWithRust(realOptions(fakeHost("active"), "true"));
    expect(run.cleanup).toBe("failed");
  });

  it("reports the helper's own start rejection as loss", async () => {
    const host = fakeHost("inactive");
    const opts = realOptions(host, "true", {
      invocation: { command: host.launcher, args: ["--user", "--scope", "--unit=acs-sandbox-x-1.scope"], unitName }
    });
    const run = await superviseWithRust(opts);
    expect(run.terminationError).toContain("scope_binding_invalid");
    expect(run.cleanup).toBe("unknown");
  });
});
