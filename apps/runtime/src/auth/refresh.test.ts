import { spawn } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CorruptCredentialsError, readCredentials, writeCredentials } from "./credential-store.js";
import { refreshSession, RefreshSessionError, withCredentialLock } from "./refresh.js";

describe("refreshSession", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function makeCredsFile(expiresOffsetMs: number) {
    dir = mkdtempSync(join(tmpdir(), "acs-refresh-"));
    const file = join(dir, "credentials.json");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    writeCredentials(file, {
      v: 1,
      acsUrl: "https://acs.example.com",
      clientId: "acs-cli",
      deviceName: "workstation",
      devicePrivateKeyPem: privatePem,
      devicePublicKeyPem: publicPem,
      session: {
        deviceId: "dev_1",
        principal: "operator-1",
        accessToken: "at_old_secret",
        accessTokenExpiresAt: new Date(1_700_000_000_000 + expiresOffsetMs).toISOString(),
        refreshToken: "rt_old_secret",
        scopes: ["acs:device"]
      }
    });
    return { file, privatePem, publicPem };
  }

  it("returns existing session without calling gateway when outside refresh threshold", async () => {
    const { file } = makeCredsFile(300_000);
    const fetchImpl = vi.fn();
    const result = await refreshSession({
      credentialsPathOverride: file,
      now: () => 1_700_000_000_000,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result.refreshed).toBe(false);
    expect(result.session.accessToken).toBe("at_old_secret");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("signs Ed25519 refresh proof per wire contract and atomically persists rotated session", async () => {
    const { file, publicPem, privatePem } = makeCredsFile(10_000);
    const nowMs = 1_700_000_000_500;
    const expectedIssuedAt = Math.floor(nowMs / 1000);
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://acs.example.com/oauth/token");
      const params = new URLSearchParams(String(init?.body));
      expect(params.get("grant_type")).toBe("refresh_token");
      expect(params.get("client_id")).toBe("acs-cli");
      expect(params.get("refresh_token")).toBe("rt_old_secret");
      expect(params.get("device_id")).toBe("dev_1");
      expect(params.get("proof_issued_at")).toBe(String(expectedIssuedAt));

      const proof = params.get("refresh_proof");
      expect(proof).toBeTruthy();
      const rtSha256 = createHash("sha256").update("rt_old_secret", "utf8").digest("hex");
      const canonicalMessage = [
        "acs-device-refresh-proof-v1",
        "client_id=acs-cli",
        "device_id=dev_1",
        `refresh_token_sha256=${rtSha256}`,
        "operation=refresh_token",
        `issued_at=${expectedIssuedAt}`
      ].join("\n");
      const ok = verify(
        null,
        Buffer.from(canonicalMessage, "utf8"),
        createPublicKey(publicPem),
        Buffer.from(proof!, "base64url")
      );
      expect(ok).toBe(true);

      return new Response(
        JSON.stringify({
          access_token: "at_new",
          token_type: "Bearer",
          expires_in: 900,
          refresh_token: "rt_new",
          scope: "acs:device",
          device_id: "dev_1",
          principal: "operator-1"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const result = await refreshSession({
      credentialsPathOverride: file,
      now: () => nowMs,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(result.refreshed).toBe(true);
    expect(result.session.accessToken).toBe("at_new");
    expect(result.session.refreshToken).toBe("rt_new");
    expect(result.session.deviceId).toBe("dev_1");

    const stored = readCredentials(file);
    expect(stored?.session?.accessToken).toBe("at_new");
    expect(stored?.session?.refreshToken).toBe("rt_new");
    expect(stored?.devicePrivateKeyPem).toBe(privatePem);
    expect(stored?.devicePublicKeyPem).toBe(publicPem);
  });

  it("does not overwrite stored credentials if fetchImpl throws before persistence", async () => {
    const { file } = makeCredsFile(-1000);
    const fetchImpl = vi.fn(async () => {
      throw new Error("simulated failure before persist");
    });

    await expect(
      refreshSession({
        credentialsPathOverride: file,
        now: () => 1_700_000_000_000,
        fetchImpl: fetchImpl as unknown as typeof fetch
      })
    ).rejects.toMatchObject({
      name: "RefreshSessionError",
      reason: "transient_error",
      requiresLogin: false
    });

    const stored = readCredentials(file);
    expect(stored?.session?.refreshToken).toBe("rt_old_secret");
    expect(stored?.session?.accessToken).toBe("at_old_secret");
  });

  it("maps device_revoked, refresh_expired, and refresh_replay to requiresLogin=true without leaking secrets", async () => {
    for (const acsReason of ["device_revoked", "refresh_expired", "refresh_replay", "unknown_refresh_token"] as const) {
      const { file, privatePem } = makeCredsFile(-1000);
      const fetchImpl = vi.fn(async () =>
        new Response(JSON.stringify({ error: "invalid_grant", acs_reason: acsReason }), { status: 400 })
      );

      let caught: unknown;
      try {
        await refreshSession({
          credentialsPathOverride: file,
          now: () => 1_700_000_000_000,
          fetchImpl: fetchImpl as unknown as typeof fetch
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(RefreshSessionError);
      const err = caught as RefreshSessionError;
      expect(err.reason).toBe(acsReason);
      expect(err.requiresLogin).toBe(true);
      expect(err.message).toContain("acs auth login");
      expect(err.message).not.toContain("rt_old_secret");
      expect(err.message).not.toContain("at_old_secret");
      expect(err.message).not.toContain("PRIVATE KEY");
      expect(readCredentials(file)?.devicePrivateKeyPem).toBe(privatePem);
      rmSync(dir!, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("maps missing_proof, invalid_proof, and recovery_unavailable to requiresLogin=false and preserves session", async () => {
    for (const [status, error, acsReason] of [
      [400, "invalid_request", "missing_proof"],
      [400, "invalid_grant", "invalid_proof"],
      [503, "server_error", "recovery_unavailable"]
    ] as const) {
      const { file } = makeCredsFile(-1000);
      const fetchImpl = vi.fn(async () =>
        new Response(JSON.stringify({ error, acs_reason: acsReason }), { status })
      );

      let caught: unknown;
      try {
        await refreshSession({
          credentialsPathOverride: file,
          now: () => 1_700_000_000_000,
          fetchImpl: fetchImpl as unknown as typeof fetch
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(RefreshSessionError);
      const err = caught as RefreshSessionError;
      expect(err.reason).toBe(acsReason);
      expect(err.requiresLogin).toBe(false);
      expect(readCredentials(file)?.session?.refreshToken).toBe("rt_old_secret");
      rmSync(dir!, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("propagates CorruptCredentialsError without overwriting", async () => {
    dir = mkdtempSync(join(tmpdir(), "acs-refresh-corrupt-"));
    const file = join(dir, "credentials.json");
    writeFileSync(file, "{corrupt", { mode: 0o600 });
    await expect(refreshSession({ credentialsPathOverride: file })).rejects.toThrow(CorruptCredentialsError);
  });

  it("throws RefreshSessionError(not_authenticated) when no session exists", async () => {
    dir = mkdtempSync(join(tmpdir(), "acs-refresh-nosess-"));
    const file = join(dir, "credentials.json");
    await expect(refreshSession({ credentialsPathOverride: file })).rejects.toMatchObject({
      reason: "not_authenticated",
      requiresLogin: true
    });
  });

  it("ignores ACS_CLI_TEST_KILL_BEFORE_PERSIST and ACS_TEST_KILL_BEFORE_PERSIST in refreshSession", async () => {
    const { file } = makeCredsFile(-1000);
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "at_new",
          expires_in: 900,
          refresh_token: "rt_new",
          scope: "acs:device",
          device_id: "dev_1",
          principal: "operator-1"
        }),
        { status: 200 }
      )
    );

    const res = await refreshSession({
      credentialsPathOverride: file,
      env: {
        NODE_ENV: "test",
        ACS_CLI_TEST_KILL_BEFORE_PERSIST: "1",
        ACS_TEST_KILL_BEFORE_PERSIST: "1"
      },
      now: () => 1_700_000_000_000,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(res.refreshed).toBe(true);
    expect(readCredentials(file)?.session?.refreshToken).toBe("rt_new");
  });

  it("reclaims a stale lockfile left by a dead PID without waiting for timeout", async () => {
    const { file } = makeCredsFile(-1000);
    writeFileSync(`${file}.lock`, "999999", { mode: 0o600 });
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "at_new",
          expires_in: 900,
          refresh_token: "rt_new",
          scope: "acs:device",
          device_id: "dev_1",
          principal: "operator-1"
        }),
        { status: 200 }
      )
    );
    const start = Date.now();
    const res = await refreshSession({
      credentialsPathOverride: file,
      now: () => 1_700_000_000_000,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(res.refreshed).toBe(true);
    expect(res.session.refreshToken).toBe("rt_new");
  });

  it("times out with transient_error and never executes callback or issues refresh request when lock is held", async () => {
    const { file } = makeCredsFile(-1000);
    writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, token: "other-holder", acquiredAtMs: Date.now() }), {
      mode: 0o600
    });

    const callback = vi.fn(async () => "should-not-run");
    await expect(
      withCredentialLock(file, callback, { timeoutMs: 60, pollMs: 10 })
    ).rejects.toMatchObject({
      name: "RefreshSessionError",
      reason: "transient_error",
      requiresLogin: false
    });
    expect(callback).not.toHaveBeenCalled();

    const fetchImpl = vi.fn();
    await expect(
      refreshSession({
        credentialsPathOverride: file,
        now: () => 1_700_000_000_000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lockTimeoutMs: 60,
        lockPollMs: 10
      })
    ).rejects.toMatchObject({
      name: "RefreshSessionError",
      reason: "transient_error",
      requiresLogin: false
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never reclaims a lockfile whose mtime exceeds 15s when its owning process is alive", async () => {
    const { file } = makeCredsFile(-1000);
    const lockPath = `${file}.lock`;
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      expect(child.pid).toBeTypeOf("number");
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: child.pid, token: "live-child", acquiredAtMs: Date.now() - 120_000 }),
        { mode: 0o600 }
      );
      const oldDate = new Date(Date.now() - 120_000);
      utimesSync(lockPath, oldDate, oldDate);

      const fetchImpl = vi.fn();
      await expect(
        refreshSession({
          credentialsPathOverride: file,
          now: () => 1_700_000_000_000,
          fetchImpl: fetchImpl as unknown as typeof fetch,
          lockTimeoutMs: 80,
          lockPollMs: 10
        })
      ).rejects.toMatchObject({
        reason: "transient_error",
        requiresLogin: false
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("reclaims the lock promptly after an owning process terminates via SIGKILL", async () => {
    const { file } = makeCredsFile(-1000);
    const lockPath = `${file}.lock`;
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      expect(child.pid).toBeTypeOf("number");
      writeFileSync(lockPath, JSON.stringify({ pid: child.pid, token: "doomed-child", acquiredAtMs: Date.now() }), {
        mode: 0o600
      });

      const waitPromise = withCredentialLock(
        file,
        async () => "acquired-after-sigkill",
        { timeoutMs: 2_000, pollMs: 10 }
      );

      // Give the waiter a couple poll cycles under live contention, then kill the owner.
      await new Promise((resolve) => setTimeout(resolve, 40));
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));

      await expect(waitPromise).resolves.toBe("acquired-after-sigkill");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });

  it("serializes concurrent stale-lock reclamation races without clobbering the winner's lock", async () => {
    const { file } = makeCredsFile(-1000);
    const lockPath = `${file}.lock`;
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, token: "dead-owner", acquiredAtMs: Date.now() - 60_000 }), {
      mode: 0o600
    });

    let activeCount = 0;
    let maxConcurrent = 0;
    const order: number[] = [];

    const runContender = (id: number) =>
      withCredentialLock(
        file,
        async () => {
          activeCount += 1;
          maxConcurrent = Math.max(maxConcurrent, activeCount);
          order.push(id);
          await new Promise((resolve) => setTimeout(resolve, 50));
          activeCount -= 1;
          return id;
        },
        { timeoutMs: 2_000, pollMs: 5 }
      );

    const results = await Promise.all([runContender(1), runContender(2), runContender(3)]);
    expect(results).toEqual([1, 2, 3]);
    expect(maxConcurrent).toBe(1);
    expect(order).toHaveLength(3);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(`${lockPath}.reclaim`)).toBe(false);
  });

  it("only releases a lock it demonstrably owns", async () => {
    const { file } = makeCredsFile(-1000);
    const lockPath = `${file}.lock`;
    const foreignContent = JSON.stringify({ pid: process.pid, token: "foreign-owner", acquiredAtMs: Date.now() });

    await withCredentialLock(
      file,
      async () => {
        // Simulate external replacement of the lockfile with a different inode/token.
        rmSync(lockPath, { force: true });
        writeFileSync(lockPath, foreignContent, { mode: 0o600 });
      },
      { timeoutMs: 500, pollMs: 10 }
    );

    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe(foreignContent);
  });

  it("handles partial-write lockfiles safely within grace period and reclaims expired ones", async () => {
    const { file } = makeCredsFile(-1000);
    const lockPath = `${file}.lock`;

    // Fresh partial/corrupt lockfile must not be reclaimed before grace period expires.
    writeFileSync(lockPath, '{"pid":123', { mode: 0o600 });
    const blockedCb = vi.fn(async () => "should-not-run");
    await expect(
      withCredentialLock(file, blockedCb, { timeoutMs: 60, pollMs: 10 })
    ).rejects.toMatchObject({
      reason: "transient_error",
      requiresLogin: false
    });
    expect(blockedCb).not.toHaveBeenCalled();
    expect(existsSync(lockPath)).toBe(true);

    // Once past LOCK_CORRUPT_GRACE_MS (2000ms), partial lockfile is reclaimed cleanly.
    const expiredDate = new Date(Date.now() - 5_000);
    utimesSync(lockPath, expiredDate, expiredDate);
    await expect(
      withCredentialLock(file, async () => "reclaimed-partial", { timeoutMs: 500, pollMs: 10 })
    ).resolves.toBe("reclaimed-partial");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("recovers from a stale .reclaim lockfile under concurrent contention without leaving temp or guard files", async () => {
    const { file } = makeCredsFile(-1000);
    const lockPath = `${file}.lock`;
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, token: "dead-owner", acquiredAtMs: Date.now() - 60_000 }), {
      mode: 0o600
    });
    writeFileSync(
      `${lockPath}.reclaim`,
      JSON.stringify({ pid: 999998, token: "dead-reclaimer", acquiredAtMs: Date.now() - 60_000 }),
      { mode: 0o600 }
    );

    let activeCount = 0;
    let maxConcurrent = 0;
    const runContender = (id: number) =>
      withCredentialLock(
        file,
        async () => {
          activeCount += 1;
          maxConcurrent = Math.max(maxConcurrent, activeCount);
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
          activeCount -= 1;
          return id;
        },
        { timeoutMs: 2_000, pollMs: 5 }
      );

    const results = await Promise.all([runContender(1), runContender(2), runContender(3)]);
    expect(results).toEqual([1, 2, 3]);
    expect(maxConcurrent).toBe(1);
    expect(readdirSync(dir!)).toEqual(["credentials.json"]);
  });

  it("does not prematurely reclaim a SIGSTOP-suspended owner lock and completes after SIGCONT", async () => {
    const { file } = makeCredsFile(-1000);
    const lockPath = `${file}.lock`;
    const refreshModulePath = resolve(import.meta.dirname, "refresh.ts");
    const childScript = `
      import { withCredentialLock } from ${JSON.stringify(refreshModulePath)};
      const file = process.argv[1];
      await withCredentialLock(file, async () => {
        await new Promise((resolveCont) => {
          process.once("SIGCONT", () => resolveCont());
          process.stdout.write("LOCKED\\n");
        });
      }, { timeoutMs: 5000, pollMs: 10 });
      process.stdout.write("DONE\\n");
    `;

    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript, file], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    try {
      await new Promise<void>((resolveLocked, rejectLocked) => {
        let stdout = "";
        const timer = setTimeout(() => rejectLocked(new Error(`child timed out locking. stderr: ${stderr}`)), 10_000);
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          if (stdout.includes("LOCKED\n")) {
            clearTimeout(timer);
            resolveLocked();
          }
        });
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          rejectLocked(new Error(`child exited prematurely (${code ?? signal}): ${stderr}`));
        });
      });

      // Suspend the lock owner; it remains alive so its lock must not be reclaimed.
      child.kill("SIGSTOP");

      const blockedCb = vi.fn(async () => "should-not-run");
      await expect(
        withCredentialLock(file, blockedCb, { timeoutMs: 80, pollMs: 10 })
      ).rejects.toMatchObject({
        reason: "transient_error",
        requiresLogin: false
      });
      expect(blockedCb).not.toHaveBeenCalled();
      expect(existsSync(lockPath)).toBe(true);

      const waiterPromise = withCredentialLock(
        file,
        async () => "acquired-after-sigcont",
        { timeoutMs: 5_000, pollMs: 10 }
      );

      // Give the waiter a couple poll cycles under suspended-owner contention, then resume.
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
      child.kill("SIGCONT");

      const [childExit] = await Promise.all([
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
          child.once("exit", (code, signal) => resolveExit({ code, signal }));
        }),
        expect(waiterPromise).resolves.toBe("acquired-after-sigcont")
      ]);

      expect(childExit).toEqual({ code: 0, signal: null });
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });
});
