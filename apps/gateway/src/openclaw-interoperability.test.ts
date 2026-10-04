import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { redactValue } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import { buildGateway } from "./server.js";

function resolveInstalledOpenclaw(): string | undefined {
  const override = process.env.ACS_TEST_OPENCLAW_EXECUTABLE?.trim();
  if (override) return existsSync(override) ? override : undefined;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "openclaw");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function openclawFixtureEnvironment(home: string, state: string, config: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: config,
    OPENCLAW_GATEWAY_TOKEN: "deterministic-openclaw-gateway-token",
    OPENCLAW_SKIP_CHANNELS: "1"
  };
}

async function stopFixtureProcess(child: ReturnType<typeof spawn> | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    child.once("close", () => resolve());
    child.once("error", reject);
    child.kill("SIGTERM");
  });
}

const openclawExecutable = resolveInstalledOpenclaw();

describe("installed OpenClaw interoperability", () => {
  it.skipIf(!openclawExecutable)(
    "drives the real OpenClaw local agent through ACS MCP and the fixture agent",
    async () => {
      if (!openclawExecutable) throw new Error("OpenClaw executable unavailable");
      const dir = mkdtempSync(join(tmpdir(), "acs-gateway-openclaw-e2e-"));
      const allowed = join(dir, "allowed");
      const dbPath = join(dir, "control.db");
      const machineConfigPath = join(dir, "machine-controller.json");
      const openclawStateDir = join(dir, "openclaw-state");
      const openclawConfigPath = join(openclawStateDir, "openclaw.json");
      const fixtureEnvironment: NodeJS.ProcessEnv = {};
      for (const key of [
        "PATH",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TZ",
        "TERM",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY"
      ]) {
        if (process.env[key] !== undefined) fixtureEnvironment[key] = process.env[key];
      }
      mkdirSync(allowed);
      mkdirSync(openclawStateDir);
      writeFileSync(
        machineConfigPath,
        JSON.stringify({
          paths: { allow: [allowed], deny: [] },
          security: { max_output_bytes: 256, command_timeout_ms: 5_000 },
          agents: [
            {
              id: "openclaw",
              command: "node",
              args: ["-e", "process.stdout.write('fixture-response:' + process.argv.at(-1))"],
              permission_mode: "read-only"
            }
          ],
          audit: { log_path: join(dir, "machine-audit.jsonl") }
        })
      );

      const modelBodies: Array<Record<string, unknown>> = [];
      let finalResponseSent = false;
<<<<<<< Updated upstream
      let discoveredToolId: string | undefined;
      const bridgeCalls: string[] = [];
=======
      let discoveredTool: string | undefined;
>>>>>>> Stashed changes
      const modelServer = createServer((request, response) => {
        if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
          response.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          modelBodies.push(body);
          const tools = Array.isArray(body.tools) ? body.tools : [];
          const messages = Array.isArray(body.messages) ? body.messages : [];
          const tool = tools.find((candidate) => {
            if (!candidate || typeof candidate !== "object") return false;
            const functionValue = (candidate as Record<string, unknown>).function;
            const name =
              functionValue && typeof functionValue === "object"
                ? (functionValue as Record<string, unknown>).name
                : (candidate as Record<string, unknown>).name;
            return typeof name === "string" && (name.includes("test_agent_run") || name.includes("test-agent-run"));
          }) as Record<string, unknown> | undefined;
          const functionValue = tool?.function;
          let functionName =
            functionValue && typeof functionValue === "object"
              ? (functionValue as Record<string, unknown>).name
              : tool?.name;
          const results = messages.filter(
            (message) => message && typeof message === "object" && (message as Record<string, unknown>).role === "tool"
          ) as Record<string, unknown>[];
          const lastResult = results.at(-1);
          const calls = messages.flatMap((message) => {
            const value =
              message && typeof message === "object" ? (message as Record<string, unknown>).tool_calls : undefined;
            return Array.isArray(value) ? value : [];
          }) as Array<{ id?: string; function?: { name?: string } }>;
          const lastName =
            lastResult?.name ?? calls.find((call) => call.id === lastResult?.tool_call_id)?.function?.name;
          const content =
            typeof lastResult?.content === "string" ? lastResult.content : JSON.stringify(lastResult?.content ?? "");
          // Native search returns a JSON array inside an untrusted-content
          // wrapper. Decode data only; never execute the surrounding text.
          const begin = content.search(/[[{]/u);
          const finish = Math.max(content.lastIndexOf("}"), content.lastIndexOf("]"));
          let parsed: unknown;
          try {
            if (begin >= 0 && finish > begin) parsed = JSON.parse(content.slice(begin, finish + 1));
          } catch {
            /* diagnostic assertions below reject unusable results */
          }
          const findTarget = (value: unknown, depth = 0): string | undefined => {
            if (!value || typeof value !== "object" || depth > 12) return undefined;
            const row = value as Record<string, unknown>;
            if (typeof row.name === "string" && /test[._-]agent[._-]run/.test(row.name)) {
              return typeof row.id === "string" ? row.id : row.name;
            }
            for (const child of Object.values(row)) {
              const found = findTarget(child, depth + 1);
              if (found) return found;
            }
            return undefined;
          };
          const advertised = tools.map(
            (entry) =>
              (entry as { function?: { name?: string }; name?: string }).function?.name ??
              (entry as { name?: string }).name
          );
<<<<<<< Updated upstream
          const invocation = {
=======
          let argumentsValue = JSON.stringify({
>>>>>>> Stashed changes
            agent: "openclaw",
            prompt: "OpenClaw deterministic interoperability check",
            cwd: allowed,
            timeoutSeconds: 5,
            permissionMode: "read-only"
<<<<<<< Updated upstream
          };
          let selectedName: string | undefined;
          let selectedArgs: Record<string, unknown> | undefined;
          if (!lastResult && typeof functionName === "string") {
            selectedName = functionName;
            selectedArgs = invocation;
          } else if (!lastResult && advertised.includes("tool_search")) {
            selectedName = "tool_search";
            selectedArgs = { query: "ACS test agent run", limit: 5 };
          } else if (lastName === "tool_search") {
            discoveredToolId = findTarget(parsed);
            if (discoveredToolId && advertised.includes("tool_describe")) {
              selectedName = "tool_describe";
              selectedArgs = { id: discoveredToolId };
            }
          } else if (lastName === "tool_describe" && discoveredToolId && advertised.includes("tool_call")) {
            selectedName = "tool_call";
            selectedArgs = { id: discoveredToolId, args: invocation };
          }

          const completionId = `openclaw-fixture-${modelBodies.length}`;
          if (selectedName && selectedArgs) {
            bridgeCalls.push(selectedName);
            const argumentsValue = JSON.stringify(selectedArgs);
=======
          });
          let invoke = !hasToolResult && typeof functionName === "string";
          const toolNames = tools.map((entry) => entry?.function?.name ?? entry?.name);
          if (!tool && ["tool_search", "tool_describe", "tool_call"].every((name) => toolNames.includes(name))) {
            const last = messages.filter((message) => message?.role === "tool").at(-1);
            const call = messages
              .flatMap((message) => (Array.isArray(message?.tool_calls) ? message.tool_calls : []))
              .find((candidate) => candidate?.id === last?.tool_call_id);
            const previousName = last?.name ?? call?.function?.name;
            const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? {});
            const wrapped = text.match(/\n---\n([\s\S]*?)\n<<<END_EXTERNAL_UNTRUSTED_CONTENT/);
            const result: unknown = last ? JSON.parse(wrapped?.[1] ?? text) : {};
            const record =
              result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : {};
            const candidates = Array.isArray(result)
              ? result
              : [
                  ...Object.keys(record.tools && typeof record.tools === "object" ? record.tools : {}),
                  ...(Array.isArray(record.results)
                    ? record.results.flatMap((group) => (Array.isArray(group?.matches) ? group.matches : [group]))
                    : [])
                ];
            const discovered = candidates
              .map((entry) => (typeof entry === "string" ? entry : (entry?.id ?? entry?.name)))
              .find((name) => typeof name === "string" && /test[_.-]agent[_.-]run/.test(name));
            if (typeof discovered === "string") discoveredTool = discovered;
            if (!last) {
              functionName = "tool_search";
              argumentsValue = JSON.stringify({ query: "ACS test agent run", limit: 5 });
              invoke = true;
            } else if (previousName === "tool_search" && discoveredTool) {
              functionName = "tool_describe";
              argumentsValue = JSON.stringify({ id: discoveredTool });
              invoke = true;
            } else if (previousName === "tool_describe" && discoveredTool) {
              functionName = "tool_call";
              argumentsValue = JSON.stringify({ id: discoveredTool, args: JSON.parse(argumentsValue) });
              invoke = true;
            }
          }

          const completionId = `openclaw-fixture-${modelBodies.length}`;
          if (invoke && typeof functionName === "string") {
>>>>>>> Stashed changes
            const toolCall = {
              id: `openclaw-fixture-call-${modelBodies.length}`,
              type: "function",
              function: { name: selectedName, arguments: argumentsValue }
            };
            if (body.stream === false) {
              response.writeHead(200, { "content-type": "application/json" });
              response.end(
                JSON.stringify({
                  id: completionId,
                  object: "chat.completion",
                  choices: [
                    { index: 0, message: { role: "assistant", tool_calls: [toolCall] }, finish_reason: "tool_calls" }
                  ]
                })
              );
              return;
            }
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(
              `data: ${JSON.stringify({
                id: completionId,
                object: "chat.completion.chunk",
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          ...toolCall
                        }
                      ]
                    },
                    finish_reason: null
                  }
                ]
              })}\n\ndata: ${JSON.stringify({
                id: completionId,
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
              })}\n\ndata: [DONE]\n\n`
            );
            return;
          }
          finalResponseSent = true;
          if (body.stream === false) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                id: completionId,
                object: "chat.completion",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "OpenClaw fixture invocation completed" },
                    finish_reason: "stop"
                  }
                ]
              })
            );
            return;
          }
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            `data: ${JSON.stringify({
              id: completionId,
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "OpenClaw fixture invocation completed" },
                  finish_reason: null
                }
              ]
            })}\n\ndata: ${JSON.stringify({
              id: completionId,
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
            })}\n\ndata: [DONE]\n\n`
          );
        });
      });

      await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
      const modelAddress = modelServer.address();
      if (!modelAddress || typeof modelAddress === "string") throw new Error("mock model did not expose a socket");

      const app = buildGateway({
        dbPath,
        logger: false,
        mcpAuth: { localBearerToken: "deterministic-openclaw-token" },
        machineControllerConfigPath: machineConfigPath,
        enableTestAgentRunForLocalDevelopment: true
      });
      seedActor(dbPath, "local-dev", "local_bearer:local-dev");
      let openclawProcess: ReturnType<typeof spawn> | undefined;
      let openclawGatewayProcess: ReturnType<typeof spawn> | undefined;
      let output = "";
      let gatewayOutput = "";
      try {
        await app.listen({ host: "127.0.0.1", port: 0 });
        const gatewayAddress = app.server.address();
        if (!gatewayAddress || typeof gatewayAddress === "string") throw new Error("gateway did not expose a socket");
        const openclawGatewayPort = await freePort();
        writeFileSync(
          openclawConfigPath,
          JSON.stringify({
            gateway: { mode: "local", bind: "loopback", port: openclawGatewayPort },
            // OpenClaw 2026.9 defers MCP schemas behind tool_search for this loopback
            // fixture provider when toolSearch is unset. Direct schemas keep test.agent.run callable.
            tools: { profile: "coding", toolSearch: false },
            agents: {
              defaults: {
                workspace: allowed,
                model: { primary: "fixture/fixture-model" },
                skipBootstrap: true
              },
              list: [{ id: "main", default: true, workspace: allowed, model: "fixture/fixture-model" }]
            },
            models: {
              mode: "merge",
              providers: {
                fixture: {
                  baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
                  apiKey: "fixture-key",
                  api: "openai-completions",
                  models: [
                    {
                      id: "fixture-model",
                      name: "OpenClaw local fixture model",
                      reasoning: false,
                      input: ["text"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      contextWindow: 131_072,
                      maxTokens: 512
                    }
                  ]
                }
              }
            },
            mcp: {
              servers: {
                "acs-gateway": {
                  url: `http://127.0.0.1:${gatewayAddress.port}/mcp`,
                  transport: "streamable-http",
                  enabled: true,
                  headers: { Authorization: "Bearer deterministic-openclaw-token" }
                }
              }
            }
          })
        );
        openclawGatewayProcess = spawn(
          openclawExecutable,
          [
            "--profile",
            "acs-test",
            "gateway",
            "run",
            "--bind",
            "loopback",
            "--port",
            String(openclawGatewayPort),
            "--auth",
            "token",
            "--token",
            "deterministic-openclaw-gateway-token"
          ],
          {
            cwd: allowed,
<<<<<<< Updated upstream
            env: openclawFixtureEnvironment(dir, openclawStateDir, openclawConfigPath),
=======
            env: {
              ...fixtureEnvironment,
              HOME: dir,
              OPENCLAW_STATE_DIR: openclawStateDir,
              OPENCLAW_CONFIG_PATH: openclawConfigPath,
              OPENCLAW_GATEWAY_TOKEN: "deterministic-openclaw-gateway-token",
              OPENCLAW_SKIP_CHANNELS: "1"
            },
>>>>>>> Stashed changes
            stdio: ["ignore", "pipe", "pipe"]
          }
        );
        openclawGatewayProcess.stdout?.on("data", (chunk: Buffer) => (gatewayOutput += chunk.toString("utf8")));
        openclawGatewayProcess.stderr?.on("data", (chunk: Buffer) => (gatewayOutput += chunk.toString("utf8")));
<<<<<<< Updated upstream
        await waitForPort(openclawGatewayPort, () => gatewayOutput);
=======
        await waitForPort(openclawGatewayPort, openclawGatewayProcess, () => gatewayOutput);
>>>>>>> Stashed changes
        expect(openclawGatewayProcess.exitCode, gatewayOutput).toBeNull();
        openclawProcess = spawn(
          openclawExecutable,
          [
            "--profile",
            "acs-test",
            "agent",
            "--to",
            "+15555550123",
            "--model",
            "fixture/fixture-model",
            "--json",
            "--timeout",
            "30",
            "--message",
            "Use the ACS fixture agent and report its result."
          ],
          {
            cwd: allowed,
<<<<<<< Updated upstream
            env: openclawFixtureEnvironment(dir, openclawStateDir, openclawConfigPath),
=======
            env: {
              ...fixtureEnvironment,
              HOME: dir,
              OPENCLAW_STATE_DIR: openclawStateDir,
              OPENCLAW_CONFIG_PATH: openclawConfigPath,
              OPENCLAW_GATEWAY_TOKEN: "deterministic-openclaw-gateway-token",
              OPENCLAW_SKIP_CHANNELS: "1"
            },
>>>>>>> Stashed changes
            stdio: ["ignore", "pipe", "pipe"]
          }
        );
        openclawProcess.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
        openclawProcess.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
        const exitCode = await new Promise<number | null>((resolve, reject) => {
          openclawProcess?.once("error", reject);
          openclawProcess?.once("close", resolve);
        });
        const diagnosticEvents = new SqliteWorkItemStore(dbPath);
        const diagnosticEventNames = diagnosticEvents.readEvents().map((event) => event.name);
        diagnosticEvents.close();
<<<<<<< Updated upstream
        const diagnostic = `${output}\nOpenClaw gateway:\n${gatewayOutput}\nEvents:${diagnosticEventNames.join(",")}\nModel bodies:${modelBodies.length}\nTool names:${JSON.stringify(
          modelBodies.map((body) =>
            (Array.isArray(body.tools) ? body.tools : []).map((tool) => {
              const entry = tool as Record<string, unknown>;
              const fn = entry.function as Record<string, unknown> | undefined;
              return fn?.name ?? entry.name;
            })
          )
        )}`;
=======
        const advertisedTools = modelBodies.map((body) =>
          Array.isArray(body.tools) ? body.tools.map((tool) => tool?.function?.name ?? tool?.name) : []
        );
        const bridgeResponses = modelBodies.flatMap((body) =>
          Array.isArray(body.messages) ? body.messages.filter((message) => message?.role === "tool") : []
        );
        const bridgeSchemas = modelBodies
          .flatMap((body) =>
            Array.isArray(body.tools)
              ? body.tools
                  .filter((tool) =>
                    ["tool_search", "tool_describe", "tool_call"].includes(tool?.function?.name ?? tool?.name)
                  )
                  .map((tool) => tool?.function ?? tool)
              : []
          )
          .slice(0, 3);
        const diagnostic = `${output}\nOpenClaw gateway:\n${gatewayOutput}\nEvents:${diagnosticEventNames.join(",")}\nModel bodies:${modelBodies.length}\nModel tools:${JSON.stringify(advertisedTools)}\nBridge responses:${JSON.stringify(redactValue(bridgeResponses)).slice(0, 8_000)}\nBridge schemas:${JSON.stringify(bridgeSchemas)}`;
        expect(exitCode, diagnostic).toBe(0);
>>>>>>> Stashed changes
        expect(modelBodies.length, diagnostic).toBeGreaterThan(1);
        expect(finalResponseSent, diagnostic).toBe(true);
        if (bridgeCalls[0] === "tool_search") {
          expect(bridgeCalls, diagnostic).toEqual(["tool_search", "tool_describe", "tool_call"]);
        }
        expect(
          modelBodies.some((request) => Array.isArray(request.tools)),
          diagnostic
        ).toBe(true);
        expect(
          modelBodies.some(
            (request) =>
              Array.isArray(request.messages) &&
              request.messages.some(
                (message) =>
                  message &&
                  typeof message === "object" &&
                  (message as Record<string, unknown>).role === "tool" &&
                  JSON.stringify(message).includes("fixture-response:")
              )
          ),
          diagnostic
        ).toBe(true);

        const events = new SqliteWorkItemStore(dbPath);
        try {
          const storedEvents = events.readEvents();
          expect(storedEvents.map((event) => event.name)).toEqual(
            expect.arrayContaining([
              "local_agent.authorization",
              "local_agent.dispatch.started",
              "local_agent.completed"
            ])
          );
          expect(events.verifyAuditChain().ok).toBe(true);
          expect(JSON.stringify(storedEvents)).not.toContain("OpenClaw deterministic interoperability check");
        } finally {
          events.close();
        }
        expect(readFileSync(join(dir, "machine-audit.jsonl"), "utf8")).toContain('"tool":"test.agent.run"');
      } finally {
<<<<<<< Updated upstream
        await Promise.all([stopFixtureProcess(openclawProcess), stopFixtureProcess(openclawGatewayProcess)]);
=======
        await stopFixtureProcess(openclawProcess);
        await stopFixtureProcess(openclawGatewayProcess);
>>>>>>> Stashed changes
        await app.close();
        await new Promise<void>((resolve) => modelServer.close(() => resolve()));
        rmSync(dir, { recursive: true, force: true });
      }
      expect(app.server.listening).toBe(false);
      expect(modelServer.listening).toBe(false);
      expect(existsSync(dir)).toBe(false);
    },
    45_000
  );
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not reserve a loopback port");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

<<<<<<< Updated upstream
async function waitForPort(port: number, diagnostics: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
=======
async function waitForPort(port: number, child: ReturnType<typeof spawn>, output: () => string): Promise<void> {
  const deadline = Date.now() + 10_000;
>>>>>>> Stashed changes
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `OpenClaw gateway exited before listening (${child.exitCode ?? child.signalCode}): ${String(redactValue(output().slice(-8_000)))}`
      );
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", reject);
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
<<<<<<< Updated upstream
  throw new Error(`OpenClaw gateway did not listen on 127.0.0.1:${port}. Output: ${diagnostics()}`);
=======
  throw new Error(
    `OpenClaw gateway did not listen on 127.0.0.1:${port}: ${String(redactValue(output().slice(-8_000)))}`
  );
>>>>>>> Stashed changes
}

function seedActor(dbPath: string, id: string, externalRef: string): void {
  const store = new SqliteWorkItemStore(dbPath);
  try {
    store.registerActor({ id, actorType: "HUMAN", displayName: id, externalRef });
  } finally {
    store.close();
  }
}

async function stopFixtureProcess(child: ReturnType<typeof spawn> | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("close", () => {
      clearTimeout(deadline);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
