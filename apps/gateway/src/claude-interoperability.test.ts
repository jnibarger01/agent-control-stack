import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { buildGateway } from "./server.js";

function resolveInstalledClaude(): string | undefined {
  const override = process.env.ACS_TEST_CLAUDE_EXECUTABLE?.trim();
  if (override) return existsSync(override) ? override : undefined;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "claude");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const claudeExecutable = resolveInstalledClaude();

describe("installed Claude Code interoperability", () => {
  it.skipIf(!claudeExecutable)(
    "drives the real Claude Code CLI through loopback ACS MCP and a local model mock",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "acs-gateway-claude-e2e-"));
      const allowed = join(dir, "allowed");
      const dbPath = join(dir, "control.db");
      const machineConfigPath = join(dir, "machine-controller.json");
      mkdirSync(allowed);
      writeFileSync(
        machineConfigPath,
        JSON.stringify({
          paths: { allow: [allowed], deny: [] },
          security: { max_output_bytes: 256, command_timeout_ms: 5_000 },
          agents: [
            {
              id: "fixture-agent",
              command: "node",
              args: ["-e", "process.stdout.write('fixture-response:' + 'x'.repeat(512) + ':' + process.argv.at(-1))"],
              permission_mode: "read-only"
            }
          ],
          audit: { log_path: join(dir, "machine-audit.jsonl") }
        })
      );

      const modelRequests: Array<Record<string, unknown>> = [];
      const modelServer = createServer((request, response) => {
        if (request.method !== "POST" || !request.url?.startsWith("/v1/messages")) {
          response.writeHead(404).end();
          return;
        }
        if (request.url.includes("/count_tokens")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ input_tokens: 1 }));
          return;
        }
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          modelRequests.push(body);
          const tools = Array.isArray(body.tools) ? body.tools : [];
          const messages = Array.isArray(body.messages) ? body.messages : [];
          const tool = tools.find(
            (candidate) =>
              candidate &&
              typeof candidate === "object" &&
              typeof (candidate as Record<string, unknown>).name === "string" &&
              String((candidate as Record<string, unknown>).name).includes("test_agent_run")
          ) as Record<string, unknown> | undefined;
          const hasToolResult = messages.some((message) => {
            if (!message || typeof message !== "object") return false;
            const value = message as Record<string, unknown>;
            const content = Array.isArray(value.content) ? value.content : [];
            return content.some(
              (block) => block && typeof block === "object" && (block as Record<string, unknown>).type === "tool_result"
            );
          });
          response.writeHead(200, { "content-type": "application/json" });

          if (tool && !hasToolResult) {
            response.end(
              JSON.stringify({
                id: "claude-fixture-tool-use",
                type: "message",
                role: "assistant",
                model: "claude-local-fixture",
                content: [
                  {
                    type: "tool_use",
                    id: "claude-fixture-call",
                    name: tool.name,
                    input: {
                      agent: "fixture-agent",
                      prompt: "Claude deterministic interoperability check",
                      cwd: allowed,
                      timeoutSeconds: 5,
                      permissionMode: "read-only"
                    }
                  }
                ],
                stop_reason: "tool_use",
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 }
              })
            );
            return;
          }

          const rejected =
            tools.length === 0 ||
            messages.some((message) => {
              const serialized = JSON.stringify(message).toLowerCase();
              return serialized.includes("unauthorized") || serialized.includes('"is_error":true');
            });
          response.end(
            JSON.stringify({
              id: "claude-fixture-final",
              type: "message",
              role: "assistant",
              model: "claude-local-fixture",
              content: [
                {
                  type: "text",
                  text: rejected ? "Claude observed ACS rejection" : "Claude fixture invocation completed"
                }
              ],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 }
            })
          );
        });
      });

      await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
      const modelAddress = modelServer.address();
      if (!modelAddress || typeof modelAddress === "string")
        throw new Error("local Claude model did not expose a socket");

      const app = buildGateway({
        dbPath,
        logger: false,
        mcpAuth: { localBearerToken: "deterministic-claude-token" },
        machineControllerConfigPath: machineConfigPath,
        enableTestAgentRunForLocalDevelopment: true
      });
      seedActor(dbPath);
      let claudeProcess: ReturnType<typeof spawn> | undefined;
      try {
        await app.listen({ host: "127.0.0.1", port: 0 });
        const gatewayAddress = app.server.address();
        if (!gatewayAddress || typeof gatewayAddress === "string") throw new Error("gateway did not expose a socket");
        const mcpConfig = JSON.stringify({
          mcpServers: {
            "acs-gateway": {
              type: "http",
              url: `http://127.0.0.1:${gatewayAddress.port}/mcp`,
              headers: { Authorization: "Bearer deterministic-claude-token" }
            }
          }
        });
        const run = async (): Promise<{ exitCode: number | null; stdout: string; stderr: string }> => {
          if (!claudeExecutable) throw new Error("Claude Code CLI is not installed");
          const child = spawn(
            claudeExecutable,
            [
              "--bare",
              "--no-session-persistence",
              "--strict-mcp-config",
              "--mcp-config",
              mcpConfig,
              "--allowed-tools",
              "mcp__acs-gateway__test_agent_run",
              "--permission-mode",
              "dontAsk",
              "--output-format",
              "json",
              "-p",
              "Use the ACS direct agent tool and report the result."
            ],
            {
              cwd: allowed,
              env: {
                PATH: process.env.PATH,
                HOME: dir,
                TMPDIR: dir,
                USER: process.env.USER,
                ANTHROPIC_BASE_URL: `http://127.0.0.1:${modelAddress.port}`,
                ANTHROPIC_API_KEY: "local-claude-fixture-key",
                NO_COLOR: "1",
                CI: "1"
              },
              stdio: ["ignore", "pipe", "pipe"]
            }
          );
          claudeProcess = child;
          let stdout = "";
          let stderr = "";
          child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
          child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
          const result = await new Promise<number | null>((resolve, reject) => {
            const timeout = setTimeout(() => {
              child.kill("SIGTERM");
              reject(new Error(`Claude Code timed out; model requests=${modelRequests.length}`));
            }, 30_000);
            child.once("error", reject);
            child.once("close", (code) => {
              clearTimeout(timeout);
              resolve(code);
            });
          });
          return { exitCode: result, stdout, stderr };
        };

        const valid = await run();
        expect(valid.exitCode, `${valid.stdout}\n${valid.stderr}`).toBe(0);
        expect(valid.stdout).toContain("Claude fixture invocation completed");
        expect(modelRequests.length).toBeGreaterThan(1);
        expect(modelRequests.some((request) => Array.isArray(request.tools))).toBe(true);
        expect(modelRequests.some((request) => JSON.stringify(request).includes("tool_result"))).toBe(true);

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
          expect(JSON.stringify(storedEvents)).not.toContain("Claude deterministic interoperability check");
        } finally {
          events.close();
        }
        expect(readFileSync(join(dir, "machine-audit.jsonl"), "utf8")).toContain('"tool":"test.agent.run"');
      } finally {
        if (claudeProcess && claudeProcess.exitCode === null) claudeProcess.kill("SIGTERM");
        await app.close();
        await new Promise<void>((resolve) => modelServer.close(() => resolve()));
        rmSync(dir, { recursive: true, force: true });
      }
      expect(app.server.listening).toBe(false);
      expect(modelServer.listening).toBe(false);
      expect(existsSync(dir)).toBe(false);
    },
    60_000
  );
});

function seedActor(dbPath: string): void {
  const store = new SqliteWorkItemStore(dbPath);
  try {
    store.registerActor({
      id: "local-dev",
      actorType: "HUMAN",
      displayName: "local-dev",
      externalRef: "local_bearer:local-dev"
    });
  } finally {
    store.close();
  }
}
