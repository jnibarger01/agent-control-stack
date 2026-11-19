/* global setInterval */
// Test double for Codex Swarm's ACS transport (acs/v1). Not production code.
// Reads the per-attempt MAC secret from fd 3, verifies envelopes exactly as ACS signs them,
// and misbehaves on demand (FAKE_SWARM_MODE) so the ACS adapter's fail-closed paths are exercised.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { lookup } from "node:dns";

const mode = process.env.FAKE_SWARM_MODE ?? "ok";
if (process.env.SWARM_CONTROL_PLANE !== "acs") process.exit(64);
const socketPath = process.env.ACS_SWARM_SOCKET;
const attemptId = process.env.ACS_SWARM_ATTEMPT_ID;
const secret = readFileSync(Number(process.env.ACS_SWARM_SECRET_FD), "utf8").trim();

function normalize(value) {
  if (Array.isArray(value)) return value.map((entry) => (entry === undefined ? null : normalize(entry)));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, normalize(entry)])
    );
  }
  return value;
}
const canonical = (value) => JSON.stringify(normalize(value));
const domainHash = (domain, value) => createHash("sha256").update(domain + "\n" + canonical(value)).digest("hex");

function verify(envelope) {
  if (!envelope || typeof envelope !== "object") return "envelope_not_object";
  const { mac, envelopeHash, ...body } = envelope;
  if (domainHash("acs:codex-swarm-envelope:v1", body) !== envelopeHash) return "envelope_hash_mismatch";
  const expected = createHmac("sha256", secret).update(canonical({ ...body, envelopeHash })).digest("hex");
  const a = Buffer.from(String(mac), "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return "envelope_mac_mismatch";
  if (Date.parse(envelope.expiresAt) <= Date.now()) return "envelope_expired";
  if (envelope.acsAttemptId !== attemptId) return "envelope_attempt_mismatch";
  return null;
}

function evidence(envelope) {
  const now = new Date().toISOString();
  return {
    schemaVersion: "acs.codex-swarm-evidence.v1",
    acsAttemptId: mode === "wrong-echo" ? "attempt_other" : envelope.acsAttemptId,
    envelopeHash: envelope.envelopeHash,
    leaseId: envelope.leaseId,
    fencingEpoch: mode === "stale-epoch" ? envelope.fencingEpoch - 1 : envelope.fencingEpoch,
    exitStatus: "completed",
    startedAt: now,
    endedAt: now,
    laneResults: [],
    integration: null,
    aggregateVerdict: "PASS",
    swarmInternalRecommendationIdentity: null,
    loopIterationsRun: 0,
    loopStopReason: null,
    evidenceBundle: { auditEventCount: 0, auditLogHash: "0".repeat(64), diffHash: "0".repeat(64) }
  };
}

// Adversarial escape attempts, run from inside the codex-swarm-v1 sandbox. Each field records what
// the sandbox ALLOWED, so the host-side test can assert every one is denied.
async function probe(secretValue) {
  const attempt = (fn) => {
    try {
      fn();
      return true;
    } catch {
      return false;
    }
  };
  const connects = (host, port) =>
    new Promise((resolve) => {
      const socket = connect({ host, port, timeout: 1_500 });
      socket.on("connect", () => (socket.destroy(), resolve(true)));
      socket.on("error", () => resolve(false));
      socket.on("timeout", () => (socket.destroy(), resolve(false)));
    });
  const resolves = (name) => new Promise((resolve) => lookup(name, (error) => resolve(!error)));
  const fds = readdirSync("/proc/self/fd")
    .map((fd) => {
      try {
        return readlinkSync("/proc/self/fd/" + fd);
      } catch {
        return "";
      }
    })
    .filter((target) => target.startsWith("/home") || target.startsWith("/root") || target.includes(".ssh"));
  const results = {
    hostHomeVisible: existsSync("/home"),
    symlinkEscapeRead: attempt(() => readFileSync("/workspace/escape-link")),
    writeOutsideWorkspace: attempt(() => writeFileSync("/usr/acs-probe", "x")),
    hostEtcPasswdVisible: existsSync("/etc/passwd"),
    hostProcessesVisible: readdirSync("/proc").filter((name) => /^\d+$/u.test(name)).length > 64,
    hostFdsInherited: fds,
    tcpEgress: await connects("1.1.1.1", 443),
    dnsResolution: await resolves("example.com"),
    envKeys: Object.keys(process.env).sort(),
    pwd: process.env.PWD,
    secretInEnv: Object.values(process.env).some((value) => value === secretValue),
    secretInCmdline: readFileSync("/proc/self/cmdline", "utf8").includes(secretValue)
  };
  // Task-quota probe last: once the scope is at TasksMax even Node's own threads cannot start.
  const children = [];
  for (let i = 0; i < 64; i++) {
    try {
      const child = spawn("/bin/sleep", ["5"], { stdio: "ignore" });
      child.on("error", () => undefined);
      children.push(child);
    } catch {
      break;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  const alive = children.filter((child) => child.exitCode === null && child.pid).length;
  for (const child of children) child.kill("SIGKILL");
  results.aliveChildrenUnderTaskLimit = alive;
  return results;
}

if (mode === "never-ready") setInterval(() => undefined, 1_000);
else {
  if (mode === "ignore-sigterm") {
    // A lane grandchild that ignores SIGTERM: only a process-group SIGKILL removes it.
    spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
    process.on("SIGTERM", () => undefined);
  }
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const message = JSON.parse(buffer.slice(0, newline));
      if (message.method === "ready") {
        socket.end(JSON.stringify({ ok: true, protocol: "acs/v1", attemptId: mode === "ready-mismatch" ? "x" : attemptId }) + "\n");
        return;
      }
      if (message.method !== "execute") return socket.end(JSON.stringify({ ok: false, error: "unsupported_method" }) + "\n");
      if (message.secret !== undefined) return socket.end(JSON.stringify({ ok: false, error: "secret_on_wire" }) + "\n");
      if (mode === "hang") return;
      if (mode === "crash") process.exit(70);
      if (mode === "garbage") return socket.end("not json\n");
      if (mode === "env-leak-probe") {
        const leaked = Object.values(process.env).some((value) => value === secret);
        return socket.end(JSON.stringify({ ok: false, error: leaked ? "secret_in_env" : "secret_not_in_env" }) + "\n");
      }
      const refusal = verify(message.envelope);
      if (refusal) return socket.end(JSON.stringify({ ok: false, error: refusal }) + "\n");
      if (mode === "fence-mutate" || mode === "fence-forged") {
        const fenceName = process.env.ACS_SWARM_FENCE_SOCKET_NAME;
        if (!fenceName) return socket.end(JSON.stringify({ ok: false, error: "fence_unavailable" }) + "\n");
        const ask = {
          method: "fence",
          acsAttemptId: message.envelope.acsAttemptId,
          leaseId: message.envelope.leaseId,
          fencingEpoch: mode === "fence-forged" ? message.envelope.fencingEpoch + 1 : message.envelope.fencingEpoch
        };
        const fence = connect(socketPath.slice(0, socketPath.lastIndexOf("/") + 1) + fenceName);
        let reply = "";
        fence.setEncoding("utf8");
        fence.on("connect", () => fence.write(JSON.stringify(ask) + "\n"));
        fence.on("data", (chunk) => (reply += chunk));
        fence.on("end", () => {
          const answer = JSON.parse(reply);
          // A mutating lane action proceeds only while ACS says the attempt is current.
          if (answer.current !== true) return socket.end(JSON.stringify({ ok: false, error: "fence_lost" }) + "\n");
          socket.end(JSON.stringify({ ok: true, evidence: evidence(message.envelope) }) + "\n");
        });
        return;
      }
      if (mode === "sandbox-probe") {
        return void probe(secret).catch((error) => ({ probeError: String(error && error.stack || error) })).then((results) => {
          writeFileSync("/workspace/probe.json", JSON.stringify(results));
          socket.end(JSON.stringify({ ok: true, evidence: evidence(message.envelope) }) + "\n");
        });
      }
      socket.end(JSON.stringify({ ok: true, evidence: evidence(message.envelope) }) + "\n");
    });
  });
  try {
    unlinkSync(socketPath);
  } catch {
    // No stale socket to remove.
  }
  server.listen(socketPath);
}
