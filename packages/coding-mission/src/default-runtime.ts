import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { DEFAULT_NIMBLE_ROUTING_MODEL, DEFAULT_NIMBLE_ROUTING_URL } from "@agent-control-stack/actor-router";
import { GitHubPullRequestClient } from "@agent-control-stack/publication/github";
import { ControlStackError } from "@agent-control-stack/shared";
import { SqliteWorkItemStore, type RegistryAgentDetail } from "@agent-control-stack/work-items";
import { CodingMissionController, type CodingMissionPorts, type ExternalOutcome } from "./controller.js";
import { routeCodingOperationWithNimble } from "./routing.js";
import type { CodingMissionRecord, ValidationEvidence } from "./store.js";

const REPOSITORY = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u;
const REF = /^[A-Za-z0-9._/-]{1,256}$/u;
const MARKER = ".acs/coding-mission.json";

export interface GitRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type GitRunner = (
  checkout: string,
  args: readonly string[],
  options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }
) => Promise<GitRunResult>;

export interface CodingRuntimeConfig {
  token: string;
  checkoutRoot: string;
  apiBase: string;
  validateCommand?: string;
  deployPolicy: Record<string, { required: boolean; action: string; impact: string }>;
  nimbleUrl: string;
  nimbleModel: string;
  nimbleThreshold: number;
  nimbleTimeoutMs: number;
}

export interface CodingRuntimeDependencies {
  dbPath: string;
  fetchImpl?: typeof fetch;
  git?: GitRunner;
  now?: () => string;
}

interface PullRecord {
  number?: number;
  html_url?: string;
  merged?: boolean;
  merge_commit_sha?: string | null;
  head?: { sha?: string };
}

/** Ports are active only when a token and a checkout root are both configured. */
export function readCodingRuntimeConfig(env: NodeJS.ProcessEnv): CodingRuntimeConfig | undefined {
  const token = env.ACS_GITHUB_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN;
  const checkoutRoot = env.ACS_CODING_CHECKOUT_ROOT?.trim();
  if (!token || !checkoutRoot) return undefined;
  const threshold = Number(env.ACS_CODING_NIMBLE_THRESHOLD ?? "0.8");
  const timeoutMs = Number(env.ACS_CODING_NIMBLE_TIMEOUT_MS ?? "1200");
  return {
    token,
    checkoutRoot: resolve(checkoutRoot),
    apiBase: (env.ACS_GITHUB_API?.trim() || "https://api.github.com").replace(/\/$/u, ""),
    ...(env.ACS_CODING_VALIDATE_COMMAND?.trim() ? { validateCommand: env.ACS_CODING_VALIDATE_COMMAND.trim() } : {}),
    deployPolicy: parseDeployPolicy(env.ACS_CODING_DEPLOY_POLICY),
    nimbleUrl: env.ACS_CODING_NIMBLE_URL?.trim() || DEFAULT_NIMBLE_ROUTING_URL,
    nimbleModel: env.ACS_CODING_NIMBLE_MODEL?.trim() || DEFAULT_NIMBLE_ROUTING_MODEL,
    nimbleThreshold: Number.isFinite(threshold) ? threshold : 0.8,
    nimbleTimeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 1_200
  };
}

export function codingMissionPortsFromEnv(
  env: NodeJS.ProcessEnv,
  dependencies: CodingRuntimeDependencies
): CodingMissionPorts | undefined {
  const config = readCodingRuntimeConfig(env);
  if (!config) return undefined;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const git = dependencies.git ?? runGit;
  const now = dependencies.now ?? (() => new Date().toISOString());
  return {
    now,
    deploymentPolicy: {
      requirement(repository: string) {
        const entry = config.deployPolicy[repository];
        if (!entry) return { required: false, action: "none", impact: "no runtime mutation" };
        if (entry.required && entry.action !== "github_deployment") {
          throw new ControlStackError(
            "coding_mission_deployment_unconfigured",
            "repository deployment action is not a configured adapter"
          );
        }
        return entry.required
          ? { required: true, action: "github_deployment", impact: entry.impact }
          : { required: false, action: "none", impact: entry.impact };
      }
    },
    planner: {
      decompose: () => [{ operationId: "prepare", dependsOn: [], title: "prepare" }]
    },
    router: {
      route: async ({ mission, operation }) => {
        const agents = loadCodingAgents(dependencies.dbPath);
        return routeCodingOperationWithNimble(
          {
            agents,
            requiredCapabilities: ["coding"],
            taskType: "coding",
            now: new Date(now()),
            freeCapacity: Object.fromEntries(agents.map((agent) => [agent.id, 1])),
            stateForAgent: (agent) => nimbleState(mission, operation.title, agent)
          },
          {
            url: config.nimbleUrl,
            model: config.nimbleModel,
            threshold: config.nimbleThreshold,
            timeoutMs: config.nimbleTimeoutMs,
            fetchImpl
          }
        );
      }
    },
    coder: {
      execute: ({ mission, workerId }) => executeMarker(config, git, mission, workerId),
      observe: ({ mission }) => observeMarker(config, git, mission)
    },
    reconciler: {
      reconcile: async ({ mission }) => reconcileCheckout(config, git, mission)
    },
    validator: {
      validate: ({ mission }) => validateCheckout(config, mission)
    },
    publisher: {
      publish: ({ mission, headSha }) => publishProposal(config, git, fetchImpl, mission, headSha),
      observe: ({ mission }) => observeProposal(config, fetchImpl, mission)
    },
    baseObserver: {
      currentBaseSha: (repository, baseRef) => observeBaseSha(config, git, repository, baseRef)
    },
    admission: {
      acquire: async (mission) => ({
        permitId: `coding:${mission.missionId}:${mission.approvedChangeSetHash ?? ""}`
      })
    },
    merger: {
      merge: ({ mission }) => mergeProposal(config, fetchImpl, mission),
      observe: ({ mission }) => observeMerge(config, fetchImpl, mission)
    },
    deployer: {
      deploy: ({ mission, mergeSha }) => deployMerge(config, fetchImpl, mission, mergeSha),
      observe: ({ mission }) => observeDeployment(config, fetchImpl, mission)
    },
    verifier: {
      verify: ({ mission }) => verifyMission(config, fetchImpl, mission)
    }
  };
}

/** Missing runtime config is a no-op so the work-item loop still runs. */
export async function resumeConfiguredCodingMissions(
  dbPath: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const ports = codingMissionPortsFromEnv(env, { dbPath });
  if (!ports) return;
  const controller = new CodingMissionController(dbPath, ports);
  try {
    await controller.resumeAll();
  } finally {
    controller.close();
  }
}

export async function runGit(
  checkout: string,
  args: readonly string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<GitRunResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn("git", [...args], {
      cwd: checkout,
      env: options.env ?? gitProcessEnv(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < 64_000) stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 64_000) stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    const finish = (result: GitRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    child.on("error", () => finish({ code: null, stdout, stderr, timedOut: false }));
    child.on("close", (code, signal) => {
      finish({ code, stdout, stderr, timedOut: signal === "SIGKILL" || code === null });
    });
  });
}

async function executeMarker(
  config: CodingRuntimeConfig,
  git: GitRunner,
  mission: CodingMissionRecord,
  workerId: string
): Promise<ExternalOutcome<{ resultHash: string; files: string[] }>> {
  const checkout = openCheckout(config, mission.repository);
  if (!checkout) return { status: "rejected", code: "checkout_missing" };
  const prepared = await ensureBranch(git, checkout, mission);
  if (prepared.status !== "succeeded")
    return { status: prepared.status, ...(prepared.code ? { code: prepared.code } : {}) };
  const dirty = await porcelain(git, checkout);
  if (dirty.status !== "succeeded") return { status: dirty.status, ...(dirty.code ? { code: dirty.code } : {}) };
  if (dirty.value) return { status: "rejected", code: "conflict" };
  const markerPath = resolve(checkout, MARKER);
  const existing = readMarker(markerPath);
  if (existing?.missionId === mission.missionId) {
    return succeeded({ resultHash: sha256(existing.raw), files: [MARKER] });
  }
  if (existing) return { status: "rejected", code: "conflict" };
  const body = `${JSON.stringify({ missionId: mission.missionId, summary: mission.summary, workerId }, null, 2)}\n`;
  mkdirSync(resolve(checkout, ".acs"), { recursive: true });
  writeFileSync(markerPath, body, "utf8");
  const added = await git(checkout, ["add", "--", MARKER]);
  if (added.timedOut) return { status: "unknown" };
  if (added.code !== 0) return { status: "rejected", code: "commit_failed" };
  const committed = await git(checkout, [
    "-c",
    "user.name=ACS Coding Mission",
    "-c",
    "user.email=acs-coding-mission@localhost",
    "commit",
    "-m",
    `acs coding mission ${mission.missionId}`
  ]);
  if (committed.timedOut) return { status: "unknown" };
  if (committed.code !== 0) return { status: "rejected", code: "commit_failed" };
  return succeeded({ resultHash: sha256(body), files: [MARKER] });
}

async function observeMarker(
  config: CodingRuntimeConfig,
  git: GitRunner,
  mission: CodingMissionRecord
): Promise<ExternalOutcome<{ resultHash: string; files: string[] }>> {
  const checkout = openCheckout(config, mission.repository);
  if (!checkout) return { status: "unknown" };
  const branch = await git(checkout, ["show-ref", "--verify", "--quiet", `refs/heads/${mission.branch}`]);
  if (branch.timedOut || branch.code === null) return { status: "unknown" };
  if (branch.code !== 0) return { status: "absent" };
  const switched = await git(checkout, ["checkout", mission.branch]);
  if (switched.timedOut || switched.code === null) return { status: "unknown" };
  if (switched.code !== 0) return { status: "unknown" };
  const dirty = await porcelain(git, checkout);
  if (dirty.status !== "succeeded") return { status: "unknown" };
  if (dirty.value) return { status: "unknown" };
  const existing = readMarker(resolve(checkout, MARKER));
  if (existing?.missionId !== mission.missionId) return { status: "absent" };
  return succeeded({ resultHash: sha256(existing.raw), files: [MARKER] });
}

async function reconcileCheckout(
  config: CodingRuntimeConfig,
  git: GitRunner,
  mission: CodingMissionRecord
): Promise<ExternalOutcome<{ headSha: string; conflicts: string[] }>> {
  const checkout = openCheckout(config, mission.repository);
  if (!checkout) return { status: "rejected", code: "checkout_missing" };
  const head = await git(checkout, ["rev-parse", "HEAD"]);
  const name = await git(checkout, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head.timedOut || name.timedOut) return { status: "unknown" };
  if (head.code !== 0 || name.code !== 0) return { status: "rejected", code: "reconciliation_required" };
  const headSha = head.stdout.trim();
  if (name.stdout.trim() !== mission.branch) return { status: "rejected", code: "reconciliation_required" };
  const dirty = await porcelain(git, checkout);
  if (dirty.status === "unknown") return { status: "unknown" };
  if (dirty.value) return succeeded({ headSha, conflicts: ["dirty worktree"] });
  return succeeded({ headSha, conflicts: [] });
}

async function validateCheckout(
  config: CodingRuntimeConfig,
  mission: CodingMissionRecord
): Promise<ExternalOutcome<ValidationEvidence>> {
  if (!config.validateCommand) return { status: "rejected", code: "validation_unconfigured" };
  const checkout = openCheckout(config, mission.repository);
  if (!checkout) return { status: "rejected", code: "checkout_missing" };
  const result = await runCommand(checkout, config.validateCommand, 120_000);
  if (result.timedOut) return { status: "unknown", code: "validation_timeout" };
  const outcome = result.code === 0 ? "PASS" : "FAIL";
  const checks: ValidationEvidence["checks"] = {
    tests: outcome,
    typecheck: outcome,
    lint: outcome,
    format: outcome,
    repository: outcome,
    review: outcome
  };
  return succeeded({
    checks,
    risks: [`validation command exit ${result.code ?? "unknown"}`]
  });
}

async function publishProposal(
  config: CodingRuntimeConfig,
  git: GitRunner,
  fetchImpl: typeof fetch,
  mission: CodingMissionRecord,
  headSha: string
): Promise<ExternalOutcome<{ prNumber: number; prUrl: string; headSha: string }>> {
  const checkout = openCheckout(config, mission.repository);
  const repo = parseRepository(mission.repository);
  if (!checkout || !repo) return { status: "rejected", code: "checkout_missing" };
  const head = await git(checkout, ["rev-parse", "HEAD"], { env: gitProcessEnv(config.token) });
  if (head.timedOut || head.code === null) return { status: "unknown" };
  if (head.code !== 0 || head.stdout.trim() !== headSha)
    return { status: "rejected", code: "publication_head_mismatch" };
  const pushed = await git(checkout, ["push", "--set-upstream", "origin", `HEAD:refs/heads/${mission.branch}`], {
    env: gitProcessEnv(config.token),
    timeoutMs: 60_000
  });
  if (pushed.timedOut || pushed.code === null) return { status: "unknown" };
  if (pushed.code !== 0) return { status: "rejected", code: "push_rejected" };
  try {
    const client = new GitHubPullRequestClient({
      owner: repo.owner,
      repository: repo.name,
      tokenSource: () => config.token,
      baseBranch: mission.baseRef,
      apiBase: config.apiBase,
      fetchImpl: (input, init) => githubFetch(fetchImpl, input, init)
    });
    const created = await client.createOrUpdate({
      branch: mission.branch,
      commitSha: headSha,
      title: mission.summary,
      body: `ACS coding mission ${mission.missionId}`,
      idempotencyKey: `coding-mission:${mission.missionId}`
    });
    if (created.number === undefined) return { status: "unknown" };
    return confirmPullHead(config, fetchImpl, repo, created.number, created.url, headSha);
  } catch (error) {
    return classifyThrown(error);
  }
}

async function observeProposal(
  config: CodingRuntimeConfig,
  fetchImpl: typeof fetch,
  mission: CodingMissionRecord
): Promise<ExternalOutcome<{ prNumber: number; prUrl: string; headSha: string }>> {
  const repo = parseRepository(mission.repository);
  if (!repo || !mission.headSha) return { status: "unknown" };
  const listed = await githubJson<PullRecord[]>(
    config,
    fetchImpl,
    "GET",
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/pulls?head=${encodeURIComponent(`${repo.owner}:${mission.branch}`)}&state=open`
  );
  if (listed.status !== "ok" || !Array.isArray(listed.body))
    return { status: listed.status === "rejected" ? "rejected" : "unknown", code: "publication_unobserved" };
  const match = listed.body.find((pull) => pull.head?.sha === mission.headSha && pull.number !== undefined);
  if (!match?.number || !match.html_url || !match.head?.sha) {
    return listed.body.length === 0 ? { status: "absent" } : { status: "rejected", code: "publication_head_mismatch" };
  }
  return succeeded({ prNumber: match.number, prUrl: match.html_url, headSha: match.head.sha });
}

async function mergeProposal(
  config: CodingRuntimeConfig,
  fetchImpl: typeof fetch,
  mission: CodingMissionRecord
): Promise<ExternalOutcome<{ mergeSha: string; alreadyMerged?: boolean }>> {
  const observed = await readPull(config, fetchImpl, mission);
  if (observed.status !== "ok")
    return {
      status: observed.status === "rejected" ? "rejected" : "unknown",
      code: observed.code ?? "merge_unobserved"
    };
  const pull = observed.body;
  if (!pull) return { status: "unknown" };
  if (pull.merged && pull.merge_commit_sha) {
    return succeeded({ mergeSha: pull.merge_commit_sha, alreadyMerged: true });
  }
  if (!mission.headSha || pull.head?.sha !== mission.headSha) return { status: "rejected", code: "stale_head" };
  const repo = parseRepository(mission.repository);
  if (!repo || mission.prNumber === undefined) return { status: "rejected", code: "merge_not_found" };
  const merged = await githubJson<{ sha?: string; message?: string }>(
    config,
    fetchImpl,
    "PUT",
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/pulls/${mission.prNumber}/merge`,
    { sha: mission.headSha, merge_method: "merge" }
  );
  if (merged.status === "unknown") return { status: "unknown", code: "unknown_merge" };
  if (merged.status === "rejected") return { status: "rejected", code: mergeRejection(merged.statusCode, merged.body) };
  const sha = merged.body?.sha;
  if (!sha) return { status: "unknown", code: "unknown_merge" };
  return succeeded({ mergeSha: sha });
}

async function observeMerge(
  config: CodingRuntimeConfig,
  fetchImpl: typeof fetch,
  mission: CodingMissionRecord
): Promise<ExternalOutcome<{ mergeSha: string }>> {
  const observed = await readPull(config, fetchImpl, mission);
  if (observed.status !== "ok") return { status: "unknown", code: "merge_unobserved" };
  if (observed.body?.merged && observed.body.merge_commit_sha) {
    return succeeded({ mergeSha: observed.body.merge_commit_sha });
  }
  if (observed.body && observed.body.merged !== true) return { status: "absent" };
  return { status: "unknown", code: "merge_unobserved" };
}

async function deployMerge(
  config: CodingRuntimeConfig,
  fetchImpl: typeof fetch,
  mission: CodingMissionRecord,
  mergeSha: string
): Promise<ExternalOutcome<{ deploymentId: string }>> {
  const repo = parseRepository(mission.repository);
  if (!repo || !mission.changeSetHash) return { status: "rejected", code: "deployment_unconfigured" };
  const created = await githubJson<{ id?: number }>(
    config,
    fetchImpl,
    "POST",
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/deployments`,
    {
      ref: mergeSha,
      environment: deploymentEnvironment(mission.missionId),
      auto_merge: false,
      required_contexts: [],
      description: `ACS coding mission ${mission.missionId}`,
      payload: { missionId: mission.missionId, changeSetHash: mission.changeSetHash, mergeSha }
    }
  );
  if (created.status === "unknown") return { status: "unknown", code: "unknown_deployment" };
  if (created.status === "rejected" || created.body?.id === undefined) {
    return { status: "rejected", code: "deployment_rejected" };
  }
  return succeeded({ deploymentId: String(created.body.id) });
}

async function observeDeployment(
  config: CodingRuntimeConfig,
  fetchImpl: typeof fetch,
  mission: CodingMissionRecord
): Promise<ExternalOutcome<{ deploymentId: string }>> {
  const repo = parseRepository(mission.repository);
  if (!repo) return { status: "unknown" };
  const listed = await githubJson<Array<{ id?: number; sha?: string; payload?: unknown }>>(
    config,
    fetchImpl,
    "GET",
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/deployments?environment=${encodeURIComponent(deploymentEnvironment(mission.missionId))}&per_page=100`
  );
  if (listed.status !== "ok" || !Array.isArray(listed.body))
    return { status: "unknown", code: "deployment_unobserved" };
  const match = listed.body.find((deployment) => deploymentMatches(deployment, mission));
  if (!match?.id) {
    return listed.body.length === 0 ? { status: "absent" } : { status: "unknown", code: "deployment_unobserved" };
  }
  return succeeded({ deploymentId: String(match.id) });
}

async function verifyMission(
  config: CodingRuntimeConfig,
  fetchImpl: typeof fetch,
  mission: CodingMissionRecord
): Promise<{ passed: boolean; checks: Record<string, string> }> {
  const observed = await readPull(config, fetchImpl, mission);
  const merged =
    observed.status === "ok" && observed.body?.merged === true && observed.body.merge_commit_sha === mission.mergeSha;
  const checks: Record<string, string> = { merge: merged ? "PASS" : "FAIL" };
  if (!mission.deploymentRequired) {
    checks.deployment = "SKIP";
    return { passed: merged, checks };
  }
  const deployment = await observeDeployment(config, fetchImpl, mission);
  const deployed = deployment.status === "succeeded" && deployment.value?.deploymentId === mission.deploymentId;
  checks.deployment = deployed ? "PASS" : "FAIL";
  return { passed: merged && deployed, checks };
}

async function observeBaseSha(
  config: CodingRuntimeConfig,
  git: GitRunner,
  repository: string,
  baseRef: string
): Promise<string> {
  if (!REF.test(baseRef) || baseRef.includes("..") || baseRef.startsWith("-")) {
    throw new ControlStackError("coding_mission_base_invalid", "base ref is invalid");
  }
  const checkout = openCheckout(config, repository);
  if (!checkout) throw new ControlStackError("coding_mission_checkout_missing", "repository checkout is not present");
  const fetched = await git(
    checkout,
    ["fetch", "--no-tags", "origin", `refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`],
    { env: gitProcessEnv(config.token), timeoutMs: 60_000 }
  );
  if (fetched.timedOut || fetched.code !== 0) {
    throw new ControlStackError("coding_mission_base_unobserved", "base ref could not be observed");
  }
  const parsed = await git(checkout, ["rev-parse", `refs/remotes/origin/${baseRef}`], {
    env: gitProcessEnv(config.token)
  });
  const sha = parsed.stdout.trim();
  if (parsed.code !== 0 || !/^[a-f0-9]{40}$/u.test(sha)) {
    throw new ControlStackError("coding_mission_base_unobserved", "base ref could not be observed");
  }
  return sha;
}

async function ensureBranch(
  git: GitRunner,
  checkout: string,
  mission: CodingMissionRecord
): Promise<ExternalOutcome<undefined>> {
  if (!REF.test(mission.branch) || mission.branch.includes("..")) return { status: "rejected", code: "branch_invalid" };
  const exists = await git(checkout, ["show-ref", "--verify", "--quiet", `refs/heads/${mission.branch}`]);
  if (exists.timedOut || exists.code === null) return { status: "unknown" };
  if (exists.code === 0) {
    const switched = await git(checkout, ["checkout", mission.branch]);
    if (switched.timedOut) return { status: "unknown" };
    if (switched.code !== 0) return { status: "rejected", code: "conflict" };
    return succeeded(undefined);
  }
  const detached = await git(checkout, ["checkout", "--detach", mission.baseSha]);
  if (detached.timedOut) return { status: "unknown" };
  if (detached.code !== 0) return { status: "rejected", code: "base_missing" };
  const created = await git(checkout, ["checkout", "-b", mission.branch]);
  if (created.timedOut) return { status: "unknown" };
  if (created.code !== 0) return { status: "rejected", code: "branch_create_failed" };
  return succeeded(undefined);
}

async function confirmPullHead(
  config: CodingRuntimeConfig,
  fetchImpl: typeof fetch,
  repo: { owner: string; name: string },
  prNumber: number,
  prUrl: string,
  headSha: string
): Promise<ExternalOutcome<{ prNumber: number; prUrl: string; headSha: string }>> {
  const loaded = await githubJson<PullRecord>(
    config,
    fetchImpl,
    "GET",
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/pulls/${prNumber}`
  );
  if (loaded.status !== "ok" || loaded.body?.head?.sha !== headSha || !loaded.body.html_url) {
    return loaded.status === "unknown"
      ? { status: "unknown" }
      : { status: "rejected", code: "publication_head_mismatch" };
  }
  return succeeded({ prNumber, prUrl: prUrl || loaded.body.html_url, headSha });
}

async function readPull(
  config: CodingRuntimeConfig,
  fetchImpl: typeof fetch,
  mission: CodingMissionRecord
): Promise<{ status: "ok" | "unknown" | "rejected"; body?: PullRecord; code?: string; statusCode?: number }> {
  const repo = parseRepository(mission.repository);
  if (!repo || mission.prNumber === undefined) return { status: "rejected", code: "merge_not_found" };
  const loaded = await githubJson<PullRecord>(
    config,
    fetchImpl,
    "GET",
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/pulls/${mission.prNumber}`
  );
  if (loaded.status !== "ok" || !loaded.body)
    return {
      status: loaded.status === "rejected" ? "rejected" : "unknown",
      code: "merge_unobserved",
      statusCode: loaded.statusCode
    };
  return { status: "ok", body: loaded.body, statusCode: loaded.statusCode };
}

async function githubJson<T>(
  config: CodingRuntimeConfig,
  fetchImpl: typeof fetch,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: "ok" | "unknown" | "rejected"; statusCode: number; body?: T }> {
  try {
    const response = await githubFetch(fetchImpl, `${config.apiBase}${path}`, {
      method,
      headers: githubHeaders(config.token),
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const status = classifyStatus(response.status);
    if (status !== "ok") return { status, statusCode: response.status };
    const parsed = (await response.json()) as T;
    return { status: "ok", statusCode: response.status, body: parsed };
  } catch {
    return { status: "unknown", statusCode: 0 };
  }
}

async function githubFetch(fetchImpl: typeof fetch, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function classifyStatus(status: number): "ok" | "unknown" | "rejected" {
  if (status === 408 || status === 429 || status >= 500) return "unknown";
  if (status >= 400) return "rejected";
  return "ok";
}

function classifyThrown(error: unknown): ExternalOutcome<never> {
  const message = error instanceof Error ? error.message : "";
  if (/abort|timeout|network|fetch failed|ECONN|ENOTFOUND/iu.test(message)) return { status: "unknown" };
  const match = /failed: (\d{3})/u.exec(message);
  const status = match ? Number(match[1]) : 0;
  if (status === 408 || status === 429 || status >= 500) return { status: "unknown" };
  if (status >= 400) return { status: "rejected", code: "github_rejected" };
  return { status: "unknown" };
}

function mergeRejection(status: number | undefined, body: { message?: string } | undefined): string {
  const message = body?.message ?? "";
  if (status === 405 || /required status|branch protection|review/iu.test(message)) return "branch_protection";
  return "stale_head";
}

function deploymentMatches(
  deployment: { id?: number; sha?: string; payload?: unknown },
  mission: CodingMissionRecord
): boolean {
  const payload = typeof deployment.payload === "string" ? parseJson(deployment.payload) : deployment.payload;
  if (!payload || typeof payload !== "object") return false;
  const record = payload as { missionId?: unknown; changeSetHash?: unknown; mergeSha?: unknown };
  if (record.missionId !== mission.missionId) return false;
  if (mission.changeSetHash && record.changeSetHash !== mission.changeSetHash) return false;
  if (mission.mergeSha && deployment.sha && deployment.sha !== mission.mergeSha) return false;
  return deployment.id !== undefined;
}

function deploymentEnvironment(missionId: string): string {
  return `acs-${missionId}`;
}

function loadCodingAgents(dbPath: string): RegistryAgentDetail[] {
  const store = new SqliteWorkItemStore(dbPath);
  try {
    return store.listRegistryAgents();
  } finally {
    store.close();
  }
}

function nimbleState(mission: CodingMissionRecord, title: string, agent: RegistryAgentDetail) {
  return {
    title,
    intent: mission.summary,
    requestedActionKinds: ["coding"],
    requestedActionDescriptions: [title],
    targetServices: [],
    targetRepositories: [mission.repository],
    candidateAgentId: agent.id,
    candidateRole: agent.acpRole,
    candidateDescription: agent.name,
    candidateCapabilities: agent.capabilities.map((capability) => capability.name)
  };
}

function parseDeployPolicy(raw: string | undefined): CodingRuntimeConfig["deployPolicy"] {
  if (!raw || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new ControlStackError("coding_mission_deployment_unconfigured", "deployment policy JSON is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ControlStackError("coding_mission_deployment_unconfigured", "deployment policy must be an object");
  }
  const policy: CodingRuntimeConfig["deployPolicy"] = {};
  for (const [repository, value] of Object.entries(parsed)) {
    if (!REPOSITORY.test(repository) || !value || typeof value !== "object" || Array.isArray(value)) {
      throw new ControlStackError("coding_mission_deployment_unconfigured", "deployment policy entry is invalid");
    }
    const entry = value as { required?: unknown; action?: unknown; impact?: unknown };
    const required = entry.required === true;
    const action = typeof entry.action === "string" ? entry.action : "none";
    const impact = typeof entry.impact === "string" && entry.impact.trim() ? entry.impact : "no runtime mutation";
    policy[repository] = { required, action, impact };
  }
  return policy;
}

function parseRepository(repository: string): { owner: string; name: string } | undefined {
  const match = REPOSITORY.exec(repository);
  if (!match) return undefined;
  return { owner: match[1] ?? "", name: match[2] ?? "" };
}

function openCheckout(config: CodingRuntimeConfig, repository: string): string | undefined {
  const repo = parseRepository(repository);
  if (!repo || repo.name === "." || repo.name === ".." || repo.owner === "." || repo.owner === "..") return undefined;
  const checkout = resolve(config.checkoutRoot, repo.owner, repo.name);
  const escaped = relative(config.checkoutRoot, checkout);
  if (!escaped || escaped.startsWith("..") || isAbsolute(escaped)) return undefined;
  if (!existsSync(checkout) || !statSync(checkout).isDirectory()) return undefined;
  return checkout;
}

function gitProcessEnv(token?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    LC_ALL: "C"
  };
  if (token) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraheader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  }
  return env;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

async function porcelain(git: GitRunner, checkout: string): Promise<ExternalOutcome<boolean>> {
  const status = await git(checkout, ["status", "--porcelain"]);
  if (status.timedOut || status.code === null) return { status: "unknown" };
  if (status.code !== 0) return { status: "rejected", code: "status_failed" };
  return succeeded(status.stdout.trim().length > 0);
}

function readMarker(path: string): { missionId: string; raw: string } | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8");
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== "object") return undefined;
  const missionId = (parsed as { missionId?: unknown }).missionId;
  if (typeof missionId !== "string") return undefined;
  return { missionId, raw };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function succeeded<T>(value: T): ExternalOutcome<T> {
  return { status: "succeeded", value };
}

function runCommand(checkout: string, command: string, timeoutMs: number): Promise<GitRunResult> {
  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn("sh", ["-c", command], {
      cwd: checkout,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        LANG: "C",
        LC_ALL: "C",
        TMPDIR: process.env.TMPDIR
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < 16_000) stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 16_000) stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const finish = (result: GitRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    child.on("error", () => finish({ code: null, stdout, stderr, timedOut: false }));
    child.on("close", (code, signal) => finish({ code, stdout, stderr, timedOut: signal === "SIGKILL" }));
  });
}
