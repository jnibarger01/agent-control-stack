#!/usr/bin/env node

// Unprivileged MCP-facing adapter: lets an OpenClaw MCP client drive Desktop
// Commander in managed ACS mode without ever letting OpenClaw address the
// managed child directly, and without OpenClaw's MCP _meta ever reaching it.
//
// This process holds no ACS signing key, mints no approvals, never falls
// back to standalone execution, and never fails open. Every managed tool
// call is authorized by requesting a fresh single-use `acs.dc.v1` capability
// from a separately configured issuer (see README.md for the wire contract);
// if the issuer is unreachable, misconfigured, or returns anything that does
// not match the exact invocation being made, the call is denied before the
// managed child is ever touched.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  ListToolsRequestSchema,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  type CallToolRequest,
  type CallToolResult,
  type InitializeRequest,
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js';
import { createLocalMcpRuntime, LocalMcpRuntimeError, type LocalMcpRuntime } from '../local-runtime.js';
import { isManagedAcsToolName } from '../managed-acs.js';
import { loadOpenClawBridgeConfig, OpenClawBridgeConfigError, type OpenClawBridgeConfig } from './config.js';
import { requestManagedCapability, IssuerClientError } from './issuer-client.js';
import { VERSION } from '../version.js';

const BRIDGE_NAME = 'desktop-commander-openclaw-bridge';

function logError(message: string): void {
  // stdout is the JSON-RPC channel to OpenClaw; all bridge diagnostics go to
  // stderr only, and never include the issuer bearer token (it is only ever
  // read into OpenClawBridgeConfig, never logged).
  process.stderr.write(`[${BRIDGE_NAME}] ${message}\n`);
}

function fail(message: string): never {
  logError(message);
  process.exit(1);
}

function toolCallDenied(code: string, message: string): CallToolResult {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ error: { code, message } }),
    }],
    isError: true,
    _meta: {
      acsAuthorization: {
        version: 'acs.dc.v1',
        mode: 'managed',
        decision: 'denied',
        code,
      },
    },
  };
}

function normalizedToolArguments(rawArguments: unknown): Record<string, unknown> {
  return rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)
    ? rawArguments as Record<string, unknown>
    : {};
}

async function buildServer(config: OpenClawBridgeConfig, runtime: LocalMcpRuntime, runtimeId: string): Promise<Server> {
  const server = new Server(
    { name: BRIDGE_NAME, version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(InitializeRequestSchema, async (request: InitializeRequest) => {
    const requestedVersion = request.params?.protocolVersion;
    const protocolVersion = requestedVersion && SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
      ? requestedVersion
      : LATEST_PROTOCOL_VERSION;

    // Deliberately ignore request.params._meta: OpenClaw's MCP _meta must
    // never reach the managed child. The child gets its own independent
    // bootstrap handshake from createLocalMcpRuntime, unrelated to this one.
    return {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: BRIDGE_NAME, version: VERSION },
    };
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Tool discovery derives entirely from the managed child's own
    // tools/list, which already excludes anything outside the ACS v1
    // allowlist. The bridge adds nothing and hides nothing.
    return await runtime.listTools();
  });

  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest): Promise<ServerResult> => {
    const { name } = request.params;
    const toolArguments = normalizedToolArguments(request.params.arguments);

    // Anything the client sent under _meta (including a forged
    // acsCapability) is dropped here and never inspected or forwarded.

    if (name !== 'get_runtime_identity' && !isManagedAcsToolName(name)) {
      return {
        content: [{ type: 'text', text: `Error: Unknown Desktop Commander tool: ${name}` }],
        isError: true,
      };
    }

    try {
      if (name === 'get_runtime_identity') {
        // No ACS scope guards identity discovery; the managed child grants
        // it without a capability, so the bridge does not consult the
        // issuer for it either.
        return await runtime.callTool(name, toolArguments);
      }

      let capability;
      try {
        capability = await requestManagedCapability(config, {
          runtimeId,
          toolName: name,
          normalizedArguments: toolArguments,
        });
      } catch (error) {
        if (error instanceof IssuerClientError) {
          logError(`issuer denied ${name}: ${error.code} (${error.message})`);
          return toolCallDenied(error.code, 'Desktop Commander OpenClaw bridge denied the tool call: issuer capability request failed');
        }
        throw error;
      }

      return await runtime.callTool(name, toolArguments, undefined, { acsCapability: capability });
    } catch (error) {
      const message = error instanceof LocalMcpRuntimeError
        ? error.message
        : `Desktop Commander OpenClaw bridge failed to execute ${name}: ${error instanceof Error ? error.message : String(error)}`;
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  });

  return server;
}

async function main(): Promise<void> {
  let config: OpenClawBridgeConfig;
  try {
    config = loadOpenClawBridgeConfig();
  } catch (error) {
    if (error instanceof OpenClawBridgeConfigError) fail(error.message);
    throw error;
  }

  // mode defaults to 'managed'; createLocalMcpRuntime forwards the child's
  // ACS public key/key id/scopes/state-dir env vars automatically. This
  // process never constructs or forwards an ACS signing key of its own.
  const runtime = createLocalMcpRuntime();

  let shuttingDown = false;
  const shutdown = async (exitCode: number, server?: Server) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await server?.close().catch(() => undefined);
    await runtime.shutdown().catch(() => undefined);
    process.exit(exitCode);
  };

  try {
    await runtime.start();
  } catch (error) {
    fail(`Failed to start managed Desktop Commander child: ${error instanceof Error ? error.message : String(error)}`);
  }

  const startupHealth = await runtime.health();
  const runtimeId = startupHealth.runtime_identity?.runtime_id;
  if (!startupHealth.ok || !runtimeId) {
    await runtime.shutdown().catch(() => undefined);
    fail('Managed Desktop Commander child did not report a healthy, identified runtime at startup');
    return;
  }

  const server = await buildServer(config, runtime, runtimeId);

  process.once('SIGINT', () => { void shutdown(0, server); });
  process.once('SIGTERM', () => { void shutdown(0, server); });
  process.once('uncaughtException', (error) => {
    logError(`uncaught exception: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    void shutdown(1, server);
  });
  process.once('unhandledRejection', (reason) => {
    logError(`unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
    void shutdown(1, server);
  });

  const transport = new StdioServerTransport();
  transport.onclose = () => { void shutdown(0, server); };
  transport.onerror = (error) => {
    logError(`transport error: ${error.message}`);
    void shutdown(1, server);
  };

  await server.connect(transport);
}

main().catch((error) => {
  logError(`fatal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
