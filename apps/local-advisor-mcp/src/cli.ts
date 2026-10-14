#!/usr/bin/env node
import { assertDirectLoopbackEgress, type AdvisorRequest } from "@agent-control-stack/local-advisor";
import { createAdvise } from "./advise.js";
import { LocalAdvisorMcpServer } from "./server.js";

/**
 * stdio MCP server. Does not listen on a port and does not edit client config.
 *
 *   ACS_LOCAL_ADVISOR_MODEL=qwen2.5-coder:7b          pin one installed model
 *   ACS_LOCAL_ADVISOR_EXPECTED_DIGEST=sha256:<64hex>  optional pin
 *   ACS_LOCAL_ADVISOR_BASE_URL=http://127.0.0.1:11434 loopback only
 *   ACS_LOCAL_ADVISOR_ROUTES=<json>                  overrides DEFAULT_MODEL_ROUTES when MODEL is unset
 *   ACS_LOCAL_ADVISOR_MIN_FREE_BYTES=<n>             refuse inference under memory pressure
 */
// Fail closed at startup if env proxy mode could carry loopback advisor traffic to a proxy.
assertDirectLoopbackEgress(process.env, process.execArgv);

const advise = createAdvise(process.env);

const server = new LocalAdvisorMcpServer(process.stdin, process.stdout, (request, signal) =>
  advise(request as AdvisorRequest, signal)
);

process.on("SIGINT", () => {
  server.stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  server.stop();
  process.exit(0);
});

server.start();
