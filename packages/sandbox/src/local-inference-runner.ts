import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request as requestHttp } from "node:http";

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const CODEX_ENTRYPOINT = "/usr/local/bin/codex.js";

const socketPath = process.argv[2];
const model = process.argv[3];
const prompt = process.argv[4];

if (!socketPath || !model || !prompt) {
  throw new Error("local inference runner requires socket path, model, and prompt");
}

const proxy = createServer((request, response) => {
  const method = request.method ?? "";
  const requestUrl = request.url ?? "";
  if (!requestUrl.startsWith("/")) {
    rejectRequest(response, 400, "absolute request URLs are not allowed");
    return;
  }

  let pathname: string;
  try {
    pathname = new URL(requestUrl, "http://127.0.0.1").pathname;
  } catch {
    rejectRequest(response, 400, "invalid request URL");
    return;
  }

  if (!isAllowedRequest(method, pathname)) {
    rejectRequest(response, 403, "local inference endpoint is not allowlisted");
    return;
  }

  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (!Number.isFinite(contentLength) || contentLength > MAX_REQUEST_BYTES) {
    rejectRequest(response, 413, "local inference request is too large");
    return;
  }

  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined && !["connection", "keep-alive", "proxy-connection", "upgrade"].includes(name)) {
      headers[name] = value;
    }
  }
  headers.host = "127.0.0.1:11434";
  headers.connection = "close";

  const upstream = requestHttp(
    {
      socketPath,
      method,
      path: requestUrl,
      headers
    },
    (upstreamResponse) => {
      const responseHeaders = { ...upstreamResponse.headers };
      delete responseHeaders.connection;
      delete responseHeaders["keep-alive"];
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
      upstreamResponse.pipe(response);
    }
  );

  let requestBytes = 0;
  request.on("data", (chunk: Buffer) => {
    requestBytes += chunk.byteLength;
    if (requestBytes > MAX_REQUEST_BYTES) {
      upstream.destroy(new Error("local inference request is too large"));
      request.destroy();
    }
  });
  request.on("aborted", () => upstream.destroy());
  upstream.on("error", () => {
    if (!response.headersSent) {
      rejectRequest(response, 502, "local inference relay failed");
    } else {
      response.destroy();
    }
  });
  request.pipe(upstream);
});

proxy.on("clientError", (_error, socket) => socket.destroy());

await new Promise<void>((resolve, reject) => {
  proxy.once("error", reject);
  proxy.listen({ host: "127.0.0.1", port: 11434 }, () => resolve());
});

let child: ChildProcess | undefined;
const forwardSignal = (signal: NodeJS.Signals) => {
  child?.kill(signal);
};
process.on("SIGTERM", () => forwardSignal("SIGTERM"));
process.on("SIGINT", () => forwardSignal("SIGINT"));

try {
  child = spawn(
    "/usr/bin/node",
    [
      CODEX_ENTRYPOINT,
      "exec",
      "--oss",
      "--local-provider",
      "ollama",
      "--model",
      model,
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--cd",
      "/var/tmp",
      "--json",
      prompt
    ],
    { stdio: "inherit" }
  );

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child?.once("error", reject);
    child?.once("exit", (code, signal) => resolve({ code, signal }));
  });
  process.exitCode = exit.code ?? (exit.signal ? 1 : 0);
} finally {
  proxy.closeAllConnections();
  proxy.close();
}

function isAllowedRequest(method: string, pathname: string): boolean {
  if (method === "GET") {
    return pathname === "/api/tags" || pathname === "/api/version" || pathname === "/v1/models";
  }
  return method === "POST" && pathname === "/v1/responses";
}

function rejectRequest(response: import("node:http").ServerResponse, statusCode: number, message: string): void {
  response.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8", connection: "close" });
  response.end(message);
}
