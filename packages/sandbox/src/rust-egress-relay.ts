import { spawn } from "node:child_process";
import { accessSync, constants, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ControlStackError } from "@agent-control-stack/shared";
import type { EgressProxyHandle, EgressProxyOptions } from "./egress-proxy.js";
import { defaultRustSupervisorPath, type ScopeSupervisorSelection } from "./rust-supervisor.js";

/**
 * Client for `acs-egress-relay` (protocol v1), the Rust port of
 * `startEgressProxy`. It returns the same handle. The relay reports each
 * CONNECT decision; ACS stamps the decision time and keeps the accounting.
 * Closing stdin, or losing this process, shuts the relay and every relayed
 * connection down.
 */

const MAX_LINE_BYTES = 1_024;
const READY_TIMEOUT_MS = 5_000;
const CLOSE_TIMEOUT_MS = 2_000;

const frameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }).strict(),
  z.object({ type: z.literal("closed") }).strict(),
  z
    .object({
      type: z.literal("rejected"),
      code: z
        .string()
        .regex(/^[a-z_]+$/u)
        .max(64)
    })
    .strict(),
  z
    .object({
      type: z.literal("decision"),
      host: z
        .string()
        .regex(/^[a-z0-9.-]+$/u)
        .max(253),
      port: z.number().int().min(0).max(99_999),
      allowed: z.boolean()
    })
    .strict()
]);

export function rustEgressRelayPath(selection: ScopeSupervisorSelection): string {
  return join(dirname(selection.binaryPath ?? defaultRustSupervisorPath), "acs-egress-relay");
}

export function requireRustEgressRelay(selection: ScopeSupervisorSelection): string {
  const path = rustEgressRelayPath(selection);
  try {
    accessSync(path, constants.X_OK);
  } catch {
    throw new ControlStackError(
      "engine_isolation_egress_bridge_missing",
      "selected Rust egress relay is not executable"
    );
  }
  return path;
}

export async function startRustEgressRelay(
  binaryPath: string,
  options: EgressProxyOptions,
  launcherEnvironment: NodeJS.ProcessEnv
): Promise<EgressProxyHandle> {
  const now = options.now ?? (() => new Date());
  const child = spawn(binaryPath, [], { env: launcherEnvironment, shell: false, stdio: ["pipe", "pipe", "ignore"] });
  const stdin = child.stdin!;
  stdin.on("error", () => {});

  let pending = "";
  let failed: string | undefined;
  let readyResolve: (() => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;
  let closedResolve: (() => void) | undefined;
  const exited = new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise()));

  const fail = (reason: string) => {
    failed ??= reason;
    readyReject?.(new ControlStackError("engine_egress_proxy_listen_failed", reason));
    readyReject = undefined;
    readyResolve = undefined;
  };

  const onLine = (line: string) => {
    let parsed: z.infer<typeof frameSchema>;
    try {
      parsed = frameSchema.parse(JSON.parse(line));
    } catch {
      fail("egress relay sent an invalid frame");
      child.kill("SIGKILL");
      return;
    }
    switch (parsed.type) {
      case "ready":
        readyResolve?.();
        readyResolve = undefined;
        readyReject = undefined;
        return;
      case "rejected":
        fail(`egress relay rejected its start: ${parsed.code}`);
        return;
      case "decision":
        options.onDecision?.({
          host: parsed.host,
          port: parsed.port,
          allowed: parsed.allowed,
          at: now().toISOString()
        });
        return;
      case "closed":
        closedResolve?.();
        return;
    }
  };

  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    pending += chunk;
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      onLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
    if (Buffer.byteLength(pending, "utf8") > MAX_LINE_BYTES) {
      fail("egress relay frame exceeded its bound");
      child.kill("SIGKILL");
    }
  });
  child.once("error", (error) => fail(`egress relay failed: ${error.message}`));
  void exited.then(() => fail("egress relay exited"));

  const ready = new Promise<void>((resolvePromise, reject) => {
    readyResolve = resolvePromise;
    readyReject = reject;
  });
  stdin.write(
    `${JSON.stringify({
      version: 1,
      socketPath: options.socketPath,
      allowlist: options.allowlist.map((entry) => ({ host: entry.host, port: entry.port })),
      connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
      headerTimeoutMs: options.headerTimeoutMs ?? 5_000
    })}\n`
  );

  const timer = setTimeout(() => fail("egress relay did not become ready"), READY_TIMEOUT_MS);
  try {
    await ready;
  } catch (error) {
    child.kill("SIGKILL");
    await exited;
    rmSync(options.socketPath, { force: true });
    throw error;
  } finally {
    clearTimeout(timer);
  }

  return {
    socketPath: options.socketPath,
    async close(): Promise<void> {
      const closed = new Promise<void>((resolvePromise) => {
        closedResolve = resolvePromise;
      });
      stdin.end();
      const killTimer = setTimeout(() => child.kill("SIGKILL"), CLOSE_TIMEOUT_MS);
      await Promise.race([closed.then(() => exited), exited]);
      clearTimeout(killTimer);
      rmSync(options.socketPath, { force: true });
    }
  };
}
