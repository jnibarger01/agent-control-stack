#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function extractSseData(text) {
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      return JSON.parse(line.slice(5).trim());
    } catch {
      /* continue */
    }
  }
  return null;
}

async function waitHealthy(baseUrl, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      /* retry */
    }
    if (child.exitCode !== null) throw new Error(`bridge exited early: ${child.output()}`);
    await sleep(50);
  }
  throw new Error(`bridge did not become healthy: ${child.output()}`);
}

async function postMcp(baseUrl, body, sessionId, timeout = 2_000) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {})
    },
    signal: AbortSignal.timeout(timeout),
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return { response, text, message: extractSseData(text) };
}

test(
  "managed bridge self-bootstraps direct initialize and keeps tools/list off the execution wait path",
  { timeout: 10_000 },
  async () => {
    const bridgePort = await freePort();
    const acsPort = await freePort();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "acs-direct-init-"));
    fs.writeFileSync(
      path.join(stateDir, "runtime-identity.json"),
      JSON.stringify({ runtimeId: "runtime_direct_test" })
    );

    const challenge = "a".repeat(43);
    const bootstrapBodies = [];
    const completionBodies = [];
    const acs = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          /* test will fail below */
        }
        if (req.url === "/dc/runtime/bootstrap") {
          const issuedChallenge = bootstrapBodies.length === 0 ? challenge : "slow-initialize";
          bootstrapBodies.push(body);
          res.writeHead(201, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              runtimeId: body.runtimeId,
              challenge: issuedChallenge,
              scopes: body.scopes
            })
          );
          return;
        }
        if (req.url === "/dc/runtime/bootstrap/complete") {
          completionBodies.push(body);
          res.writeHead(204);
          res.end();
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise((resolve) => acs.listen(acsPort, "127.0.0.1", resolve));

    const stub = path.join(ROOT, "test", "stub-bootstrap-dc.mjs");
    const child = spawn(process.execPath, [path.join(ROOT, "bridge.js")], {
      cwd: ROOT,
      env: {
        ...process.env,
        BRIDGE_PORT: String(bridgePort),
        ACS_MANAGED_MODE: "1",
        ACS_GATEWAY_URL: `http://127.0.0.1:${acsPort}`,
        ACS_WORKER_TOKEN: "bridge-worker-token",
        ACS_WORKER_ID: "acs-dc-bridge",
        ACS_DC_PUBLIC_KEY: "test-public-key",
        ACS_DC_KEY_ID: "test-key-id",
        ACS_DC_RUNTIME_SCOPES: "fs.read,fs.write,process.exec,process.spawn",
        ACS_RUNTIME_BOOTSTRAP_TIMEOUT_MS: "750",
        DESKTOP_COMMANDER_STATE_DIR: stateDir,
        DC_CMD: process.execPath,
        DC_ARGS: stub,
        DC_CWD: ROOT
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.output = () => output;

    const baseUrl = `http://127.0.0.1:${bridgePort}`;
    try {
      await waitHealthy(baseUrl, child);

      const initialized = await postMcp(baseUrl, {
        jsonrpc: "2.0",
        id: 41,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "direct-managed-test", version: "1" }
        }
      });

      assert.equal(initialized.response.status, 200, initialized.text);
      assert.match(initialized.response.headers.get("content-type") || "", /text\/event-stream/);
      assert.ok(initialized.response.headers.get("mcp-session-id"));
      assert.equal(initialized.message?.id, 41);
      assert.equal(initialized.message?.result?.serverInfo?.name, "bootstrap-stub");
      assert.equal(initialized.message?.result?._meta?.acsRuntimeIdentity?.challenge, challenge);
      assert.equal(bootstrapBodies.length, 1, "bridge did not request exactly one ACS bootstrap challenge");
      assert.equal(completionBodies.length, 1, "bridge did not complete runtime bootstrap before releasing initialize");
      assert.equal(completionBodies[0].runtimeIdentity.challenge, challenge);

      const sessionId = initialized.response.headers.get("mcp-session-id");
      const notification = await postMcp(
        baseUrl,
        {
          jsonrpc: "2.0",
          method: "notifications/initialized"
        },
        sessionId
      );
      assert.equal(notification.response.status, 202);

      const slowExecution = postMcp(
        baseUrl,
        {
          jsonrpc: "2.0",
          id: 42,
          method: "tools/call",
          params: { name: "slow-test", arguments: { delayMs: 1200 } }
        },
        sessionId,
        2_500
      );

      await sleep(50);
      const listStarted = Date.now();
      const listed = await postMcp(
        baseUrl,
        {
          jsonrpc: "2.0",
          id: 43,
          method: "tools/list",
          params: {}
        },
        sessionId,
        1_000
      );
      const listElapsed = Date.now() - listStarted;

      assert.equal(listed.response.status, 200, listed.text);
      assert.equal(listed.message?.id, 43);
      assert.deepEqual(listed.message?.result?.tools, []);
      assert.ok(listElapsed < 900, `tools/list was blocked behind execution for ${listElapsed}ms`);

      const slow = await slowExecution;
      assert.equal(slow.response.status, 200, slow.text);
      assert.equal(slow.message?.id, 42);

      const hungStarted = Date.now();
      const hung = await postMcp(
        baseUrl,
        {
          jsonrpc: "2.0",
          id: 44,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "hung-direct-managed-test", version: "1" }
          }
        },
        undefined,
        2_500
      );
      const hungElapsed = Date.now() - hungStarted;
      assert.equal(hung.response.status, 200, hung.text);
      assert.equal(hung.message?.id, 44);
      assert.equal(hung.message?.error?.message, "MCP initialize upstream timeout");
      assert.ok(hungElapsed < 2_000, `hung initialize exceeded hard ceiling: ${hungElapsed}ms`);
      assert.equal(completionBodies.length, 1, "timed-out initialize must not complete ACS bootstrap");

      await sleep(500);
      const health = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(500) });
      assert.equal(health.status, 200, "late initialize response poisoned the bridge");
      const debug = await (await fetch(`${baseUrl}/debug/last-headers`)).json();
      assert.equal(debug.session_count, 1, "timed-out initialize leaked a live bridge session");
      assert.equal(debug.pending_count, 0, "timed-out initialize leaked a pending route");
    } finally {
      child.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(2_000)]);
      await new Promise((resolve) => acs.close(resolve));
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }
);
