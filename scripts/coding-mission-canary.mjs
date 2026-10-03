import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";

if (process.env.ACS_CODING_CANARY !== "1") {
  console.log("coding mission canary skipped; set ACS_CODING_CANARY=1 to run it");
  process.exit(0);
}

const root = new URL("..", import.meta.url).pathname;
const owner = "jnibarger01";
const repoName = `acs-coding-canary-${Date.now().toString(36)}`;
const repository = `${owner}/${repoName}`;
const missionId = `canary-${Date.now().toString(36)}`;
const gatewayToken = randomBytes(24).toString("hex");
const work = mkdtempSync(join(tmpdir(), "acs-coding-canary-"));
const checkoutRoot = join(work, "checkouts");
const checkout = join(checkoutRoot, owner, repoName);
const dbPath = join(work, "control.db");
const counts = { postPulls: 0, mergeAttempts: 0, mergeForwarded: 0, postDeploy: 0, mergeAborted: 0 };
let githubToken = "";

const children = [];
let nimble;
let proxy;

function timeoutSignal(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}

function redact(text) {
  return String(text)
    .replaceAll(gatewayToken, "[gateway]")
    .replaceAll(githubToken, "[github]")
    .replace(/gho_[A-Za-z0-9_]+/gu, "[github]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gu, "Bearer [redacted]");
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: process.env, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}: ${redact(stderr || stdout)}`));
    });
  });
}

function startProcess(script, env) {
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  child.stdout.on("data", (chunk) => {
    log += chunk;
  });
  child.stderr.on("data", (chunk) => {
    log += chunk;
  });
  children.push(child);
  return {
    child,
    log: () => redact(log).slice(-4000)
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("could not reserve a port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("canary listener did not bind");
  return address.port;
}

function startNimble() {
  nimble = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          model: body.model,
          answers: { appropriate: { type: "noul", noul: 0.91 } }
        })
      );
    });
  });
  return listen(nimble);
}

function startProxy() {
  proxy = createServer(async (request, response) => {
    if (request.url === "/__canary") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(counts));
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    await new Promise((resolve) => request.on("end", resolve));
    const path = request.url ?? "/";
    const method = request.method ?? "GET";
    if (method === "PUT" && path.includes("/merge")) {
      counts.mergeAttempts += 1;
      if (counts.mergeAttempts === 1) {
        let clientGone = false;
        const mark = () => {
          clientGone = true;
        };
        request.on("aborted", mark);
        request.socket.on("close", mark);
        await sleep(8_000);
        if (clientGone || request.aborted || request.destroyed) {
          counts.mergeAborted += 1;
          if (!response.writableEnded) response.end();
          return;
        }
      }
      counts.mergeForwarded += 1;
    }
    if (method === "POST" && path.endsWith("/pulls")) counts.postPulls += 1;
    if (method === "POST" && path.includes("/deployments")) counts.postDeploy += 1;
    const headers = {
      accept: request.headers.accept ?? "application/vnd.github+json",
      authorization: request.headers.authorization ?? "",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "acs-coding-canary"
    };
    const upstream = await fetch(`https://api.github.com${path}`, {
      method,
      headers,
      ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) })
    });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json"
    });
    response.end(bytes);
  });
  return listen(proxy);
}

async function registerCoder() {
  const { SqliteWorkItemStore } = await import("../packages/work-items/dist/index.js");
  const store = new SqliteWorkItemStore(dbPath);
  store.registerActor({ id: "canary-user", actorType: "HUMAN", displayName: "Canary" });
  store.createRegistryAgent({
    id: "canary-coder",
    name: "Canary Coder",
    kind: "coding",
    acpRole: "IMPLEMENTATION_AGENT",
    actorId: "canary-user",
    status: "AVAILABLE"
  });
  store.replaceAgentCapabilities("canary-coder", [{ name: "coding" }], "canary-user");
  store.recordAgentHeartbeat("canary-coder", { actorId: "canary-user", status: "AVAILABLE" });
  store.close();
}

function runtimeEnv(port, nimblePort, proxyPort) {
  return {
    ACS_DB_PATH: dbPath,
    ACS_CODING_CHECKOUT_ROOT: checkoutRoot,
    ACS_GITHUB_TOKEN: githubToken,
    ACS_GITHUB_API: `http://127.0.0.1:${proxyPort}`,
    ACS_CODING_VALIDATE_COMMAND: "git diff --check",
    ACS_CODING_NIMBLE_URL: `http://127.0.0.1:${nimblePort}/v1/systemone`,
    ACS_GATEWAY_TOKEN: gatewayToken,
    HOST: "127.0.0.1",
    PORT: String(port),
    NODE_ENV: "development"
  };
}

async function waitForGateway(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/coding-missions`, {
        headers: { authorization: `Bearer ${gatewayToken}` }
      });
      if (response.status === 200) return;
    } catch {
      // gateway is still binding
    }
    await sleep(200);
  }
  throw new Error("gateway did not become ready");
}

function missionRow() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const mission = db.prepare("SELECT state, change_set_hash, pr_number, merge_sha, deployment_id FROM coding_missions").get();
    const completions = db.prepare("SELECT COUNT(*) AS count FROM coding_events WHERE name = ?").get("coding_mission.completed");
    return { mission, completions: completions.count };
  } finally {
    db.close();
  }
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("close", resolve));
}

try {
  githubToken = (await run("gh", ["auth", "token"])).trim();
  await run("gh", ["repo", "create", repoName, "--private", "--add-readme", "--description", "temporary ACS coding mission canary"]);
  await run("git", ["clone", `https://github.com/${repository}.git`, checkout], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const baseSha = await run("git", ["rev-parse", "HEAD"], { cwd: checkout });
  const baseRef = await run("git", ["branch", "--show-current"], { cwd: checkout });
  const nimblePort = await startNimble();
  const proxyPort = await startProxy();
  await registerCoder();
  const gatewayPort = await freePort();
  let gateway = startProcess("apps/gateway/dist/cli.js", runtimeEnv(gatewayPort, nimblePort, proxyPort));
  try {
    await waitForGateway(gatewayPort);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : "gateway failed"}\n${gateway.log()}`, { cause: error });
  }
  const created = await fetch(`http://127.0.0.1:${gatewayPort}/coding-missions`, {
    method: "POST",
    headers: { authorization: `Bearer ${gatewayToken}`, "content-type": "application/json" },
    body: JSON.stringify({ missionId, repository, baseRef, baseSha, summary: "Canary manifest" }),
    signal: timeoutSignal(90_000)
  });
  const createdBody = await created.json();
  if (created.status !== 201 || createdBody.state !== "WAITING_FOR_APPROVAL") {
    throw new Error(`preparation did not stop for approval (${created.status}): ${redact(JSON.stringify(createdBody))}\n${gateway.log()}`);
  }
  const displayedHash = createdBody.changeSet;
  if (!/^[a-f0-9]{64}$/u.test(displayedHash)) throw new Error("approval response did not display a change-set hash");
  const before = await run("gh", ["pr", "view", String(createdBody.pullRequest.number), "--repo", repository, "--json", "state,mergedAt,url"]);
  const beforePull = JSON.parse(before);
  if (beforePull.mergedAt !== null || beforePull.state !== "OPEN") {
    throw new Error(`pull request was not an open unmerged proposal: ${before}`);
  }
  if (counts.mergeForwarded !== 0 || counts.postDeploy !== 0 || counts.postPulls !== 1) {
    throw new Error(`unexpected external effects before approval: ${JSON.stringify(counts)}`);
  }
  await stopChild(gateway.child);
  const pausedWorker = startProcess("apps/worker/dist/cli.js", runtimeEnv(gatewayPort, nimblePort, proxyPort));
  const pausedCode = await new Promise((resolve) => pausedWorker.child.once("close", resolve));
  if (pausedCode !== 0) throw new Error(`paused worker failed\n${pausedWorker.log()}`);
  const paused = missionRow();
  if (paused.mission.state !== "WAITING_FOR_APPROVAL" || paused.mission.change_set_hash !== displayedHash) {
    throw new Error(`restart changed the waiting proposal: ${JSON.stringify(paused)}`);
  }
  if (counts.mergeForwarded !== 0 || counts.postDeploy !== 0) {
    throw new Error(`restart performed a mutation before approval: ${JSON.stringify(counts)}`);
  }
  gateway = startProcess("apps/gateway/dist/cli.js", runtimeEnv(gatewayPort, nimblePort, proxyPort));
  await waitForGateway(gatewayPort);
  const listed = await fetch(`http://127.0.0.1:${gatewayPort}/coding-missions/${missionId}`, {
    headers: { authorization: `Bearer ${gatewayToken}` }
  });
  const view = await listed.json();
  if (view.changeSet !== displayedHash || view.approvalAction !== "APPROVE_CHANGE_SET") {
    throw new Error(`refreshed proposal changed: ${redact(JSON.stringify(view))}`);
  }
  const approval = fetch(`http://127.0.0.1:${gatewayPort}/coding-missions/${missionId}/approve`, {
    method: "POST",
    headers: { authorization: `Bearer ${gatewayToken}`, "content-type": "application/json" },
    body: JSON.stringify({ expectedChangeSetHash: displayedHash }),
    signal: timeoutSignal(30_000)
  }).catch((error) => error);
  for (let attempt = 0; attempt < 80 && counts.mergeAttempts < 1; attempt += 1) await sleep(250);
  if (counts.mergeAttempts < 1) throw new Error(`merge was not attempted\n${gateway.log()}`);
  await stopChild(gateway.child);
  await approval;
  const recovering = startProcess("apps/worker/dist/cli.js", runtimeEnv(gatewayPort, nimblePort, proxyPort));
  const recoveredCode = await new Promise((resolve) => recovering.child.once("close", resolve));
  if (recoveredCode !== 0) throw new Error(`recovery worker failed\n${recovering.log()}`);
  const completed = missionRow();
  if (completed.mission.state !== "COMPLETED" || completed.completions !== 1 || completed.mission.deployment_id) {
    throw new Error(`completion evidence mismatch: ${JSON.stringify(completed)} counts ${JSON.stringify(counts)}\n${recovering.log()}`);
  }
  const replay = startProcess("apps/worker/dist/cli.js", runtimeEnv(gatewayPort, nimblePort, proxyPort));
  const replayCode = await new Promise((resolve) => replay.child.once("close", resolve));
  if (replayCode !== 0) throw new Error(`replay worker failed\n${replay.log()}`);
  const afterReplay = missionRow();
  const merged = JSON.parse(
    await run("gh", ["pr", "view", String(createdBody.pullRequest.number), "--repo", repository, "--json", "state,mergedAt,mergeCommit,url"])
  );
  const deployments = JSON.parse(await run("gh", ["api", `repos/${repository}/deployments`]));
  if (
    afterReplay.completions !== 1 ||
    counts.mergeForwarded !== 1 ||
    counts.postDeploy !== 0 ||
    counts.postPulls !== 1 ||
    merged.state !== "MERGED" ||
    merged.mergedAt === null ||
    deployments.length !== 0
  ) {
    throw new Error(
      `side-effect mismatch counts=${JSON.stringify(counts)} events=${afterReplay.completions} merged=${merged.merged} deployments=${deployments.length}`
    );
  }
  console.log(
    JSON.stringify({
      repository,
      missionId,
      pullRequest: beforePull.url,
      changeSetHash: displayedHash,
      mergeSha: completed.mission.merge_sha,
      state: afterReplay.mission.state,
      completionEvents: afterReplay.completions,
      pullRequestsCreated: counts.postPulls,
      mergesForwarded: counts.mergeForwarded,
      mergesAbortedBeforeForward: counts.mergeAborted,
      deployments: counts.postDeploy,
      nimble: "loopback fixture speaking the noul protocol"
    })
  );
} finally {
  for (const child of children) {
    if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
  }
  proxy?.close();
  nimble?.close();
  await run("gh", ["repo", "delete", repository, "--yes"]).catch((error) => {
    console.error(redact(error instanceof Error ? error.message : String(error)));
  });
  rmSync(work, { recursive: true, force: true });
}
