// Compares the TypeScript and Rust supervision paths on identical live
// workloads, and the TypeScript and Rust egress relays on identical traffic.
// Run from the repository root after `tsc -b packages/sandbox` and a release
// build of this crate. Requires the live sandbox prerequisites.
//
//   node rust/scope-supervisor/benchmark.mjs [iterations]
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  createLinuxSandbox,
  defaultRustSupervisorPath,
  rustEgressRelayPath,
  startEgressProxy,
  startRustEgressRelay
} from "../../packages/sandbox/dist/index.js";

const iterations = Number(process.argv[2] ?? 30);
const scratch = mkdtempSync(join(tmpdir(), "acs-supervisor-bench-"));

function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

function summary(values) {
  return { n: values.length, p50: +quantile(values, 0.5).toFixed(2), p95: +quantile(values, 0.95).toFixed(2) };
}

// Samples the helper's peak RSS (VmHWM) without changing its stdio.
const rssLog = join(scratch, "rss.log");
const wrapperDir = join(scratch, "bin");
mkdirSync(wrapperDir);
const wrapper = join(wrapperDir, "acs-scope-supervisor");
writeFileSync(
  wrapper,
  `#!/bin/bash
"${defaultRustSupervisorPath}" "$@" 0<&0 &
pid=$!
peak=0
while kill -0 $pid 2>/dev/null; do
  v=$(awk '/VmHWM/{print $2}' /proc/$pid/status 2>/dev/null)
  [ -n "$v" ] && peak=$v
  sleep 0.002
done
wait $pid; code=$?
echo $peak >> "${rssLog}"
exit $code
`
);
chmodSync(wrapper, 0o755);

function request(workspace, suffix) {
  return {
    schemaVersion: "acs.sandbox-execution.v1",
    workItemId: `wrk_${suffix}`,
    attemptId: `attempt_${suffix}`,
    leaseId: `lease_${suffix}`,
    workerId: "worker_bench",
    fencingToken: 1,
    authorization: { kind: "action", hash: "a".repeat(64) },
    policyVersion: "policy-v1",
    auditCorrelationId: `evt_${suffix}`,
    idempotencyKey: `bench-${suffix}`,
    workspace: { allocationId: `ws_${suffix}`, hostPath: workspace },
    commandProfile: "npm-test",
    cwd: ".",
    environment: { CI: "1", LANG: "C.UTF-8" },
    network: "none",
    limits: {
      wallClockMs: 30_000,
      terminationGraceMs: 500,
      cpuQuotaPercent: 100,
      memoryBytes: 512 * 1_024 * 1_024,
      pids: 64,
      outputBytes: 1_024 * 1_024,
      tmpfsBytes: 64 * 1_024 * 1_024
    }
  };
}

function authority(req) {
  return {
    verify: async () => ({
      schemaVersion: "acs.sandbox-authority-receipt.v1",
      workItemId: req.workItemId,
      attemptId: req.attemptId,
      leaseId: req.leaseId,
      workerId: req.workerId,
      fencingToken: req.fencingToken,
      authorizationHash: req.authorization.hash,
      policyVersion: req.policyVersion,
      workspaceAllocationId: req.workspace.allocationId,
      canonicalWorkspacePath: req.workspace.hostPath,
      executionEvent: { id: req.auditCorrelationId, sequence: 1, hash: "b".repeat(64) }
    })
  };
}

async function sandboxWorkload(name, source) {
  const workspace = join(scratch, `ws-${name}`);
  mkdirSync(workspace, { mode: 0o700 });
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({ private: true, type: "module", scripts: { test: "node test.mjs" } })
  );
  writeFileSync(join(workspace, "test.mjs"), source);
  const backends = {
    typescript: createLinuxSandbox({
      authorityVerifier: { verify: async (r) => authority(r).verify() },
      scopeSupervisor: { backend: "typescript" }
    }),
    rust: createLinuxSandbox({
      authorityVerifier: { verify: async (r) => authority(r).verify() },
      scopeSupervisor: { backend: "rust" }
    })
  };
  // Memory is sampled in a separate pass so the sampling wrapper never affects timing.
  const sampled = createLinuxSandbox({
    authorityVerifier: { verify: async (r) => authority(r).verify() },
    scopeSupervisor: { backend: "rust", binaryPath: wrapper }
  });
  const times = { typescript: [], rust: [] };
  let outputBytes = 0;
  for (let i = -3; i < iterations; i += 1) {
    const order = i % 2 === 0 ? ["typescript", "rust"] : ["rust", "typescript"];
    for (const backend of order) {
      const req = request(workspace, `${name}_${backend}_${i + 3}`);
      const started = performance.now();
      const result = await backends[backend].execute(req);
      const elapsed = performance.now() - started;
      if (!result.observedSuccess) throw new Error(`${backend} ${name} failed: ${result.error}`);
      outputBytes = result.outputBytes;
      if (i >= 0) times[backend].push(elapsed);
    }
  }
  for (let i = 0; i < 5; i += 1) await sampled.execute(request(workspace, `${name}_rss_${i}`));
  const rss = readFileSync(rssLog, "utf8").trim().split("\n").map(Number);
  rmSync(rssLog, { force: true });
  return {
    workload: name,
    outputBytes,
    typescriptMs: summary(times.typescript),
    rustMs: summary(times.rust),
    rustHelperPeakRssKiB: { p50: quantile(rss, 0.5), max: Math.max(...rss) }
  };
}

async function relayBenchmark() {
  const payload = Buffer.alloc(64 * 1_024 * 1_024, 7);
  const dest = createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", (first) => {
      if (first.toString() === "bulk") socket.end(payload);
      else socket.end("pong");
    });
  });
  await new Promise((resolve) => dest.listen(0, "127.0.0.1", resolve));
  const port = dest.address().port;
  const results = [];
  for (const [name, start] of [
    ["typescript", (opts) => startEgressProxy(opts)],
    ["rust", (opts) => startRustEgressRelay(rustEgressRelayPath({ backend: "rust" }), opts, {})]
  ]) {
    const socketPath = join(scratch, `${name}.sock`);
    const handle = await start({ socketPath, allowlist: [{ host: "127.0.0.1", port }] });
    const exchange = (message) =>
      new Promise((resolve, reject) => {
        let received = 0;
        let established = false;
        const socket = createConnection(socketPath, () => socket.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\n\r\n`));
        socket.on("data", (chunk) => {
          if (!established) {
            established = true;
            const header = chunk.indexOf("\r\n\r\n");
            received += chunk.length - header - 4;
            socket.write(message);
          } else received += chunk.length;
        });
        socket.on("close", () => resolve(received));
        socket.on("error", reject);
      });
    const latencies = [];
    for (let i = 0; i < 200; i += 1) {
      const started = performance.now();
      await exchange("ping");
      latencies.push(performance.now() - started);
    }
    const started = performance.now();
    const bytes = await exchange("bulk");
    const seconds = (performance.now() - started) / 1_000;
    await handle.close();
    results.push({
      relay: name,
      connectRoundTripMs: summary(latencies.slice(20)),
      bulkBytes: bytes,
      throughputMiBps: +(bytes / 1_048_576 / seconds).toFixed(1)
    });
  }
  await new Promise((resolve) => dest.close(resolve));
  return results;
}

try {
  const host = {
    node: process.version,
    kernel: execFileSync("uname", ["-r"], { encoding: "utf8" }).trim(),
    cpu: execFileSync("sh", ["-c", "lscpu | sed -n 's/^Model name: *//p'"], { encoding: "utf8" }).trim(),
    iterations
  };
  const sandbox = [
    await sandboxWorkload("small-output", `console.log("x".repeat(1024));`),
    await sandboxWorkload("max-output", `process.stdout.write("y".repeat(1024 * 1024));`)
  ];
  const relay = await relayBenchmark();
  console.log(JSON.stringify({ host, sandbox, relay }, null, 2));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
