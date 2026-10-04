import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { spawn } from "node:child_process";
import { assessResult, foldRuns, processStartTicks, type AgentDispatchConfig } from "./agent-runs.js";
import { buildGateway, type GatewayCredential } from "./server.js";

const OP = "operator-credential".padEnd(40, "_");
const READER = "reader-credential".padEnd(40, "_");
const AGENT = "agent-credential".padEnd(40, "_");
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
    fake("openclaw", "exit 0");
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
      payload: { ...payload, agentId: "openclaw" }
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
    fake("openclaw", 'echo "2026.9.7"');
    const app = makeGateway(config());
    const view = (await app.inject({ method: "GET", url: "/api/agent-clis", headers: bearer(READER) })).json();
    expect(view.agents).toHaveLength(9);
    const by = Object.fromEntries(view.agents.map((a: { id: string }) => [a.id, a]));
    expect(by.claude).toMatchObject({ installed: true, dispatchable: true, registered: false });
    expect(by.openclaw).toMatchObject({ installed: true, dispatchable: false });
    expect(by.openclaw.unavailableReason).toMatch(/Gateway owns its state directory/);

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
    expect(agents.find((a) => a.id === "cli-openclaw")?.status).toBe("DEGRADED");
    expect(agents.find((a) => a.id === "cli-cline")?.status).toBe("OFFLINE");
  });

  it("retires the old Gemini CLI record without deleting it or changing unrelated agents", async () => {
    const seed = new SqliteWorkItemStore(join(root, "control.db"));
    seed.registerActor({ id: "user", actorType: "HUMAN", displayName: "user" });
    for (const id of ["cli-gemini", "gemini-cli"]) {
      if (seed.getRegistryAgent(id)) {
        seed.updateRegistryAgent(id, { status: "AVAILABLE", actorId: "user" });
        continue;
      }
      seed.createRegistryAgent({
        id,
        name: id,
        kind: "cli",
        provider: "google",
        status: "AVAILABLE",
        acpRole: "LOCAL_CODING_AGENT",
        actorId: "user"
      });
    }
    seed.close();
    const app = makeGateway(config());
    const sync = await app.inject({ method: "POST", url: "/api/agent-clis/sync", headers: bearer(OP) });
    expect(sync.statusCode, sync.body).toBe(200);
    expect(sync.json()).toMatchObject({ created: 9, updated: 1 });
    const agents = (await app.inject({ method: "GET", url: "/api/agents", headers: bearer(READER) })).json().agents;
    expect(agents.find((a: { id: string }) => a.id === "cli-gemini")).toMatchObject({ status: "OFFLINE" });
    expect(agents.find((a: { id: string }) => a.id === "gemini-cli")).toMatchObject({ status: "AVAILABLE" });
    expect(agents.find((a: { id: string }) => a.id === "cli-antigravity")).toBeDefined();
    const again = await app.inject({ method: "POST", url: "/api/agent-clis/sync", headers: bearer(OP) });
    expect(again.json()).toMatchObject({ created: 0, updated: 9 });
  });

  describe("governed lifecycle", () => {
    const preview = async (app: ReturnType<typeof makeGateway>, token = OP, payload: object = { ...request, repo }) =>
      (await app.inject({ method: "POST", url: "/api/agent-runs/preview", headers: bearer(token), payload })).json()
        .preview.confirmationHash as string;
    const dispatch = (app: ReturnType<typeof makeGateway>, hash: string, token = OP) =>
      app.inject({
        method: "POST",
        url: "/api/agent-runs",
        headers: bearer(token),
        payload: { ...request, repo, confirmationHash: hash }
      });
    const statusOf = async (app: ReturnType<typeof makeGateway>, runId: string) =>
      (await app.inject({ method: "GET", url: `/api/agent-runs/${runId}`, headers: bearer(OP) })).json().run;

    it("treats a duplicate submission of one confirmation as the same run", async () => {
      fake("claude", "sleep 30");
      const app = makeGateway(config({ maxConcurrent: 3 }));
      const hash = await preview(app);
      const [a, b] = await Promise.all([dispatch(app, hash), dispatch(app, hash)]);
      expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
      expect(a.json().run.runId).toBe(b.json().run.runId);
      const list = (await app.inject({ method: "GET", url: "/api/agent-runs", headers: bearer(OP) })).json();
      expect(list.runs).toHaveLength(1);
      // Re-previewing the identical request does not reopen it for a second run.
      const again = await dispatch(app, await preview(app));
      expect(again.json().run.runId).toBe(a.json().run.runId);
      await app.inject({ method: "POST", url: `/api/agent-runs/${a.json().run.runId}/cancel`, headers: bearer(OP) });
    }, 30_000);

    it("refuses a confirmation that was never issued, was issued to someone else, or has expired", async () => {
      fake("claude", "exit 0");
      let clock = Date.now();
      const app = buildGateway({
        dbPath: join(root, "control.db"),
        logger: false,
        agentDispatch: config(),
        agentRunNow: () => clock,
        auth: { token: "", actor: "user", actorId: "user", credentials }
      });
      open.push(app);
      const hash = await preview(app);
      const forged = await dispatch(app, "0".repeat(64));
      expect(forged.json().code).toBe("agent_confirmation_mismatch");

      const other = buildGateway({
        dbPath: join(root, "other.db"),
        logger: false,
        agentDispatch: config(),
        auth: { token: "", actor: "user", actorId: "user", credentials }
      });
      open.push(other);
      const unissued = await dispatch(other, hash);
      expect(unissued.statusCode).toBe(409);
      expect(unissued.json().code).toBe("agent_confirmation_unissued");

      clock += 11 * 60_000;
      const expired = await dispatch(app, hash);
      expect(expired.statusCode).toBe(409);
      expect(expired.json().code).toBe("agent_confirmation_expired");
      expect((await app.inject({ method: "GET", url: "/api/agent-runs", headers: bearer(OP) })).json().runs).toEqual(
        []
      );
    });

    it("does not call a clean exit a success when the work did not happen", async () => {
      fake("claude", 'echo "Error: 401 Unauthorized - Invalid API key"; exit 0');
      const app = makeGateway(config());
      const res = await dispatch(app, await preview(app));
      const runId = res.json().run.runId as string;
      const run = await waitFor(async () => {
        const r = await statusOf(app, runId);
        return r.status === "queued" || r.status === "running" ? undefined : r;
      });
      expect(run).toMatchObject({
        status: "failed",
        exitCode: 0,
        resultCheck: "failure_signature",
        acceptance: "not_applicable"
      });
      expect(run.error).toMatch(/authentication or provider failure/);
    });

    it("fails a read-only run that wrote files", async () => {
      fake("claude", "echo x > sneaky.txt");
      const app = makeGateway(config());
      const readOnly = { ...request, repo, mode: "read-only" as const };
      const hash = await preview(app, OP, readOnly);
      const sent = await app.inject({
        method: "POST",
        url: "/api/agent-runs",
        headers: bearer(OP),
        payload: { ...readOnly, confirmationHash: hash }
      });
      const ro = await waitFor(async () => {
        const r = await statusOf(app, sent.json().run.runId);
        return r.status === "queued" || r.status === "running" ? undefined : r;
      });
      expect(ro).toMatchObject({ status: "failed", resultCheck: "unexpected_changes" });
    });

    it("lets only a human accept a succeeded run, once", async () => {
      fake("claude", "echo done > out.txt");
      const app = makeGateway(config());
      const res = await dispatch(app, await preview(app));
      const runId = res.json().run.runId as string;
      const done = await waitFor(async () => {
        const r = await statusOf(app, runId);
        return r.status === "queued" || r.status === "running" ? undefined : r;
      });
      expect(done).toMatchObject({ status: "succeeded", resultCheck: "changes_present", acceptance: "pending_review" });
      const url = `/api/agent-runs/${runId}/review`;
      expect(
        (await app.inject({ method: "POST", url, headers: bearer(AGENT), payload: { decision: "accept" } })).statusCode
      ).toBe(403);
      expect(
        (await app.inject({ method: "POST", url, headers: bearer(READER), payload: { decision: "accept" } })).statusCode
      ).toBe(403);
      expect(
        (await app.inject({ method: "POST", url, headers: bearer(OP), payload: { decision: "maybe" } })).statusCode
      ).toBe(400);
      const accepted = await app.inject({
        method: "POST",
        url,
        headers: bearer(OP),
        payload: { decision: "accept", note: "looks right" }
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json().run).toMatchObject({
        acceptance: "accepted",
        reviewedBy: "user",
        reviewNote: "looks right"
      });
      const twice = await app.inject({ method: "POST", url, headers: bearer(OP), payload: { decision: "reject" } });
      expect(twice.statusCode).toBe(409);
      expect(twice.json().code).toBe("agent_run_not_reviewable");
    });

    it("never consults Jev: the dispatch path has no dependency on the advisor", () => {
      for (const file of ["agent-runs.ts", "agent-routes.ts"]) {
        const source = readFileSync(join(__dirname, file), "utf8");
        expect(source, file).not.toMatch(/jev/iu);
      }
    });
  });
});

describe("agent run state folding", () => {
  const event = (sequence: number, name: string, body: Record<string, unknown>) =>
    ({ sequence, name, body, timeUnixNano: String(sequence * 1e9) }) as never;
  const requested = {
    runId: "run_aaaaaaaaaaaa",
    agentId: "claude",
    mode: "edit",
    ownerToken: "owner-1",
    actorId: "user"
  };

  it("ignores a finish from a stale owner and a finish after the run was interrupted", () => {
    const stale = foldRuns([
      event(1, "agent_run.requested", requested),
      event(2, "agent_run.started", { runId: requested.runId, ownerToken: "owner-1" }),
      event(3, "agent_run.finished", {
        runId: requested.runId,
        ownerToken: "intruder",
        outcome: "succeeded",
        exitCode: 0
      })
    ]);
    expect(stale[0]).toMatchObject({ status: "running", acceptance: "not_applicable" });

    const afterRestart = foldRuns([
      event(1, "agent_run.requested", requested),
      event(2, "agent_run.started", { runId: requested.runId, ownerToken: "owner-1" }),
      event(3, "agent_run.interrupted", { runId: requested.runId, reason: "gateway restarted" }),
      event(4, "agent_run.finished", {
        runId: requested.runId,
        ownerToken: "owner-1",
        outcome: "succeeded",
        exitCode: 0
      })
    ]);
    expect(afterRestart[0]?.status).toBe("interrupted");
  });

  it("assesses results from evidence, not the exit code", () => {
    const ok = { outcome: "succeeded" as const, output: "all good" };
    expect(assessResult("edit", ok, { changedFiles: ["a"], commitsAhead: 0 })).toMatchObject({
      outcome: "succeeded",
      resultCheck: "changes_present"
    });
    expect(assessResult("edit", ok, { changedFiles: [], commitsAhead: 0 })).toMatchObject({
      outcome: "succeeded",
      resultCheck: "no_changes"
    });
    expect(assessResult("edit", ok, undefined)).toMatchObject({ outcome: "failed", resultCheck: "inspection_failed" });
    expect(assessResult("read-only", ok, { changedFiles: [], commitsAhead: 1 })).toMatchObject({
      outcome: "failed",
      resultCheck: "unexpected_changes"
    });
    // A signature in the output only matters when no work was produced.
    const noisy = { outcome: "succeeded" as const, output: "fixed the 401 unauthorized handler" };
    expect(assessResult("edit", noisy, { changedFiles: ["a"], commitsAhead: 0 }).outcome).toBe("succeeded");
    expect(assessResult("edit", noisy, { changedFiles: [], commitsAhead: 0 }).outcome).toBe("failed");
    expect(assessResult("edit", { outcome: "cancelled", output: "" }, undefined)).toEqual({ outcome: "cancelled" });
  });
});

describe("restart recovery of agent processes", () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const seed = (dbPath: string, runId: string, pid: number, startTicks: number | null) => {
    const store = new SqliteWorkItemStore(dbPath);
    const attrs = { "agent_run.id": runId };
    store.recordSystemEvent({
      name: "agent_run.requested",
      body: { runId, agentId: "claude", mode: "edit", repoRoot: "/x", actorId: "user", ownerToken: "t" },
      attributes: attrs
    });
    store.recordSystemEvent({
      name: "agent_run.process_started",
      body: { runId, ownerToken: "t", pid, startTicks },
      attributes: attrs
    });
    store.close();
  };

  it("terminates an orphaned agent process whose identity still matches, and reports it", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "acs-orphan-")));
    const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    child.unref();
    try {
      const pid = child.pid!;
      seed(join(root, "c.db"), "run_bbbbbbbbbbbb", pid, processStartTicks(pid) ?? null);
      const app = buildGateway({
        dbPath: join(root, "c.db"),
        logger: false,
        agentDispatch: { enabled: true, repoRoots: [root], maxConcurrent: 1, worktreeRoot: root, outputRoot: root },
        auth: { token: "", actor: "user", actorId: "user", credentials }
      });
      const run = (await app.inject({ method: "GET", url: "/api/agent-runs", headers: bearer(OP) })).json().runs[0];
      expect(run.status).toBe("interrupted");
      expect(run.error).toMatch(/orphaned agent process was terminated/);
      await waitFor(async () => (alive(pid) ? undefined : true), 5_000);
      await app.close();
    } finally {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        /* already terminated */
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never signals a process it cannot prove is the recorded one", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "acs-orphan-")));
    const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    child.unref();
    try {
      seed(join(root, "c.db"), "run_cccccccccccc", child.pid!, 1);
      const app = buildGateway({
        dbPath: join(root, "c.db"),
        logger: false,
        agentDispatch: { enabled: true, repoRoots: [root], maxConcurrent: 1, worktreeRoot: root, outputRoot: root },
        auth: { token: "", actor: "user", actorId: "user", credentials }
      });
      const run = (await app.inject({ method: "GET", url: "/api/agent-runs", headers: bearer(OP) })).json().runs[0];
      expect(run.status).toBe("interrupted");
      expect(alive(child.pid!)).toBe(true);
      await app.close();
    } finally {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        /* already terminated */
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ACS-decided tool calls for Claude runs", () => {
  const FAKE_CLAUDE = `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
const hook = settings.hooks.PreToolUse[0].hooks[0].command;
const cwd = process.cwd();
const calls = [
  { tool_name: "Write", tool_input: { file_path: cwd + "/ok.txt" } },
  { tool_name: "Write", tool_input: { file_path: "/etc/acs-should-not-write" } },
  { tool_name: "Bash", tool_input: { command: "git push origin main" } }
];
for (const call of calls) {
  const r = spawnSync("sh", ["-c", hook], { input: JSON.stringify(call), encoding: "utf8" });
  const out = r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason : "allowed";
  console.log("CALL " + call.tool_name + " => " + out);
}
`;

  async function runWithGuard(guardUrl: "live" | string) {
    const bin2 = join(root, "bin");
    const path = join(bin2, "claude");
    writeFileSync(path, FAKE_CLAUDE.replace("const { spawnSync }", "const { spawnSync }"));
    chmodSync(path, 0o755);
    const cfg = config();
    const app = makeGateway(cfg);
    if (guardUrl === "live") {
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      cfg.guardUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    } else {
      cfg.guardUrl = guardUrl;
    }
    const payload = { ...request, repo };
    const hash = (
      await app.inject({ method: "POST", url: "/api/agent-runs/preview", headers: bearer(OP), payload })
    ).json().preview.confirmationHash;
    const sent = await app.inject({
      method: "POST",
      url: "/api/agent-runs",
      headers: bearer(OP),
      payload: { ...payload, confirmationHash: hash }
    });
    const runId = sent.json().run.runId as string;
    const done = await waitFor(async () => {
      const r = (await app.inject({ method: "GET", url: `/api/agent-runs/${runId}`, headers: bearer(OP) })).json();
      return r.run.status === "queued" || r.run.status === "running" ? undefined : r;
    });
    return { app, runId, done };
  }

  it("has ACS decide and audit each call, and the run token dies with the run", async () => {
    const { app, runId, done } = await runWithGuard("live");
    expect(done.output).toContain("CALL Write => allowed");
    expect(done.output).toMatch(/CALL Write => ACS tool guard: writes are limited/);
    expect(done.output).toMatch(/CALL Bash => ACS tool guard: git push is not allowed/);
    expect(done.run.toolCalls).toMatchObject({ total: 3, denied: 2 });
    const store = new SqliteWorkItemStore(join(root, "control.db"));
    try {
      const calls = store.readEvents({ name: "agent_run.tool_call", limit: 50 });
      // The local deny-list floor stops obviously denied calls before they leave the hook; only the allowed
      // call is decided by the gateway, and it is recorded in the audit chain.
      expect(calls.map((e) => (e.body as { decision: string }).decision)).toEqual(["allow"]);
      expect(store.verifyAuditChain().ok).toBe(true);
    } finally {
      store.close();
    }
    const stale = await app.inject({
      method: "POST",
      url: `/api/agent-runs/${runId}/tool-check`,
      headers: { authorization: "Bearer not-the-token" },
      payload: { tool: "Write", input: { file_path: "/x" } }
    });
    expect(stale.statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/agent-runs/${runId}/tool-check`,
          payload: { tool: "Write", input: {} }
        })
      ).statusCode
    ).toBe(401);
  }, 30_000);

  it("fails closed when the gateway cannot be reached", async () => {
    const { done } = await runWithGuard("http://127.0.0.1:9");
    expect(done.output).toMatch(/CALL Write => ACS tool guard: ACS gateway unreachable; failing closed/);
    expect(done.output).not.toContain("=> allowed");
    expect(done.run.toolCalls).toMatchObject({ total: 3, denied: 3 });
  }, 30_000);
});
