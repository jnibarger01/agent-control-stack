import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildGateway } from "./server.js";
import {
  fingerprintHermesState,
  inspectHermesInstallation,
  measureHermesFixtureBytes,
  prepareHermesE2eFixture,
  assertHermesPathContained,
  type HermesFixture,
  type HermesManifestEntry
} from "./hermes-e2e-fixture.js";

function resolveHermesExecutable(): string | undefined {
  const override = process.env.ACS_TEST_HERMES_EXECUTABLE?.trim();
  if (override) return existsSync(override) ? override : undefined;
  const persistentControlLauncher = "/home/jacen/.local/bin/hermes";
  return existsSync(persistentControlLauncher) ? persistentControlLauncher : undefined;
}

function seedActor(dbPath: string, id: string, externalRef: string): void {
  const store = new SqliteWorkItemStore(dbPath);
  try {
    store.registerActor({ id, actorType: "HUMAN", displayName: id, externalRef });
  } finally {
    store.close();
  }
}

function compareHermesManifests(before: HermesManifestEntry[], after: HermesManifestEntry[]): HermesManifestEntry[] {
  const previous = new Map(before.map((entry) => [entry.path, JSON.stringify(entry)]));
  const current = new Map(after.map((entry) => [entry.path, JSON.stringify(entry)]));
  return [...new Set([...previous.keys(), ...current.keys()])]
    .filter((path) => previous.get(path) !== current.get(path))
    .map((path) => {
      const value = current.get(path) ?? previous.get(path);
      return value ? (JSON.parse(value) as HermesManifestEntry) : { path, type: "missing", mode: 0, size: 0 };
    });
}

async function waitForHermesExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
  output: () => string
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timer = setTimeout(() => {
      void stopHermesProcess(child).then(() =>
        reject(new Error(`Hermes E2E exceeded ${timeoutMs}ms: ${output().slice(-8_000)}`))
      );
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function stopHermesProcess(child: ReturnType<typeof spawn> | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 3_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    if (child.pid && process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    } else {
      child.kill("SIGKILL");
    }
    await closed;
  }
}

const hermesExecutable = resolveHermesExecutable();
let fixtureDirectory: string | undefined;
let hermesFixture: HermesFixture | undefined;
let persistentRoots: string[] = [];
let persistentManifestBefore: Awaited<ReturnType<typeof fingerprintHermesState>> = [];
let fixturePreparationMs = 0;
let fixtureSizeBytes = 0;
let persistentChanges: HermesManifestEntry[] = [];
let e2eDurationMs = 0;
let startupDurationMs = 0;
let interopDurationMs = 0;
let childResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
const persistentLauncherHashesBefore: Record<string, string> = {};
let fixtureMutationEntries: HermesManifestEntry[] = [];
let hermesStdoutEvidence = "";
let hermesStderrEvidence = "";
let childEvidence:
  { command: string; args: string[]; cwd: string; env: Record<string, string | undefined>; pid?: number } | undefined;
let interopStages:
  | { modelTools: string[]; gatewayEvents: string[]; returnedToolResult: string; machineAuditToolPresent: boolean }
  | undefined;
let hermesAssertionsPassed = false;
let hermesRestartsBefore = "";

const evidenceDirectory = process.env.ACS_HERMES_E2E_EVIDENCE_DIR?.trim();
const hermesFingerprintOptions = { hashFilesAtMostBytes: 4_096 };
const hermesFingerprintPolicy = "sha256 files <= 4 KiB; device, inode, mode, size, mtime, and ctime for every entry";

function writeEvidence(name: string, value: unknown): void {
  if (!evidenceDirectory) return;
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(evidenceDirectory, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function systemdUserProperty(property: string): string {
  return execFileSync("systemctl", ["--user", "show", "hermes-gateway.service", `-p${property}`, "--value"], {
    encoding: "utf8"
  }).trim();
}

function verifyHermesIdle(): void {
  const service = systemdUserProperty("ActiveState");
  const mainPid = systemdUserProperty("MainPID");
  if (service !== "inactive" || mainPid !== "0") {
    throw new Error(
      `Hermes gateway service must be inactive with MainPID=0 before E2E, got: ${service}, MainPID=${mainPid}`
    );
  }
  const pendingHermesJobs = execFileSync("systemctl", ["--user", "list-jobs", "--no-legend"], { encoding: "utf8" })
    .split("\n")
    .filter((job) => job.includes("hermes-gateway.service"));
  if (pendingHermesJobs.length > 0) {
    throw new Error(`Hermes gateway systemd jobs are active before E2E: ${pendingHermesJobs.join(" | ")}`);
  }
  const processes = execFileSync("ps", ["-eo", "pid=,comm=,args="], { encoding: "utf8" });
  const candidates = processes.split("\n").filter((line) => {
    const [, command = "", args = ""] = line.trim().match(/^\d+\s+(\S+)\s+(.*)$/) ?? [];
    return (
      /^(hermes|hermes-acp|hermes-gateway)$/i.test(command) ||
      (/source.?completion|hermes_cli\.(update|venv_sync)|hermes_cli\.main/.test(args) &&
        !args.includes("hermes-interoperability.test"))
    );
  });
  if (candidates.length)
    throw new Error(`Hermes/source-completion processes are active before E2E: ${candidates.join(" | ")}`);
}

describe.skipIf(!hermesExecutable || process.env.ACS_RUN_HERMES_INTEROP !== "1")(
  "isolated Hermes interoperability",
  () => {
    beforeAll(async () => {
      verifyHermesIdle();
      const installation = inspectHermesInstallation(hermesExecutable as string);
      const persistentAcPLauncher = join(installation.sourceRoot, ".hermes", "bin", "hermes-acp");
      const publishedAcPLauncher = "/home/jacen/.local/bin/hermes-acp";
      const publishedAcPContents = readFileSync(publishedAcPLauncher, "utf8");
      const sourceAcPContents = readFileSync(persistentAcPLauncher, "utf8");
      if (!publishedAcPContents.includes(persistentAcPLauncher)) {
        throw new Error("Persistent hermes-acp launcher does not forward to the installed Hermes source launcher");
      }
      if (!sourceAcPContents.includes(installation.python) || !sourceAcPContents.includes(installation.sourceRoot)) {
        throw new Error("Persistent hermes-acp launcher does not match the selected Hermes Python and source root");
      }
      const launcherPaths = [
        "/home/jacen/.local/bin/hermes",
        publishedAcPLauncher,
        installation.launcher,
        persistentAcPLauncher
      ];
      for (const path of launcherPaths) {
        if (/\/tmp\/acs-gateway-hermes-e2e-/.test(readFileSync(path, "utf8"))) {
          throw new Error(`Persistent Hermes launcher references an ACS fixture path: ${path}`);
        }
      }
      const serviceExec = systemdUserProperty("ExecStart");
      if (!serviceExec.includes(installation.launcher)) {
        throw new Error("Hermes gateway service does not target the persistent installed Hermes launcher");
      }
      hermesRestartsBefore = systemdUserProperty("NRestarts");
      persistentRoots = [
        installation.hermesHome,
        installation.sourceRoot,
        installation.runtimeRoot,
        installation.installState,
        join(installation.hermesHome, "bin"),
        "/home/jacen/.local/bin/hermes",
        publishedAcPLauncher
      ];
      persistentManifestBefore = await fingerprintHermesState(persistentRoots, hermesFingerprintOptions);
      if (persistentManifestBefore.length === 0) throw new Error("Persistent Hermes integrity manifest is empty");
      for (const path of launcherPaths) {
        const entry = persistentManifestBefore.find((candidate) => candidate.path === path);
        if (!entry?.sha256) throw new Error(`Persistent Hermes launcher missing from manifest: ${path}`);
        persistentLauncherHashesBefore[path] = entry.sha256;
      }
      writeEvidence("persistent-before.json", {
        capturedAt: new Date().toISOString(),
        roots: persistentRoots,
        fingerprintPolicy: hermesFingerprintPolicy,
        launcherHashes: persistentLauncherHashesBefore,
        entries: persistentManifestBefore
      });

      fixtureDirectory = mkdtempSync(join(tmpdir(), "acs-gateway-hermes-e2e-"));
      const startedAt = performance.now();
      hermesFixture = prepareHermesE2eFixture(hermesExecutable as string, fixtureDirectory);
      fixturePreparationMs = performance.now() - startedAt;
      fixtureSizeBytes = measureHermesFixtureBytes(fixtureDirectory);
    }, 300_000);

    afterAll(async () => {
      if (persistentRoots.length > 0 && persistentManifestBefore.length > 0) {
        const persistentManifestAfter = await fingerprintHermesState(persistentRoots, hermesFingerprintOptions);
        persistentChanges = compareHermesManifests(persistentManifestBefore, persistentManifestAfter);
        for (const [path, before] of Object.entries(persistentLauncherHashesBefore)) {
          const after = persistentManifestAfter.find((entry) => entry.path === path)?.sha256;
          if (after !== before)
            persistentChanges.push({ path, type: "launcher-hash-changed", mode: 0, size: 0, sha256: after });
        }
        writeEvidence("persistent-after.json", {
          capturedAt: new Date().toISOString(),
          roots: persistentRoots,
          fingerprintPolicy: hermesFingerprintPolicy,
          launcherHashes: Object.fromEntries(
            Object.keys(persistentLauncherHashesBefore).map((path) => [
              path,
              persistentManifestAfter.find((entry) => entry.path === path)?.sha256 ?? null
            ])
          ),
          changedPaths: persistentChanges,
          entries: persistentManifestAfter
        });
        if (hermesFixture?.fixtureManifestBefore && fixtureDirectory && existsSync(fixtureDirectory)) {
          const fixtureAfter = await fingerprintHermesState([fixtureDirectory], hermesFingerprintOptions);
          fixtureMutationEntries = compareHermesManifests(hermesFixture.fixtureManifestBefore, fixtureAfter);
          writeEvidence("fixture-mutations.json", fixtureMutationEntries);
        }
        const redact = (value: string) =>
          value
            .replaceAll("deterministic-hermes-token", "<redacted-token>")
            .replaceAll("fixture-key", "<redacted-key>");
        writeEvidence("hermes-stdout.txt", redact(hermesStdoutEvidence));
        writeEvidence("hermes-stderr.txt", redact(hermesStderrEvidence));
        process.stderr.write(
          `Hermes E2E evidence: ${JSON.stringify({
            fixture: {
              root: fixtureDirectory,
              bytes: fixtureSizeBytes,
              sourceRoot: hermesFixture?.fixtureRoot,
              python: hermesFixture?.fixturePython,
              runtime: hermesFixture?.fixtureRuntime,
              launcher: hermesFixture?.fixtureLauncher,
              acpLauncher: hermesFixture?.fixtureAcPLauncher,
              home: hermesFixture?.fixtureHome,
              hermesHome: hermesFixture?.fixtureHome,
              appGeneration: hermesFixture ? basename(dirname(hermesFixture.fixtureEnvironment)) : undefined,
              pmGeneration: hermesFixture
                ? JSON.parse(readFileSync(join(hermesFixture.fixtureState, "pm-runtime", "selected.json"), "utf8"))
                    .generation
                : undefined
            },
            child: childEvidence,
            stages: interopStages,
            prepare_ms: Math.round(fixturePreparationMs),
            startup_ms: Math.round(startupDurationMs),
            interoperability_ms: Math.round(interopDurationMs),
            e2e_ms: Math.round(e2eDurationMs),
            exit: childResult?.code,
            signal: childResult?.signal,
            stdout: redact(hermesStdoutEvidence),
            stderr: redact(hermesStderrEvidence),
            persistent_entries: persistentManifestBefore.length,
            launcher_hashes: persistentLauncherHashesBefore,
            persistent_changes: persistentChanges.length,
            fixture_mutations: fixtureMutationEntries.map(({ path, type, sha256 }) => ({ path, type, sha256 }))
          })}\n`
        );
        if (persistentChanges.length > 0) {
          throw new Error(
            `Persistent Hermes state changed; no repair attempted; fixture preserved at ${fixtureDirectory}`
          );
        }
        const serviceAfter = systemdUserProperty("ActiveState");
        const mainPidAfter = systemdUserProperty("MainPID");
        const restartsAfter = systemdUserProperty("NRestarts");
        if (serviceAfter !== "inactive" || mainPidAfter !== "0" || restartsAfter !== hermesRestartsBefore) {
          throw new Error(
            `Hermes gateway service state changed during E2E: ${serviceAfter}, MainPID=${mainPidAfter}, NRestarts=${restartsAfter}`
          );
        }
      }
      if (
        hermesAssertionsPassed &&
        persistentChanges.length === 0 &&
        fixtureDirectory &&
        existsSync(fixtureDirectory)
      ) {
        rmSync(fixtureDirectory, { recursive: true, force: true });
      } else if (fixtureDirectory && existsSync(fixtureDirectory)) {
        process.stderr.write(`Hermes fixture preserved for recovery: ${fixtureDirectory}\n`);
      }
    }, 300_000);

    it("proves real Hermes CLI interoperability through the tool-search bridge and gateway", async () => {
      const dir = fixtureDirectory as string;
      const allowed = join(dir, "allowed");
      const dbPath = join(dir, "control.db");
      const configPath = join(dir, "machine-controller.json");
      const fixture = hermesFixture as HermesFixture;
      mkdirSync(allowed);
      for (const path of [
        allowed,
        dbPath,
        configPath,
        join(dir, "machine-audit.jsonl"),
        fixture.fixtureHome,
        join(fixture.fixtureHome, "config.yaml")
      ]) {
        assertHermesPathContained(dir, path);
      }
      writeFileSync(
        configPath,
        JSON.stringify({
          paths: { allow: [allowed], deny: [] },
          security: { max_output_bytes: 256, command_timeout_ms: 5_000 },
          agents: [
            {
              id: "fixture-agent",
              command: "node",
              args: ["-e", "process.stdout.write('fixture-response:' + process.argv.at(-1))"],
              permission_mode: "read-only"
            }
          ],
          audit: { log_path: join(dir, "machine-audit.jsonl") }
        })
      );

      fixture.fixtureManifestBefore = await fingerprintHermesState([dir], hermesFingerprintOptions);

      const modelTrace: Array<{
        advertisedTools: string[];
        emitted: { name: string; arguments: Record<string, unknown> } | undefined;
      }> = [];
      let returnedToolResult = "";
      let firstModelRequestAt: number | undefined;
      const modelServer = createServer((request, response) => {
        if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
          response.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          firstModelRequestAt ??= performance.now();
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          const messages = Array.isArray(body.messages) ? body.messages : [];
          const tools = Array.isArray(body.tools) ? body.tools : [];
          const advertisedTools = tools.flatMap((candidate) => {
            if (!candidate || typeof candidate !== "object") return [];
            const fn = (candidate as Record<string, unknown>).function;
            const name =
              fn && typeof fn === "object"
                ? (fn as Record<string, unknown>).name
                : (candidate as Record<string, unknown>).name;
            return typeof name === "string" ? [name] : [];
          });
          const toolResults = messages.filter(
            (message) => message && typeof message === "object" && (message as Record<string, unknown>).role === "tool"
          );
          const lastTool = toolResults.at(-1) as Record<string, unknown> | undefined;
          const resultText =
            lastTool && typeof lastTool.content === "string"
              ? String(lastTool.content)
              : lastTool && Array.isArray(lastTool.content)
                ? JSON.stringify(lastTool.content)
                : lastTool
                  ? JSON.stringify(lastTool)
                  : "";
          if (lastTool?.name === "tool_call") returnedToolResult = resultText;
          const jsonStart = resultText.indexOf("{");
          const jsonEnd = resultText.lastIndexOf("}");
          const result =
            jsonStart >= 0 && jsonEnd > jsonStart
              ? (JSON.parse(resultText.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>)
              : undefined;
          const emit = (name: string, args: Record<string, unknown>) => {
            if (!advertisedTools.includes(name)) {
              const firstToolKeys = tools[0] && typeof tools[0] === "object" ? Object.keys(tools[0]).join(",") : "none";
              throw new Error(
                `unadvertised Hermes bridge: ${name}; advertised=${advertisedTools.join(",")}; body=${Object.keys(body).join(",")}; firstToolKeys=${firstToolKeys}`
              );
            }
            modelTrace.push({
              advertisedTools,
              emitted: { name, arguments: Object.fromEntries(Object.keys(args).map((key) => [key, "<redacted>"])) }
            });
            return { name, args };
          };

          const searchHits = ((): Array<Record<string, unknown>> => {
            if (!result) return [];
            const hits: Array<Record<string, unknown>> = [];
            const pushName = (name: unknown) => {
              if (typeof name === "string" && name) hits.push({ name });
            };
            if (result.tools && typeof result.tools === "object" && !Array.isArray(result.tools)) {
              for (const name of Object.keys(result.tools as Record<string, unknown>)) pushName(name);
            }
            if (Array.isArray(result.results)) {
              for (const item of result.results) {
                if (!item || typeof item !== "object") continue;
                const row = item as Record<string, unknown>;
                if (typeof row.name === "string") pushName(row.name);
                if (Array.isArray(row.matches)) {
                  for (const match of row.matches) {
                    if (typeof match === "string") pushName(match);
                    else if (
                      match &&
                      typeof match === "object" &&
                      typeof (match as Record<string, unknown>).name === "string"
                    ) {
                      pushName((match as Record<string, unknown>).name);
                    }
                  }
                }
              }
            }
            if (Array.isArray(result.matches)) {
              for (const match of result.matches) {
                if (typeof match === "string") pushName(match);
                else if (
                  match &&
                  typeof match === "object" &&
                  typeof (match as Record<string, unknown>).name === "string"
                ) {
                  pushName((match as Record<string, unknown>).name);
                }
              }
            }
            return hits;
          })();
          const namedHit = searchHits.find(
            (item) => typeof item.name === "string" && item.name === "mcp__acs-gateway__test_agent_run"
          );

          let call: { name: string; args: Record<string, unknown> } | undefined;
          if (tools.length === 0) {
            // Hermes performs a provider capability/metadata probe before the
            // first tool-bearing turn. It is not the model-facing smoke path.
          } else if (toolResults.length === 0) {
            call = emit("tool_search", { queries: ["ACS test agent run", "test.agent.run"], limit: 5 });
          } else if (lastTool?.name === "tool_search" && namedHit) {
            call = emit("tool_describe", { names: [namedHit.name] });
          } else if (lastTool?.name === "tool_search") {
            throw new Error(`ACS test tool was not discovered; results=${JSON.stringify(searchHits)}`);
          } else if (lastTool?.name === "tool_describe") {
            const describedName =
              result?.tools && typeof result.tools === "object"
                ? Object.keys(result.tools as Record<string, unknown>).find(
                    (name) => name === "mcp__acs-gateway__test_agent_run"
                  )
                : undefined;
            if (!describedName) throw new Error(`tool_describe did not return the ACS test tool schema: ${resultText}`);
            call = emit("tool_call", {
              calls: [
                {
                  name: describedName,
                  arguments: {
                    agent: "fixture-agent",
                    prompt: "Hermes deterministic interoperability check",
                    cwd: allowed,
                    timeoutSeconds: 5,
                    permissionMode: "read-only"
                  }
                }
              ]
            });
          }

          response.writeHead(200, { "content-type": "text/event-stream" });
          const id = `hermes-fixture-${modelTrace.length}`;
          if (call) {
            response.end(
              `data: ${JSON.stringify({
                id,
                object: "chat.completion.chunk",
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: `hermes-call-${modelTrace.length}`,
                          type: "function",
                          function: { name: call.name, arguments: JSON.stringify(call.args) }
                        }
                      ]
                    },
                    finish_reason: null
                  }
                ]
              })}\n\ndata: ${JSON.stringify({
                id,
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
              })}\n\ndata: [DONE]\n\n`
            );
            return;
          }
          const finalContent = tools.length === 0 ? "{}" : "Hermes fixture invocation completed";
          response.end(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { role: "assistant", content: finalContent }, finish_reason: null }]
            })}\n\ndata: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
            })}\n\ndata: [DONE]\n\n`
          );
        });
      });
      await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
      const modelAddress = modelServer.address();
      if (!modelAddress || typeof modelAddress === "string") throw new Error("local model did not expose a socket");

      const app = buildGateway({
        dbPath,
        logger: false,
        mcpAuth: { localBearerToken: "deterministic-hermes-token" },
        machineControllerConfigPath: configPath,
        enableTestAgentRunForLocalDevelopment: true
      });
      seedActor(dbPath, "local-dev", "local_bearer:local-dev");
      let hermesProcess: ReturnType<typeof spawn> | undefined;
      let hermesStdout = "";
      let hermesStderr = "";
      try {
        await app.listen({ host: "127.0.0.1", port: 0 });
        const gatewayAddress = app.server.address();
        if (!gatewayAddress || typeof gatewayAddress === "string") throw new Error("gateway did not expose a socket");
        writeFileSync(
          join(fixture.fixtureHome, "config.yaml"),
          `model:\n  provider: custom\n  default: fixture-model\n  base_url: http://127.0.0.1:${modelAddress.port}/v1\n  api_key: fixture-key\n  context_length: 65536\n  max_tokens: 512\nmcp_servers:\n  acs-gateway:\n    url: http://127.0.0.1:${gatewayAddress.port}/mcp\n    headers:\n      Authorization: Bearer deterministic-hermes-token\ntools:\n  tool_search:\n    enabled: on\nplugins:\n  enabled: ${JSON.stringify(fixture.defaultPluginConfig.enabled)}\n  disabled: ${JSON.stringify(fixture.defaultPluginConfig.disabled)}\n${fixture.defaultPluginConfig.memoryProvider ? `memory:\n  provider: ${JSON.stringify(fixture.defaultPluginConfig.memoryProvider)}\n` : ""}`
        );
        verifyHermesIdle();
        const e2eStartedAt = performance.now();
        const childArgs = [
          "--ignore-rules",
          "--no-restore-cwd",
          "-z",
          "Run the explicitly registered ACS fixture agent and report its result."
        ];
        const childEnv = {
          HOME: join(dir, "home"),
          HERMES_HOME: fixture.fixtureHome,
          HERMES_RUNTIME_DIR: fixture.fixtureRuntime,
          HERMES_INSTALL_ROOT: fixture.fixtureRoot,
          HERMES_ACCEPT_HOOKS: "1",
          XDG_CONFIG_HOME: join(dir, "xdg", "config"),
          XDG_CACHE_HOME: join(dir, "xdg", "cache"),
          XDG_DATA_HOME: join(dir, "xdg", "data"),
          UV_CACHE_DIR: join(dir, "uv-cache"),
          TMPDIR: join(dir, "tmp"),
          PATH: `${dirname(fixture.fixturePython)}:/usr/bin:/bin`,
          LANG: process.env.LANG,
          LC_ALL: process.env.LC_ALL,
          LC_CTYPE: process.env.LC_CTYPE,
          TZ: process.env.TZ
        };
        childEvidence = { command: fixture.fixtureLauncher, args: childArgs, cwd: allowed, env: childEnv };
        hermesProcess = spawn(fixture.fixtureLauncher, childArgs, {
          cwd: allowed,
          env: childEnv,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"]
        });
        childEvidence.pid = hermesProcess.pid;
        hermesProcess.stdout?.on("data", (chunk: Buffer) => (hermesStdout += chunk.toString("utf8")));
        hermesProcess.stderr?.on("data", (chunk: Buffer) => (hermesStderr += chunk.toString("utf8")));
        const spawnedAt = performance.now();
        childResult = await waitForHermesExit(hermesProcess, 25_000, () => `${hermesStdout}\n${hermesStderr}`);
        hermesStdoutEvidence = hermesStdout;
        hermesStderrEvidence = hermesStderr;
        e2eDurationMs = performance.now() - e2eStartedAt;
        startupDurationMs = firstModelRequestAt === undefined ? e2eDurationMs : firstModelRequestAt - spawnedAt;
        interopDurationMs = firstModelRequestAt === undefined ? 0 : performance.now() - firstModelRequestAt;
        expect(childResult.code, `${hermesStdout}\nSTDERR:\n${hermesStderr}`).toBe(0);
        expect(`${hermesStdout}\n${hermesStderr}`).toContain("Hermes fixture invocation completed");
        expect(returnedToolResult).toContain("fixture-response:");
        expect(e2eDurationMs, `fixture preparation took ${Math.round(fixturePreparationMs)}ms`).toBeLessThan(25_000);
        expect(modelTrace.map((entry) => entry.emitted?.name)).toEqual(["tool_search", "tool_describe", "tool_call"]);
        expect(
          modelTrace.every((entry) =>
            ["tool_search", "tool_describe", "tool_call"].every((name) => entry.advertisedTools.includes(name))
          ),
          JSON.stringify(modelTrace)
        ).toBe(true);

        const events = new SqliteWorkItemStore(dbPath);
        try {
          const storedEvents = events.readEvents();
          const machineAudit = readFileSync(join(dir, "machine-audit.jsonl"), "utf8");
          interopStages = {
            modelTools: modelTrace.map((entry) => entry.emitted?.name ?? ""),
            gatewayEvents: storedEvents.map((event) => event.name),
            returnedToolResult,
            machineAuditToolPresent: machineAudit.includes('"tool":"test.agent.run"')
          };
          expect(storedEvents.map((event) => event.name)).toEqual(
            expect.arrayContaining([
              "actor.registered",
              "local_agent.authorization",
              "local_agent.dispatch.started",
              "local_agent.completed"
            ])
          );
          expect(events.verifyAuditChain().ok).toBe(true);
          expect(JSON.stringify(storedEvents)).not.toContain("Hermes deterministic interoperability check");
        } finally {
          events.close();
        }
        expect(interopStages?.machineAuditToolPresent).toBe(true);
      } finally {
        hermesStdoutEvidence = hermesStdout;
        hermesStderrEvidence = hermesStderr;
        await stopHermesProcess(hermesProcess);
        await app.close();
        await new Promise<void>((resolve) => modelServer.close(() => resolve()));
      }
      expect(app.server.listening).toBe(false);
      expect(modelServer.listening).toBe(false);
      hermesAssertionsPassed = true;
    }, 45_000);
  }
);
