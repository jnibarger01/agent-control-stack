import { readFileSync } from "node:fs";
import { ControlStackError } from "@agent-control-stack/shared";
import { changeSetDefinitionSchema } from "@agent-control-stack/work-items";
import { runMission, type MissionRunnerPorts, type MissionRunnerOptions } from "./mission-runner.js";

export interface MissionClientConfig {
  gatewayUrl: string;
  gatewayToken: string;
  runtimes: Partial<Record<"desktop_commander" | "jace_commander", { url: string; token: string }>>;
  requestTimeoutMs?: number;
}

function validateEndpoint(value: string): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
  )
    throw new ControlStackError(
      "mission_endpoint_invalid",
      "mission endpoint needs HTTPS or loopback HTTP without URL credentials"
    );
  return url;
}
async function boundedBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0,
    text = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new ControlStackError("mission_response_too_large", "mission response exceeds the bounded client limit");
      }
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/** HTTP adapter uses separate control-plane and runtime identities; no direct tool fallback. */
export function createMissionRunnerClient(config: MissionClientConfig): {
  ports: MissionRunnerPorts;
  close(): Promise<void>;
} {
  const gateway = validateEndpoint(config.gatewayUrl);
  if (gateway.pathname !== "/" || !config.gatewayToken.trim())
    throw new ControlStackError("mission_gateway_config_invalid", "mission gateway requires an origin and credential");
  const timeoutMs = config.requestTimeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new ControlStackError("mission_request_timeout_invalid", "mission request timeout is invalid");
  const sessions = new Map<string, string>();
  let requestId = 0;
  const runtimes = new Map(
    Object.entries(config.runtimes).map(([runtime, endpoint]) => {
      if (!endpoint || !endpoint.token.trim())
        throw new ControlStackError("mission_runtime_config_invalid", "runtime requires its own credential");
      return [runtime, { url: validateEndpoint(endpoint.url), token: endpoint.token }] as const;
    })
  );
  const rpc = async (runtime: string, message: Record<string, unknown>) => {
    const endpoint = runtimes.get(runtime);
    if (!endpoint)
      throw new ControlStackError("mission_runtime_unconfigured", "planned governed runtime is not configured");
    const response = await fetch(endpoint.url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...(sessions.has(runtime) ? { "mcp-session-id": sessions.get(runtime)! } : {})
      },
      body: JSON.stringify(message)
    });
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) sessions.set(runtime, sessionId);
    const text = await boundedBody(response);
    if (!response.ok) throw new ControlStackError("mission_runtime_rejected", "governed runtime rejected the request");
    if (message.id === undefined) return;
    const candidates: unknown[] = text.trimStart().startsWith("{")
      ? [JSON.parse(text)]
      : text
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => JSON.parse(line.slice(5)));
    const envelope = candidates.find(
      (item) => typeof item === "object" && item !== null && "id" in item && item.id === message.id
    );
    if (typeof envelope !== "object" || envelope === null || !("result" in envelope) || "error" in envelope)
      throw new ControlStackError(
        "mission_runtime_response_invalid",
        "runtime did not return the expected protocol result"
      );
    if (
      typeof envelope.result === "object" &&
      envelope.result !== null &&
      "isError" in envelope.result &&
      envelope.result.isError
    )
      throw new ControlStackError(
        "mission_runtime_tool_failed",
        "governed tool reported failure; consult ACS evidence"
      );
  };
  const ports: MissionRunnerPorts = {
    async request(method, path, body) {
      if (!path.startsWith("/work-items/"))
        throw new ControlStackError("mission_route_invalid", "runner may only use governed mission routes");
      const response = await fetch(new URL(path, gateway), {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          authorization: `Bearer ${config.gatewayToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      const text = await boundedBody(response);
      return { status: response.status, body: text ? JSON.parse(text) : undefined };
    },
    async invoke(runtime, name, args, permitId) {
      if (!sessions.has(runtime)) {
        await rpc(runtime, {
          jsonrpc: "2.0",
          id: ++requestId,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "acs-mission-runner", version: "1.0.0" }
          }
        });
        await rpc(runtime, { jsonrpc: "2.0", method: "notifications/initialized" });
      }
      await rpc(runtime, {
        jsonrpc: "2.0",
        id: ++requestId,
        method: "tools/call",
        params: { name, arguments: args, _meta: { acsOperationPermitId: permitId } }
      });
    }
  };
  return {
    ports,
    async close() {
      for (const [runtime, session] of sessions) {
        const endpoint = runtimes.get(runtime)!;
        await fetch(endpoint.url, {
          method: "DELETE",
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
          headers: { authorization: `Bearer ${endpoint.token}`, "mcp-session-id": session }
        }).catch(() => undefined);
      }
      sessions.clear();
    }
  };
}

/** Explicit opt-in for the worker CLI. Credentials are read, never printed or passed in plan data. */
export async function runConfiguredMission(env: NodeJS.ProcessEnv = process.env) {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new ControlStackError("mission_config_missing", `required setting ${name} is missing`);
    return value;
  };
  const grantId = env.ACS_MISSION_GRANT_ID?.trim(),
    approvalId = env.ACS_MISSION_APPROVAL_ID?.trim();
  if (grantId && approvalId)
    throw new ControlStackError("mission_authority_conflict", "configure one mission authority");
  const runtimes: MissionClientConfig["runtimes"] = {};
  for (const [runtime, prefix] of [
    ["desktop_commander", "ACS_MISSION_DC"],
    ["jace_commander", "ACS_MISSION_JC"]
  ] as const) {
    if (env[`${prefix}_MCP_URL`])
      runtimes[runtime] = { url: required(`${prefix}_MCP_URL`), token: required(`${prefix}_MCP_TOKEN`) };
  }
  const client = createMissionRunnerClient({
    gatewayUrl: required("ACS_MISSION_GATEWAY_URL"),
    gatewayToken: required("ACS_MISSION_GATEWAY_TOKEN"),
    runtimes
  });
  try {
    const options: MissionRunnerOptions = {
      missionId: required("ACS_MISSION_ID"),
      ...(grantId ? { authority: { grantId } } : approvalId ? { authority: { approvalId } } : {})
    };
    if (env.ACS_MISSION_PLAN_PATH) {
      const bytes = readFileSync(env.ACS_MISSION_PLAN_PATH);
      if (bytes.byteLength > 1024 * 1024)
        throw new ControlStackError("mission_plan_too_large", "planner file exceeds 1 MiB");
      const definition = changeSetDefinitionSchema.parse(JSON.parse(bytes.toString("utf8")));
      options.plan = async () => definition;
    }
    return await runMission(client.ports, options);
  } finally {
    await client.close();
  }
}
