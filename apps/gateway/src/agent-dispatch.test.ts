import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import type { AgentDispatchConfig } from "./agent-runs.js";
import { buildGateway, type GatewayCredential } from "./server.js";

const OP = ["operator", "token", "0123456789abcdef0123456789abcdef"].join("-");
const READER = ["reader", "token", "0123456789abcdef0123456789abcdef"].join("-");
const AGENT = ["agent", "token", "0123456789abcdef0123456789abcdef"].join("-");
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const credentials: GatewayCredential[] = [
  {
    id: "op",
    token: OP,
    actor: "user",
    actorId: "user",
    roles: ["operator"],
    scopes: ["acs:read", "acs:write", "acs:approve"]
  },
  { id: "reader", token: READER, actor: "user", actorId: "reader", roles: ["operator"], scopes: ["acs:read"] },
  {
    id: "agent",
    token: AGENT,
    actor: "agent",
    actorId: "agent-1",
    roles: ["operator"],
    scopes: ["acs:read", "acs:write", "acs:approve"]
  }
];

let root: string;
let bin: string;
let repo: string;
let originalPath: string | undefined;
const open: Array<{ close: () => Promise<unknown> }> = [];

function fake(name: string, body: string): void {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function config(over: Partial<AgentDispatchConfig> = {}): AgentDispatchConfig {
  return {
    enabled: true,
    repoRoots: [root],
    maxConcurrent: 2,
    worktreeRoot: join(root, "worktrees"),
    outputRoot: join(root, "runs"),
    ...over
  };
}

function makeGateway(agentDispatch: AgentDispatchConfig, dbPath = join(root, "control.db")) {
  const app = buildGateway({
    dbPath,
    logger: false,
    agentDispatch,
    auth: { token: "", actor: "user", actorId: "user", credentials }
  });
  open.push(app);
  return app;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "acs-dispatch-")));
  bin = join(root, "bin");
  mkdirSync(bin);
  repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  originalPath = process.env.PATH;
  // Only the fake CLIs plus system tools: the host's real agent CLIs must not leak into these tests.
  process.env.PATH = `${bin}:/usr/bin:/bin`;
});

afterEach(async () => {
  process.env.PATH = originalPath;
  while (open.length) await open.pop()!.close();
  rmSync(root, { recursive: true, force: true });
});

async function waitFor<T>(read: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const request = { agentId: "claude", prompt: "add a file", repo: "", mode: "edit" as const };

describe("agent dispatch", () => {
  it("is off unless explicitly enabled", async () => {
    const app = makeGateway(config({ enabled: false }));
    const res = await app.inject({
      method: "POST",
      url: "/api/agent-runs/preview",
      headers: bearer(OP),
      payload: { ...request, repo }
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("agent_dispatch_disabled");
  });

  it("only a human operator with acs:approve can preview, dispatch or cancel", async () => {
    fake("claude", "exit 0");
    const app = makeGateway(config());
    const payload = { ...request, repo };
    expect((await app.inject({ method: "POST", url: "/api/agent-runs/preview", payload })).statusCode).toBe(401);
    for (const token of [READER, AGENT]) {
      const res = await app.inject({ method: "POST", url: "/api/agent-runs/preview", headers: bearer(token), payload });
      expect(res.statusCode).toBe(403);
    }
    const cancel = await app.inject({
      method: "POST",
      url: "/api/agent-runs/run_000000000000/cancel",
      headers: bearer(AGENT)
    });
    expect(cancel.statusCode).toBe(403);
    const read = await app.inject({ method: "GET", url: "/api/agent-runs", headers: bearer(READER) });
    expect(read.statusCode).toBe(200);
  });

  it("runs a confirmed dispatch in its own worktree and records it in the audit chain", async () => {
    fake("claude", 'echo "working in $(pwd)"; echo changed > made-by-agent.txt');
    const app = makeGateway(config());
    const payload = { ...request, repo };
    const preview = (
      await app.inject({ method: "POST", url: "/api/agent-runs/preview", headers: bearer(OP), payload })
    ).json().preview;
    expect(preview).toMatchObject({ agentId: "claude", mode: "edit", repoRoot: repo });
    expect(preview.confirmationHash).toMatch(/^[a-f0-9]{64}$/);

    const dispatched = await app.inject({
      method: "POST",
      url: "/api/agent-runs",
      headers: bearer(OP),
      payload: { ...payload, confirmationHash: preview.confirmationHash }
    });
    expect(dispatched.statusCode).toBe(202);
    const runId = dispatched.json().run.runId as string;

    const finished = await waitFor(async () => {
      const run = (
        await app.inject({ method: "GET", url: `/api/agent-runs/${runId}`, headers: bearer(READER) })
      ).json();
      return ["succeeded", "failed"].includes(run.run.status) ? run : undefined;
    });
    expect(finished.run).toMatchObject({ status: "succeeded", exitCode: 0, actorId: "user", agentId: "claude" });
    expect(finished.run.branch).toBe(`acs/agent/claude-${runId}`);
    expect(finished.run.worktreePath).toContain(join(root, "worktrees"));
    expect(finished.run.changedFiles).toEqual(["made-by-agent.txt"]);
    expect(finished.output).toContain("working in");
    // The main checkout was never touched.
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString()).toBe("");

    const store = new SqliteWorkItemStore(join(root, "control.db"));
    try {
      const names = store
        .readEvents({ limit: 500 })
        .filter((e) => e.name.startsWith("agent_run."))
        .map((e) => e.name);
      expect(names).toEqual(expect.arrayContaining(["agent_run.requested", "agent_run.started", "agent_run.finished"]));
      expect(store.verifyAuditChain().ok).toBe(true);
    } finally {
      store.close();
    }
  });

  it("refuses a dispatch that differs from what was confirmed, a repo outside the allow-list, and blocked CLIs", async () => {
    fake("claude", "exit 0");
    fake("gemini", "exit 0");
    const app = makeGateway(config());
    const payload = { ...request, repo };
    const preview = (
      await app.inject({ method: "POST", url: "/api/agent-runs/preview", headers: bearer(OP), payload })
    ).json().preview;
    const tampered = await app.inject({
      method: "POST",
      url: "/api/agent-runs",
      headers: bearer(OP),
      payload: { ...payload, prompt: "something else", confirmationHash: preview.confirmationHash }
    });
    expect(tampered.statusCode).toBe(409);
    expect(tampered.json().code).toBe("agent_confirmation_mismatch");

    const outside = mkdtempSync(join(tmpdir(), "acs-outside-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: outside });
      const res = await app.inject({
        method: "POST",
        url: "/api/agent-runs/preview",
        headers: bearer(OP),
        payload: { ...payload, repo: realpathSync(outside) }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("agent_repo_not_allowed");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }

    const blocked = await app.inject({
      method: "POST",
      url: "/api/agent-runs/preview",
      headers: bearer(OP),
      payload: { ...payload, agentId: "gemini" }
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe("agent_dispatch_blocked");
    const unknown = await app.inject({
      method: "POST",
      url: "/api/agent-runs/preview",
      headers: bearer(OP),
      payload: { ...payload, agentId: "rm" }
    });
    expect(unknown.statusCode).toBe(400);
  });

  it("caps concurrent runs, cancels an active run, and marks orphaned runs interrupted after a restart", async () => {
    fake("claude", "sleep 30");
    const dbPath = join(root, "control.db");
    const app = makeGateway(config({ maxConcurrent: 1 }), dbPath);
    const payload = { ...request, repo };
    const confirm = async (p: typeof payload) =>
      (await app.inject({ method: "POST", url: "/api/agent-runs/preview", headers: bearer(OP), payload: p })).json()
        .preview.confirmationHash as string;

    const first = await app.inject({
      method: "POST",
      url: "/api/agent-runs",
      headers: bearer(OP),
      payload: { ...payload, confirmationHash: await confirm(payload) }
    });
    expect(first.statusCode).toBe(202);
    const second = { ...payload, prompt: "another" };
    const refused = await app.inject({
      method: "POST",
      url: "/api/agent-runs",
      headers: bearer(OP),
      payload: { ...second, confirmationHash: await confirm(second) }
    });
    expect(refused.statusCode).toBe(429);
    expect(refused.json().code).toBe("agent_run_capacity");

    const runId = first.json().run.runId as string;
    await waitFor(async () =>
      (await app.inject({ method: "GET", url: `/api/agent-runs/${runId}`, headers: bearer(OP) })).json().run.status ===
      "running"
        ? true
        : undefined
    );
    const cancelled = await app.inject({ method: "POST", url: `/api/agent-runs/${runId}/cancel`, headers: bearer(OP) });
    expect(cancelled.statusCode).toBe(200);
    await waitFor(async () =>
      (await app.inject({ method: "GET", url: `/api/agent-runs/${runId}`, headers: bearer(OP) })).json().run.status ===
      "cancelled"
        ? true
        : undefined
    );

    // A run recorded as active by a previous gateway process is marked interrupted on startup.
    const store = new SqliteWorkItemStore(dbPath);
    store.recordSystemEvent({
      name: "agent_run.requested",
      body: {
        runId: "run_aaaaaaaaaaaa",
        agentId: "claude",
        mode: "edit",
        repoRoot: repo,
        actorId: "user",
        promptPreview: "orphan"
      },
      attributes: { "agent_run.id": "run_aaaaaaaaaaaa" }
    });
    store.close();
    const restarted = makeGateway(config(), dbPath);
    const list = (await restarted.inject({ method: "GET", url: "/api/agent-runs", headers: bearer(OP) })).json()
      .runs as Array<{ runId: string; status: string }>;
    expect(list.find((r) => r.runId === "run_aaaaaaaaaaaa")?.status).toBe("interrupted");
  }, 30_000);

  it("lists all nine CLIs and registers them idempotently", async () => {
    fake("claude", 'echo "2.1.284 (Claude Code)"');
    fake("gemini", 'echo "0.46.0"');
    const app = makeGateway(config());
    const view = (await app.inject({ method: "GET", url: "/api/agent-clis", headers: bearer(READER) })).json();
    expect(view.agents).toHaveLength(9);
    const by = Object.fromEntries(view.agents.map((a: { id: string }) => [a.id, a]));
    expect(by.claude).toMatchObject({ installed: true, dispatchable: true, registered: false });
    expect(by.gemini).toMatchObject({ installed: true, dispatchable: false });
    expect(by.gemini.unavailableReason).toMatch(/no longer supported/);

    const seed = new SqliteWorkItemStore(join(root, "control.db"));
    seed.registerActor({ id: "user", actorType: "HUMAN", displayName: "user" });
    seed.close();
    const denied = await app.inject({ method: "POST", url: "/api/agent-clis/sync", headers: bearer(READER) });
    expect(denied.statusCode).toBe(403);
    const synced = await app.inject({ method: "POST", url: "/api/agent-clis/sync", headers: bearer(OP) });
    expect(synced.body).toBeTruthy();
    expect(synced.statusCode, synced.body).toBe(200);
    expect(synced.json()).toMatchObject({ created: 9, updated: 0 });
    const again = await app.inject({ method: "POST", url: "/api/agent-clis/sync", headers: bearer(OP) });
    expect(again.json()).toMatchObject({ created: 0, updated: 9 });
    const agents = (await app.inject({ method: "GET", url: "/api/agents", headers: bearer(READER) })).json()
      .agents as Array<{ id: string; status: string }>;
    expect(agents.find((a) => a.id === "cli-claude")?.status).toBe("AVAILABLE");
    expect(agents.find((a) => a.id === "cli-gemini")?.status).toBe("DEGRADED");
    expect(agents.find((a) => a.id === "cli-cline")?.status).toBe("OFFLINE");
  });
});
