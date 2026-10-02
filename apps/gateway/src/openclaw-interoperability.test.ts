import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
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

const openclawExecutable = resolveInstalledOpenclaw();

describe("installed OpenClaw interoperability", () => {
  it.skipIf(!openclawExecutable)(
    "drives the real OpenClaw local agent through ACS MCP and the fixture agent",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "acs-gateway-openclaw-e2e-"));
      const allowed = join(dir, "allowed");
      const dbPath = join(dir, "control.db");
      const machineConfigPath = join(dir, "machine-controller.json");
      const openclawStateDir = join(dir, "openclaw-state");
      const openclawConfigPath = join(openclawStateDir, "openclaw.json");
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
      const toolResultDiagnostics: string[] = [];
      let finalResponseSent = false;
      let discoveredToolId: string | undefined;
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
          const toolName = (candidate: unknown): string | undefined => {
            if (!candidate || typeof candidate !== "object") return undefined;
            const functionValue = (candidate as Record<string, unknown>).function;
            const name =
              functionValue && typeof functionValue === "object"
                ? (functionValue as Record<string, unknown>).name
                : (candidate as Record<string, unknown>).name;
            return typeof name === "string" ? name : undefined;
          };
          const tool = tools.find((candidate) => {
            const name = toolName(candidate);
            return name !== undefined && (name.includes("test_agent_run") || name.includes("test-agent-run"));
          }) as Record<string, unknown> | undefined;
          const directToolName = toolName(tool);
          const availableControlTools = new Set(
            tools.map(toolName).filter((name): name is string => name !== undefined)
          );
          const toolResults = messages.filter(
            (message) => message && typeof message === "object" && (message as Record<string, unknown>).role === "tool"
          ) as Array<Record<string, unknown>>;
          const lastTool = toolResults.at(-1);
          const priorToolCalls = messages
            .filter(
              (message) =>
                message &&
                typeof message === "object" &&
                (message as Record<string, unknown>).role === "assistant" &&
                Array.isArray((message as Record<string, unknown>).tool_calls)
            )
            .flatMap((message) => (message as Record<string, unknown>).tool_calls as unknown[]);
          const lastToolCall = priorToolCalls.at(-1);
          const lastToolName = toolName(lastToolCall);
          const content = lastTool?.content;
          const resultText =
            typeof content === "string" ? content : content === undefined ? "" : JSON.stringify(content);
          if (lastTool) {
            toolResultDiagnostics.push(JSON.stringify({ name: lastTool.name, content: resultText.slice(0, 1_500) }));
          }
          let toolResult: unknown;
          let jsonStart = -1;
          const jsonStack: string[] = [];
          let inJsonString = false;
          let escaped = false;
          for (let index = 0; index < resultText.length; index += 1) {
            const character = resultText[index]!;
            if (jsonStart < 0) {
              if (character === "{" || character === "[") {
                jsonStart = index;
                jsonStack.push(character);
              }
              continue;
            }
            if (inJsonString) {
              if (escaped) escaped = false;
              else if (character === "\\") escaped = true;
              else if (character === '"') inJsonString = false;
              continue;
            }
            if (character === '"') inJsonString = true;
            else if (character === "{" || character === "[") jsonStack.push(character);
            else if (character === "}" || character === "]") {
              const opening = jsonStack.pop();
              if ((opening === "{" && character !== "}") || (opening === "[" && character !== "]")) {
                jsonStack.length = 0;
                jsonStart = -1;
                continue;
              }
              if (jsonStack.length === 0) {
                try {
                  toolResult = JSON.parse(resultText.slice(jsonStart, index + 1)) as unknown;
                } catch {
                  toolResult = undefined;
                }
                break;
              }
            }
          }
          if (lastToolName === "tool_search" && toolResult) {
            const findTarget = (value: unknown): string | undefined => {
              if (!value || typeof value !== "object") return undefined;
              if (Array.isArray(value)) {
                for (const entry of value) {
                  const match = findTarget(entry);
                  if (match) return match;
                }
                return undefined;
              }
              const record = value as Record<string, unknown>;
              const name = typeof record.name === "string" ? record.name : "";
              const id = typeof record.id === "string" ? record.id : undefined;
              if (id && /test[._-]agent[._-]run/iu.test(name)) return id;
              for (const entry of Object.values(record)) {
                const match = findTarget(entry);
                if (match) return match;
              }
              return undefined;
            };
            discoveredToolId = findTarget(toolResult);
          }

          const completionId = `openclaw-fixture-${modelBodies.length}`;
          let call: { name: string; args: Record<string, unknown> } | undefined;
          if (toolResults.length === 0 && directToolName) {
            call = {
              name: directToolName,
              args: {
                agent: "openclaw",
                prompt: "OpenClaw deterministic interoperability check",
                cwd: allowed,
                timeoutSeconds: 5,
                permissionMode: "read-only"
              }
            };
          } else if (toolResults.length === 0 && availableControlTools.has("tool_search")) {
            call = { name: "tool_search", args: { query: "test agent run", limit: 5 } };
          } else if (lastToolName === "tool_search" && discoveredToolId && availableControlTools.has("tool_describe")) {
            call = { name: "tool_describe", args: { id: discoveredToolId } };
          } else if (lastToolName === "tool_describe" && discoveredToolId && availableControlTools.has("tool_call")) {
            call = {
              name: "tool_call",
              args: {
                id: discoveredToolId,
                args: {
                  agent: "openclaw",
                  prompt: "OpenClaw deterministic interoperability check",
                  cwd: allowed,
                  timeoutSeconds: 5,
                  permissionMode: "read-only"
                }
              }
            };
          }
          if (call) {
            const toolCall = {
              id: `openclaw-fixture-call-${modelBodies.length}`,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) }
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
            tools: { profile: "coding", sandbox: { tools: { alsoAllow: ["bundle-mcp"] } } },
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
          "openclaw",
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
            env: {
              ...process.env,
              HOME: dir,
              OPENCLAW_STATE_DIR: openclawStateDir,
              OPENCLAW_CONFIG_PATH: openclawConfigPath,
              OPENCLAW_GATEWAY_TOKEN: "deterministic-openclaw-gateway-token",
              OPENCLAW_SKIP_CHANNELS: "1"
            },
            stdio: ["ignore", "pipe", "pipe"]
          }
        );
        openclawGatewayProcess.stdout?.on("data", (chunk: Buffer) => (gatewayOutput += chunk.toString("utf8")));
        openclawGatewayProcess.stderr?.on("data", (chunk: Buffer) => (gatewayOutput += chunk.toString("utf8")));
        await waitForPort(openclawGatewayPort);
        expect(openclawGatewayProcess.exitCode, gatewayOutput).toBeNull();
        openclawProcess = spawn(
          "openclaw",
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
            env: {
              ...process.env,
              HOME: dir,
              OPENCLAW_STATE_DIR: openclawStateDir,
              OPENCLAW_CONFIG_PATH: openclawConfigPath,
              OPENCLAW_GATEWAY_TOKEN: "deterministic-openclaw-gateway-token",
              OPENCLAW_SKIP_CHANNELS: "1"
            },
            stdio: ["ignore", "pipe", "pipe"]
          }
        );
        openclawProcess.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
        openclawProcess.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
        const exitCode = await new Promise<number | null>((resolve, reject) => {
          openclawProcess?.once("error", reject);
          openclawProcess?.once("close", resolve);
        });
        expect(exitCode, `${output}\nOpenClaw gateway:\n${gatewayOutput}`).toBe(0);
        const diagnosticEvents = new SqliteWorkItemStore(dbPath);
        const diagnosticEventNames = diagnosticEvents.readEvents().map((event) => event.name);
        diagnosticEvents.close();
        const modelToolSets = modelBodies.map((body) => {
          const tools = Array.isArray(body.tools) ? body.tools : [];
          return tools.flatMap((candidate) => {
            if (!candidate || typeof candidate !== "object") return [];
            const fn = (candidate as Record<string, unknown>).function;
            const name =
              fn && typeof fn === "object"
                ? (fn as Record<string, unknown>).name
                : (candidate as Record<string, unknown>).name;
            return typeof name === "string" ? [name] : [];
          });
        });
        const diagnostic = `${output}\nOpenClaw gateway:\n${gatewayOutput}\nEvents:${diagnosticEventNames.join(",")}\nModel bodies:${modelBodies.length}\nModel tool sets:${JSON.stringify(modelToolSets)}\nTool results:${toolResultDiagnostics.join(" | ")}`;
        expect(modelBodies.length, diagnostic).toBeGreaterThan(1);
        expect(finalResponseSent, diagnostic).toBe(true);
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
        if (openclawProcess && openclawProcess.exitCode === null) openclawProcess.kill("SIGTERM");
        if (openclawGatewayProcess && openclawGatewayProcess.exitCode === null) openclawGatewayProcess.kill("SIGTERM");
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

async function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
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
  throw new Error(`OpenClaw gateway did not listen on 127.0.0.1:${port}`);
}

function seedActor(dbPath: string, id: string, externalRef: string): void {
  const store = new SqliteWorkItemStore(dbPath);
  try {
    store.registerActor({ id, actorType: "HUMAN", displayName: id, externalRef });
  } finally {
    store.close();
  }
}
