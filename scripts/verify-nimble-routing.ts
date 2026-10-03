import { probeNimbleRouting, resolveNimbleRoutingConfig } from "@agent-control-stack/actor-router";

const config = resolveNimbleRoutingConfig({ ...process.env, ACS_NIMBLE_ROUTING_ENABLED: "1" });
const health = await probeNimbleRouting(config);
const timed = await probeNimbleRouting({ ...config, timeoutMs: 1 });
const report = {
  url: config.url,
  configuredModel: config.model,
  health,
  timeoutProbe: timed,
  ready: health.ok && timed.ok === false && timed.code === "timeout"
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ready) process.exitCode = 1;
