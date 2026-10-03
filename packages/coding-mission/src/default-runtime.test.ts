import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  codingMissionPortsFromEnv,
  readCodingRuntimeConfig,
  resumeConfiguredCodingMissions,
  type GitRunner
} from "./default-runtime.js";
import type { CodingMissionRecord } from "./store.js";

const HEAD = "b".repeat(40);
const OTHER = "c".repeat(40);
const MERGE = "d".repeat(40);
const NOW = "2026-10-02T12:00:00.000Z";

function mission(patch: Partial<CodingMissionRecord> = {}): CodingMissionRecord {
  return {
    missionId: "mission-1",
    repository: "acme/app",
    baseRef: "main",
    baseSha: "a".repeat(40),
    summary: "Ship the fix",
    state: "PUBLISHING_PROPOSAL",
    version: 4,
    headSha: HEAD,
    branch: "acs/mission/mission-1",
    changeSetHash: "e".repeat(64),
    prNumber: 9,
    deploymentRequired: false,
    deploymentAction: "none",
    deploymentImpact: "no runtime mutation",
    createdAt: NOW,
    updatedAt: NOW,
    ...patch
  };
}

function runtimeEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ACS_GITHUB_TOKEN: "test-token",
    ACS_CODING_CHECKOUT_ROOT: root,
    ACS_GITHUB_API: "https://github.test",
    ACS_CODING_VALIDATE_COMMAND: "git diff --check",
    ...extra
  };
}

describe("default coding mission runtime", () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("stays unconfigured unless both a token and a checkout root are present", async () => {
    expect(readCodingRuntimeConfig({ ACS_GITHUB_TOKEN: "test-token" })).toBeUndefined();
    expect(readCodingRuntimeConfig({ ACS_CODING_CHECKOUT_ROOT: "/tmp/checkouts" })).toBeUndefined();
    await expect(resumeConfiguredCodingMissions("/tmp/does-not-need-to-exist", {})).resolves.toBeUndefined();
  });

  it("publishes one pull request, reconciles an unknown create, and merges only the approved head", async () => {
    root = mkdtempSync(join(tmpdir(), "acs-coding-runtime-"));
    mkdirSync(join(root, "acme", "app"), { recursive: true });
    const http: string[] = [];
    let createStatus = 503;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      http.push(`${method} ${url}`);
      if (method === "POST" && url.endsWith("/pulls")) {
        return Response.json({ message: "unavailable" }, { status: createStatus });
      }
      if (method === "GET" && url.includes("/pulls?")) {
        return createStatus === 503
          ? Response.json([])
          : Response.json([{ number: 9, html_url: "https://github.test/acme/app/pull/9", head: { sha: HEAD } }]);
      }
      if (method === "GET" && url.endsWith("/pulls/9")) {
        return Response.json({
          number: 9,
          html_url: "https://github.test/acme/app/pull/9",
          merged: false,
          head: { sha: HEAD }
        });
      }
      if (method === "PUT" && url.endsWith("/merge")) {
        return Response.json({ message: "Required status check is expected" }, { status: 405 });
      }
      return Response.json({ message: "unexpected" }, { status: 500 });
    }) as typeof fetch;
    const git: GitRunner = async (_checkout, args, options) => {
      const command = args.join(" ");
      if (command.startsWith("push")) {
        expect(command).not.toContain("test-token");
        expect(options?.env?.GIT_CONFIG_VALUE_0).toBe(
          `Authorization: Basic ${Buffer.from("x-access-token:test-token").toString("base64")}`
        );
        expect(options?.env?.GITHUB_TOKEN).toBeUndefined();
      }
      if (command === "rev-parse HEAD") return { code: 0, stdout: `${HEAD}\n`, stderr: "", timedOut: false };
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    const ports = codingMissionPortsFromEnv(runtimeEnv(root), { dbPath: join(root, "control.db"), fetchImpl, git });
    expect(ports).toBeDefined();
    const unknown = await ports!.publisher.publish({ mission: mission(), headSha: HEAD });
    expect(unknown.status).toBe("unknown");
    expect(http.filter((call) => call.startsWith("POST"))).toHaveLength(1);
    createStatus = 201;
    const observed = await ports!.publisher.observe({ mission: mission() });
    expect(observed).toEqual({
      status: "succeeded",
      value: { prNumber: 9, prUrl: "https://github.test/acme/app/pull/9", headSha: HEAD }
    });
    expect(http.filter((call) => call.startsWith("POST"))).toHaveLength(1);

    const stale = await ports!.merger.merge({ mission: mission({ headSha: OTHER }) });
    expect(stale).toEqual({ status: "rejected", code: "stale_head" });
    expect(http.some((call) => call.startsWith("PUT"))).toBe(false);

    const protectedBranch = await ports!.merger.merge({ mission: mission() });
    expect(protectedBranch).toEqual({ status: "rejected", code: "branch_protection" });
    expect(http.filter((call) => call.startsWith("PUT"))).toHaveLength(1);
  });

  it("treats an already-merged pull request and an unknown deployment as observations", async () => {
    root = mkdtempSync(join(tmpdir(), "acs-coding-runtime-"));
    mkdirSync(join(root, "acme", "app"), { recursive: true });
    const http: string[] = [];
    let deploymentPosted = false;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      http.push(`${method} ${url}`);
      if (method === "GET" && url.endsWith("/pulls/9")) {
        return Response.json({ merged: true, merge_commit_sha: MERGE, head: { sha: HEAD } });
      }
      if (method === "POST" && url.endsWith("/deployments")) {
        deploymentPosted = true;
        return Response.json({ message: "timeout" }, { status: 504 });
      }
      if (method === "GET" && url.includes("/deployments?")) {
        return Response.json(
          deploymentPosted
            ? [
                {
                  id: 41,
                  sha: MERGE,
                  payload: { missionId: "mission-1", changeSetHash: "e".repeat(64), mergeSha: MERGE }
                }
              ]
            : []
        );
      }
      return Response.json({ message: "unexpected" }, { status: 500 });
    }) as typeof fetch;
    const ports = codingMissionPortsFromEnv(
      runtimeEnv(root, {
        ACS_CODING_DEPLOY_POLICY: JSON.stringify({
          "acme/app": { required: true, action: "github_deployment", impact: "roll forward" },
          "acme/other": { required: true, action: "restart", impact: "restart" }
        })
      }),
      {
        dbPath: join(root, "control.db"),
        fetchImpl,
        git: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false })
      }
    )!;
    expect(ports.deploymentPolicy.requirement("missing/repo")).toEqual({
      required: false,
      action: "none",
      impact: "no runtime mutation"
    });
    expect(ports.deploymentPolicy.requirement("acme/app").required).toBe(true);
    expect(() => ports.deploymentPolicy.requirement("acme/other")).toThrow(/configured adapter/u);
    const merged = await ports.merger.merge({ mission: mission() });
    expect(merged).toEqual({ status: "succeeded", value: { mergeSha: MERGE, alreadyMerged: true } });
    expect(http.some((call) => call.startsWith("PUT"))).toBe(false);
    const current = mission({ mergeSha: MERGE, deploymentRequired: true });
    const unknown = await ports.deployer.deploy({ mission: current, mergeSha: MERGE });
    expect(unknown.status).toBe("unknown");
    const found = await ports.deployer.observe({ mission: current });
    expect(found).toEqual({ status: "succeeded", value: { deploymentId: "41" } });
    expect(http.filter((call) => call.startsWith("POST"))).toHaveLength(1);
    const verified = await ports.verifier.verify({ mission: { ...current, deploymentId: "41" }, operations: [] });
    expect(verified.passed).toBe(true);
  });

  it("commits the mission marker once and does not reset an existing branch", async () => {
    root = mkdtempSync(join(tmpdir(), "acs-coding-runtime-"));
    const checkout = join(root, "acme", "app");
    mkdirSync(checkout, { recursive: true });
    const localGit = (args: string[]) =>
      execFileSync("git", args, {
        cwd: checkout,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@localhost",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@localhost"
        }
      });
    localGit(["init"]);
    localGit(["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "--allow-empty", "-m", "base"]);
    const baseSha = localGit(["rev-parse", "HEAD"]).toString().trim();
    const ports = codingMissionPortsFromEnv(runtimeEnv(root), {
      dbPath: join(root, "control.db"),
      fetchImpl: (async () => Response.json({})) as typeof fetch
    })!;
    const record = mission({ baseSha, headSha: undefined, prNumber: undefined });
    const first = await ports.coder.execute({ mission: record, operationId: "prepare", workerId: "agent-1" });
    const second = await ports.coder.execute({ mission: record, operationId: "prepare", workerId: "agent-2" });
    expect(first.status).toBe("succeeded");
    expect(second).toEqual(first);
    expect(localGit(["rev-list", "--count", "HEAD"]).toString().trim()).toBe("2");
    const reconciled = await ports.reconciler.reconcile({ mission: record, operations: [] });
    expect(reconciled.status).toBe("succeeded");
    if (reconciled.status === "succeeded") expect(reconciled.value?.conflicts).toEqual([]);
    const validated = await ports.validator.validate({ mission: record, headSha: baseSha });
    expect(validated.status).toBe("succeeded");
  });

  it("fails validation closed when no command is configured", async () => {
    root = mkdtempSync(join(tmpdir(), "acs-coding-runtime-"));
    mkdirSync(join(root, "acme", "app"), { recursive: true });
    const { ACS_CODING_VALIDATE_COMMAND: _ignored, ...env } = runtimeEnv(root);
    const ports = codingMissionPortsFromEnv(env, {
      dbPath: join(root, "control.db"),
      fetchImpl: (async () => Response.json({})) as typeof fetch
    })!;
    const validated = await ports.validator.validate({ mission: mission(), headSha: HEAD });
    expect(validated).toEqual({ status: "rejected", code: "validation_unconfigured" });
    const escaped = await ports.publisher.publish({
      mission: mission({ repository: "acme/.." }),
      headSha: HEAD
    });
    expect(escaped).toEqual({ status: "rejected", code: "checkout_missing" });
  });
});
