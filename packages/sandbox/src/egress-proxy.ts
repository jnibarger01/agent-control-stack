import { createServer, connect, type Socket } from "node:net";
import { existsSync, rmSync } from "node:fs";
import { ControlStackError } from "@agent-control-stack/shared";
import type { EngineEgressAllowlist } from "./engine-contracts.js";

const MAX_HEADER_BYTES = 8 * 1_024;
const CONNECT_LINE = /^CONNECT\s+([^\s]+)\s+HTTP\/1\.\d\r?$/u;
const HOST_PORT = /^([a-zA-Z0-9.-]+):(\d{1,5})$/u;

export interface EgressDecision {
  host: string;
  port: number;
  allowed: boolean;
  at: string;
}

export interface EgressProxyOptions {
  socketPath: string;
  allowlist: EngineEgressAllowlist;
  connectTimeoutMs?: number;
  headerTimeoutMs?: number;
  onDecision?: (decision: EgressDecision) => void;
  now?: () => Date;
}

export interface EgressProxyHandle {
  readonly socketPath: string;
  close(): Promise<void>;
}

/**
 * A minimal HTTP CONNECT proxy bound to a single-purpose AF_UNIX socket.
 * AF_UNIX sockets are filesystem objects, not network devices, so bind-
 * mounting this socket's path into a --unshare-net Bubblewrap sandbox
 * (see engine.ts / ADR 0014) gives the sandboxed process exactly one route
 * to the outside world: this allowlist chokepoint. There is no other path
 * out of the sandbox's network namespace, so there is nothing to bypass.
 */
export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxyHandle> {
  const allowlist = options.allowlist;
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  const headerTimeoutMs = options.headerTimeoutMs ?? 5_000;
  const now = options.now ?? (() => new Date());
  const activeSockets = new Set<Socket>();

  if (existsSync(options.socketPath)) {
    rmSync(options.socketPath, { force: true });
  }

  const server = createServer({ pauseOnConnect: true }, (client) => {
    activeSockets.add(client);
    client.once("close", () => activeSockets.delete(client));
    void handleConnection(client, {
      allowlist,
      connectTimeoutMs,
      headerTimeoutMs,
      now,
      onDecision: options.onDecision,
      trackOutbound: (outbound) => {
        activeSockets.add(outbound);
        outbound.once("close", () => activeSockets.delete(outbound));
      }
    });
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", (error) => {
      reject(new ControlStackError("engine_egress_proxy_listen_failed", error.message));
    });
    server.listen(options.socketPath, () => resolvePromise());
  });

  return {
    socketPath: options.socketPath,
    async close(): Promise<void> {
      for (const socket of activeSockets) {
        socket.destroy();
      }
      activeSockets.clear();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      rmSync(options.socketPath, { force: true });
    }
  };
}

interface ConnectionContext {
  allowlist: EngineEgressAllowlist;
  connectTimeoutMs: number;
  headerTimeoutMs: number;
  now: () => Date;
  onDecision?: (decision: EgressDecision) => void;
  trackOutbound: (outbound: Socket) => void;
}

async function handleConnection(client: Socket, context: ConnectionContext): Promise<void> {
  let headerBuffer = Buffer.alloc(0);
  const headerTimer = setTimeout(() => client.destroy(), context.headerTimeoutMs);

  const onData = (chunk: Buffer): void => {
    headerBuffer = Buffer.concat([headerBuffer, chunk]);
    if (headerBuffer.length > MAX_HEADER_BYTES) {
      clearTimeout(headerTimer);
      client.destroy();
      return;
    }
    const terminatorIndex = headerBuffer.indexOf("\r\n\r\n");
    if (terminatorIndex === -1) return;

    clearTimeout(headerTimer);
    client.removeListener("data", onData);
    const headerText = headerBuffer.subarray(0, terminatorIndex).toString("latin1");
    const leftover = headerBuffer.subarray(terminatorIndex + 4);
    void processRequest(client, headerText, leftover, context);
  };

  client.on("data", onData);
  client.on("error", () => {
    clearTimeout(headerTimer);
  });
  client.resume();
}

async function processRequest(
  client: Socket,
  headerText: string,
  leftover: Buffer,
  context: ConnectionContext
): Promise<void> {
  const requestLine = headerText.split("\r\n")[0] ?? "";
  const match = CONNECT_LINE.exec(requestLine);
  if (!match) {
    client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  const target = HOST_PORT.exec(match[1] ?? "");
  if (!target) {
    client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  const host = (target[1] ?? "").toLowerCase();
  const port = Number(target[2]);
  const allowed = context.allowlist.some(
    (entry) => entry.host.toLowerCase() === host && entry.port === port
  );
  context.onDecision?.({ host, port, allowed, at: context.now().toISOString() });

  if (!allowed) {
    client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }

  const outbound = connect({ host, port, timeout: context.connectTimeoutMs });
  context.trackOutbound(outbound);
  outbound.once("connect", () => {
    outbound.setTimeout(0);
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n", () => {
      if (leftover.length) outbound.write(leftover);
      client.pipe(outbound);
      outbound.pipe(client);
    });
  });
  outbound.once("timeout", () => {
    outbound.destroy();
  });
  outbound.once("error", () => {
    if (!client.destroyed && !client.writableEnded) {
      client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    }
  });
  client.once("error", () => {
    outbound.destroy();
  });
}

export { HOST_PORT as engineEgressHostPortPattern };
