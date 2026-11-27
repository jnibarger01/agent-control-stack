import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import {
  factoryMissionId,
  factoryMissionPlan,
  type FactoryRepositoryReader,
  type RepositoryResolution
} from "@agent-control-stack/ai-factory";
import { CodingMissionStore } from "@agent-control-stack/coding-mission";
import { buildGateway } from "./server.js";
import { sessionCookieName } from "./credentials.js";
import {
  FACTORY_INTAKE_EVENTS,
  createGitHubFactoryRepositoryReader,
  factoryIntakeConfigFromEnv,
  type FactoryIntakeConfig
} from "./factory-intake.js";

const SHA = "c".repeat(40);
const REPO = "jnibarger01/agent-control-stack";

function intent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "acs.ai-factory.intent.v1",
    orderId: "order_001",
    objective: "Add a scoped health endpoint with tests",
    repository: REPO,
    baseSha: SHA,
    acceptanceCriteria: ["Healthy fixture returns HTTP 200"],
    permittedPaths: ["apps/gateway/src"],
    forbiddenPaths: [],
    budget: { maxLanes: 2, maxWallClockMs: 1_200_000, maxSpendMicrousd: 2_000_000 },
    delivery: { mode: "draft_pr" },
    ...overrides
  };
}

const credentials = [
  { id: "alice", token: "alice-token", actor: "user", actorId: "alice", roles: ["operator"], scopes: ["acs:read", "acs:write"] },
  { id: "bob", token: "bob-token", actor: "user", actorId: "bob", roles: ["operator"], scopes: ["acs:read", "acs:write"] },
  { id: "alice-laptop", token: "alice-laptop-token", actor: "user", actorId: "alice", roles: ["operator"], scopes: ["acs:read", "acs:write"] },
  { id: "reader", token: "reader-token", actor: "user", actorId: "reader", roles: ["operator"], scopes: ["acs:read"] },
  { id: "worker", token: "worker-token", actor: "agent", actorId: "worker-1", roles: ["worker"], scopes: ["acs:write"] }
] as const;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function fixture(
  options: { enabled?: boolean; resolution?: RepositoryResolution; previewsPerMinute?: number; now?: () => Date } = {}
) {
  const root = mkdtempSync(join(tmpdir(), "acs-factory-intake-"));
  const dbPath = join(root, "control.db");
  const reads: string[] = [];
  const reader: FactoryRepositoryReader = {
    async resolve(repository, sha) {
      reads.push(repository + "@" + sha);
      return options.resolution ?? { status: "resolved", repositoryId: 7, fullName: REPO, commitSha: SHA, archived: false };
    }
  };
  const config: FactoryIntakeConfig = {
    enabled: options.enabled ?? true,
    policy: { version: "test-policy", repositories: [REPO], maxLanes: 2, maxWallClockMs: 3_600_000, maxSpendMicrousd: 1_000_000 },
    reader,
    ...(options.previewsPerMinute ? { previewsPerMinute: options.previewsPerMinute } : {}),
    ...(options.now ? { now: options.now } : {})
  };
  const app = buildGateway({
    dbPath,
    logger: false,
    factoryIntake: config,
    auth: { token: "", actor: "user", credentials: credentials.map((c) => ({ ...c, roles: [...c.roles], scopes: [...c.scopes] })) }
  });
  const post = (payload: unknown, token?: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url: "/api/factory/preview",
      headers: { ...(token ? { authorization: "Bearer " + token } : {}), ...headers },
      payload: payload as Record<string, unknown>
    });
  const events = (name: string) => {
    const store = new SqliteWorkItemStore(dbPath);
    try {
      return store.readEvents({ name, limit: 100 });
    } finally {
      store.close();
    }
  };
  const workItemCount = () => {
    const store = new SqliteWorkItemStore(dbPath);
    try {
      return store.list().length;
    } finally {
      store.close();
    }
  };
  cleanups.push(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { app, post, reads, events, workItemCount, dbPath };
}

describe("AI Factory F1 intake route", () => {
  it("returns a principal-bound preview, audits it, and creates no mission", async () => {
    const ctx = fixture();
    const response = await ctx.post(intent(), "alice-token");
    expect(response.statusCode, response.body).toBe(200);
    const { preview } = response.json();
    expect(preview).toMatchObject({ outcome: "previewable", principal: "alice", admitted: false, authority: "none" });
    expect(ctx.workItemCount()).toBe(0);
    const audited = ctx.events(FACTORY_INTAKE_EVENTS.previewed);
    expect(audited).toHaveLength(1);
    expect(audited[0]!.body).toMatchObject({ principal: "alice", previewHash: preview.previewHash });
    // Untrusted free text is not copied into the audit log.
    expect(JSON.stringify(audited[0]!.body)).not.toContain("health endpoint");
  });

  it("isolates two users: same body, different principal-bound hashes", async () => {
    const ctx = fixture();
    const a = (await ctx.post(intent(), "alice-token")).json().preview;
    const b = (await ctx.post(intent(), "bob-token")).json().preview;
    expect(a.intentHash).toBe(b.intentHash);
    expect(a.previewHash).not.toBe(b.previewHash);
    expect([a.principal, b.principal]).toEqual(["alice", "bob"]);
  });

  it("denies unauthenticated, read-only and worker callers before reading the repository", async () => {
    const ctx = fixture();
    expect((await ctx.post(intent())).statusCode).toBe(401);
    expect((await ctx.post(intent(), "not-a-token")).statusCode).toBe(401);
    expect((await ctx.post(intent(), "reader-token")).statusCode).toBe(403);
    expect((await ctx.post(intent(), "worker-token")).statusCode).toBe(403);
    expect(ctx.reads).toEqual([]);
  });

  it("refuses a forged actor in the body instead of trusting it", async () => {
    const ctx = fixture();
    const response = await ctx.post(intent({ actor: "admin" }), "alice-token");
    expect(response.statusCode).toBe(422);
    expect(response.json().preview).toMatchObject({ outcome: "refused", reason: "invalid_intent" });
    expect(ctx.events(FACTORY_INTAKE_EVENTS.refused)[0]!.body).toMatchObject({ principal: "alice", reason: "invalid_intent" });
  });

  it("refuses malformed and oversized requests", async () => {
    const ctx = fixture();
    expect((await ctx.post(intent({ baseSha: "HEAD" }), "alice-token")).statusCode).toBe(422);
    const malformed = await ctx.app.inject({
      method: "POST",
      url: "/api/factory/preview",
      headers: { authorization: "Bearer alice-token", "content-type": "application/json" },
      payload: "{not json"
    });
    expect(malformed.statusCode).toBe(400);
    const huge = await ctx.post(intent({ objective: "x".repeat(70_000) }), "alice-token");
    expect(huge.statusCode).toBe(413);
    expect(ctx.reads).toEqual([]);
  });

  it.each([
    [{ status: "commit_not_found" }, "base_commit_not_found"],
    [{ status: "identity_drift" }, "repository_identity_drift"],
    [{ status: "resolved", repositoryId: 7, fullName: REPO, commitSha: "d".repeat(40), archived: false }, "base_ref_drift"]
  ] as [RepositoryResolution, string][])("refuses resolution %j as %s", async (resolution, reason) => {
    const ctx = fixture({ resolution });
    const response = await ctx.post(intent(), "alice-token");
    expect(response.statusCode).toBe(422);
    expect(response.json().preview.reason).toBe(reason);
  });

  it("is off unless enabled, and still requires authentication when off", async () => {
    const ctx = fixture({ enabled: false });
    expect((await ctx.post(intent())).statusCode).toBe(401);
    const response = await ctx.post(intent(), "alice-token");
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe("factory_intake_disabled");
    expect(ctx.reads).toEqual([]);
  });

  it("rate-limits per principal and audits the denial", async () => {
    const ctx = fixture({ previewsPerMinute: 2 });
    expect((await ctx.post(intent(), "alice-token")).statusCode).toBe(200);
    expect((await ctx.post(intent(), "alice-token")).statusCode).toBe(200);
    const limited = await ctx.post(intent(), "alice-token");
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    // Another principal has its own budget.
    expect((await ctx.post(intent(), "bob-token")).statusCode).toBe(200);
    const audited = ctx.events(FACTORY_INTAKE_EVENTS.rateLimited);
    expect(audited).toHaveLength(1);
    expect(audited[0]!.body).toMatchObject({ principal: "alice" });
  });

  it("refuses a cross-site cookie-authenticated browser POST (CSRF guard)", async () => {
    // Bearer-token clients are not CSRF-exposed (a browser never attaches the header by itself);
    // the guard covers cookie sessions, and runs before authentication.
    const ctx = fixture();
    const response = await ctx.post(intent(), undefined, {
      cookie: sessionCookieName + "=any-session",
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site"
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("csrf_origin_mismatch");
    expect(ctx.reads).toEqual([]);
  });
});

describe("AI Factory F1 configuration", () => {
  it("is disabled by default and fails closed with no allowlist", () => {
    const config = factoryIntakeConfigFromEnv({});
    expect(config.enabled).toBe(false);
    expect(config.policy.repositories).toEqual([]);
    expect(config.policy.maxSpendMicrousd).toBe(0);
  });

  it("rejects a malformed allowlist or budget instead of guessing", () => {
    expect(() => factoryIntakeConfigFromEnv({ ACS_FACTORY_REPOSITORIES: "https://github.com/a/b" })).toThrow();
    expect(() => factoryIntakeConfigFromEnv({ ACS_FACTORY_MAX_LANES: "-1" })).toThrow();
  });
});

describe("read-only GitHub repository reader", () => {
  function fakeFetch(routes: Record<string, { status: number; body?: unknown }>, seen: RequestInit[] = []) {
    return (async (url: string | URL, init?: RequestInit) => {
      seen.push(init ?? {});
      const route = routes[String(url).replace("https://api.github.com", "")];
      if (!route) return new Response("not found", { status: 404 });
      return new Response(route.body === undefined ? null : JSON.stringify(route.body), { status: route.status });
    }) as typeof fetch;
  }
  const repoPath = "/repos/jnibarger01/agent-control-stack";

  it("resolves an exact commit using only GET, without following redirects", async () => {
    const seen: RequestInit[] = [];
    const reader = createGitHubFactoryRepositoryReader({
      tokenSource: () => "read-token",
      fetchImpl: fakeFetch(
        {
          [repoPath]: { status: 200, body: { id: 7, full_name: REPO, archived: false } },
          [repoPath + "/commits/" + SHA]: { status: 200, body: { sha: SHA } }
        },
        seen
      )
    });
    expect(await reader.resolve(REPO, SHA)).toEqual({
      status: "resolved",
      repositoryId: 7,
      fullName: REPO,
      commitSha: SHA,
      archived: false
    });
    expect(seen.every((init) => init.method === "GET" && init.redirect === "manual")).toBe(true);
  });

  it.each([
    [{ [repoPath]: { status: 301 } }, "identity_drift"],
    [{}, "repository_not_found"],
    [{ [repoPath]: { status: 500 } }, "unavailable"],
    [{ [repoPath]: { status: 200, body: { id: 7, full_name: REPO } }, [repoPath + "/commits/" + SHA]: { status: 422 } }, "commit_not_found"],
    [{ [repoPath]: { status: 200, body: { id: 7, full_name: REPO } }, [repoPath + "/commits/" + SHA]: { status: 409 } }, "commit_not_found"],
    [{ [repoPath]: { status: 200, body: { full_name: REPO } } }, "unavailable"]
  ] as [Record<string, { status: number; body?: unknown }>, string][])("maps %j to %s", async (routes, status) => {
    const reader = createGitHubFactoryRepositoryReader({ tokenSource: () => undefined, fetchImpl: fakeFetch(routes) });
    expect((await reader.resolve(REPO, SHA)).status).toBe(status);
  });

  it("reports a thrown network error as unavailable", async () => {
    const reader = createGitHubFactoryRepositoryReader({
      tokenSource: () => undefined,
      fetchImpl: (async () => {
        throw new Error("ECONNRESET");
      }) as typeof fetch
    });
    expect(await reader.resolve(REPO, SHA)).toEqual({ status: "unavailable" });
  });
});

describe("AI Factory F2 admission", () => {
  async function previewHash(ctx: ReturnType<typeof fixture>, body = intent(), token = "alice-token"): Promise<string> {
    const response = await ctx.post(body, token);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().preview.previewHash as string;
  }
  const admit = (ctx: ReturnType<typeof fixture>, body: unknown, token = "alice-token") =>
    ctx.app.inject({
      method: "POST",
      url: "/api/factory/admit",
      headers: { authorization: "Bearer " + token },
      payload: body as Record<string, unknown>
    });
  const missionCount = (ctx: ReturnType<typeof fixture>) => {
    const missions = new CodingMissionStore(ctx.dbPath);
    try {
      return missions.listRecent(100).length;
    } finally {
      missions.close();
    }
  };

  it("admits one PLANNING mission bound to the principal and dispatches nothing", async () => {
    const ctx = fixture();
    const hash = await previewHash(ctx);
    const response = await admit(ctx, { intent: intent(), expectedPreviewHash: hash });
    expect(response.statusCode, response.body).toBe(201);
    const { admission } = response.json();
    expect(admission).toMatchObject({ state: "PLANNING", replayed: false, dispatched: false, previewHash: hash });
    expect(admission.missionId).toBe(factoryMissionId("alice", "order_001"));
    const missions = new CodingMissionStore(ctx.dbPath);
    try {
      const record = missions.require(admission.missionId);
      expect(record.initiatorId).toBe("alice");
      expect(record.summary).not.toContain("health endpoint");
      expect(missions.budget(admission.missionId)?.limits).toMatchObject({ parallel_work_units: 2 });
    } finally {
      missions.close();
    }
    expect(ctx.events(FACTORY_INTAKE_EVENTS.admitted)).toHaveLength(1);
  });

  it("single-creates under concurrent duplicate submissions and replays the same admission", async () => {
    const ctx = fixture();
    const hash = await previewHash(ctx);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => admit(ctx, { intent: intent(), expectedPreviewHash: hash }))
    );
    const statuses = results.map((r) => r.statusCode).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200 || s === 429)).toHaveLength(5);
    expect(new Set(results.filter((r) => r.statusCode < 300).map((r) => r.json().admission.missionId)).size).toBe(1);
    expect(missionCount(ctx)).toBe(1);
    expect(ctx.events(FACTORY_INTAKE_EVENTS.admitted)).toHaveLength(1);
  });

  it("conflicts when the same order id is resubmitted with a changed payload", async () => {
    const ctx = fixture();
    expect((await admit(ctx, { intent: intent(), expectedPreviewHash: await previewHash(ctx) })).statusCode).toBe(201);
    const changed = intent({ objective: "A different objective for the same order" });
    const response = await admit(ctx, { intent: changed, expectedPreviewHash: await previewHash(ctx, changed) });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("factory_order_conflict");
    expect(missionCount(ctx)).toBe(1);
  });

  it("refuses a stale or fabricated preview hash without creating a mission", async () => {
    const ctx = fixture();
    const response = await admit(ctx, { intent: intent(), expectedPreviewHash: "0".repeat(64) });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: "factory_preview_stale" });
    expect(missionCount(ctx)).toBe(0);
    expect(ctx.events(FACTORY_INTAKE_EVENTS.admissionRefused)[0]!.body).toMatchObject({ reason: "factory_preview_stale" });
  });

  it("refuses another principal's preview hash (hash is principal-bound)", async () => {
    const ctx = fixture();
    const aliceHash = await previewHash(ctx);
    const response = await admit(ctx, { intent: intent(), expectedPreviewHash: aliceHash }, "bob-token");
    expect(response.statusCode).toBe(409);
    expect(missionCount(ctx)).toBe(0);
  });

  it("refuses malformed admission bodies and unauthenticated callers", async () => {
    const ctx = fixture();
    expect((await admit(ctx, { intent: intent() })).statusCode).toBe(400);
    expect((await admit(ctx, { intent: intent(), expectedPreviewHash: "x", actor: "admin" })).statusCode).toBe(400);
    expect((await admit(ctx, { intent: intent(), expectedPreviewHash: "a".repeat(64) }, "reader-token")).statusCode).toBe(403);
    const anonymous = await ctx.app.inject({ method: "POST", url: "/api/factory/admit", payload: {} });
    expect(anonymous.statusCode).toBe(401);
    expect(missionCount(ctx)).toBe(0);
  });

  it("reconciles a crash between the mission insert and the admission audit on replay", async () => {
    const ctx = fixture();
    const hash = await previewHash(ctx);
    // Simulate the crash window: the mission row (with its own creation event) exists, the binding does not.
    const preview = (await ctx.post(intent(), "alice-token")).json().preview;
    const plan = factoryMissionPlan(preview);
    const missions = new CodingMissionStore(ctx.dbPath);
    missions.create({
      ...plan,
      budget: { ...plan.budget },
      branch: "acs/mission/" + plan.missionId,
      deploymentRequired: false,
      deploymentAction: "none",
      deploymentImpact: "Draft pull request only. No merge, push to the base branch, or deployment.",
      now: new Date().toISOString()
    });
    missions.close();
    expect(ctx.events(FACTORY_INTAKE_EVENTS.admitted)).toHaveLength(0);
    const replay = await admit(ctx, { intent: intent(), expectedPreviewHash: hash });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().admission).toMatchObject({ replayed: true, missionId: plan.missionId });
    expect(ctx.events(FACTORY_INTAKE_EVENTS.admitted)).toHaveLength(1);
    await admit(ctx, { intent: intent(), expectedPreviewHash: hash });
    expect(ctx.events(FACTORY_INTAKE_EVENTS.admitted)).toHaveLength(1);
  });

  it("scopes mission reads to the initiating principal (no IDOR)", async () => {
    const ctx = fixture();
    const { admission } = (await admit(ctx, { intent: intent(), expectedPreviewHash: await previewHash(ctx) })).json();
    const read = (token: string, id = admission.missionId as string) =>
      ctx.app.inject({ method: "GET", url: "/api/factory/missions/" + id, headers: { authorization: "Bearer " + token } });
    expect((await read("alice-token")).statusCode).toBe(200);
    expect((await read("alice-token")).json().mission.state).toBe("PLANNING");
    const bob = await read("bob-token");
    const missing = await read("bob-token", factoryMissionId("bob", "nope"));
    expect(bob.statusCode).toBe(404);
    expect(bob.body).toBe(missing.body);
    expect((await read("alice-token", "../../etc")).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: "/api/factory/missions/" + admission.missionId })).statusCode).toBe(401);
  });
});

describe("AI Factory F3 plan DAG and budget admission", () => {
  const as = (ctx: ReturnType<typeof fixture>, method: "GET" | "POST", url: string, payload?: unknown, token = "alice-token") =>
    ctx.app.inject({
      method,
      url,
      headers: { authorization: "Bearer " + token },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> })
    });
  async function admitted(ctx: ReturnType<typeof fixture>, body = intent()) {
    const hash = (await ctx.post(body, "alice-token")).json().preview.previewHash;
    const response = await as(ctx, "POST", "/api/factory/admit", { intent: body, expectedPreviewHash: hash });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().admission.missionId as string;
  }
  const unit = (unitId: string, dependsOn: string[] = []) => ({
    unitId,
    title: "Implement " + unitId,
    dependsOn,
    paths: ["apps/gateway/src"]
  });
  const plan = (missionId: string, units: unknown[], revision = 1, previousPlanDigest: string | null = null) => ({
    schemaVersion: "acs.ai-factory.plan.v1",
    missionId,
    revision,
    previousPlanDigest,
    units
  });

  it("records a validated plan revision without materializing units", async () => {
    const ctx = fixture({ previewsPerMinute: 50 });
    const id = await admitted(ctx);
    const response = await as(ctx, "POST", `/api/factory/missions/${id}/plans`, {
      intent: intent(),
      plan: plan(id, [unit("a"), unit("b"), unit("c", ["a", "b"])])
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().plan).toMatchObject({ revision: 1, layers: [["a", "b"], ["c"]], accepted: false });
    const missions = new CodingMissionStore(ctx.dbPath);
    expect(missions.operations(id)).toHaveLength(0);
    missions.close();
  });

  it("refuses graph errors and fan-out beyond the mission's parallel budget", async () => {
    const ctx = fixture({ previewsPerMinute: 50 });
    const id = await admitted(ctx);
    for (const units of [
      [unit("a", ["b"]), unit("b", ["a"])],
      [unit("a", ["ghost"])],
      [unit("a"), unit("b"), unit("c")]
    ]) {
      const response = await as(ctx, "POST", `/api/factory/missions/${id}/plans`, { intent: intent(), plan: plan(id, units) });
      expect(response.statusCode, response.body).toBe(422);
      expect(response.json().code).toBe("factory_plan_invalid");
    }
  });

  it("refuses an intent that is not the one bound at admission", async () => {
    const ctx = fixture({ previewsPerMinute: 50 });
    const id = await admitted(ctx);
    const response = await as(ctx, "POST", `/api/factory/missions/${id}/plans`, {
      intent: intent({ permittedPaths: ["apps"] }),
      plan: plan(id, [unit("a")])
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("factory_intent_mismatch");
  });

  it("chains revisions and rejects a stale parent hash", async () => {
    const ctx = fixture({ previewsPerMinute: 50 });
    const id = await admitted(ctx);
    const url = `/api/factory/missions/${id}/plans`;
    const r1 = (await as(ctx, "POST", url, { intent: intent(), plan: plan(id, [unit("a")]) })).json().plan;
    const r2 = await as(ctx, "POST", url, { intent: intent(), plan: plan(id, [unit("a"), unit("b", ["a"])], 2, r1.planDigest) });
    expect(r2.statusCode, r2.body).toBe(201);
    // A planner still working from revision 1 cannot fork the lineage.
    const forked = await as(ctx, "POST", url, { intent: intent(), plan: plan(id, [unit("x")], 2, r1.planDigest) });
    expect(forked.statusCode).toBe(409);
    expect(forked.json()).toMatchObject({ code: "factory_plan_stale", expectedRevision: 3 });
    // Replaying the exact recorded revision is idempotent.
    const replay = await as(ctx, "POST", url, { intent: intent(), plan: plan(id, [unit("a"), unit("b", ["a"])], 2, r1.planDigest) });
    expect(replay.statusCode).toBe(200);
    // Accepting the superseded revision is stale.
    const staleAccept = await as(ctx, "POST", `${url}/accept`, { planDigest: r1.planDigest, intent: intent() });
    expect(staleAccept.statusCode).toBe(409);
    expect(staleAccept.json().code).toBe("factory_plan_stale");
  });

  it("materializes accepted units under the budget, idempotently, then freezes the plan", async () => {
    const ctx = fixture({ previewsPerMinute: 50 });
    const id = await admitted(ctx);
    const url = `/api/factory/missions/${id}/plans`;
    const recorded = (await as(ctx, "POST", url, { intent: intent(), plan: plan(id, [unit("a"), unit("b", ["a"])]) })).json().plan;
    const accepted = await as(ctx, "POST", `${url}/accept`, { planDigest: recorded.planDigest, intent: intent() });
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect(accepted.json()).toMatchObject({ dispatched: false, plan: { accepted: true } });
    expect(accepted.json().units.map((u: { unitId: string }) => u.unitId).sort()).toEqual(["a", "b"]);
    expect((await as(ctx, "POST", `${url}/accept`, { planDigest: recorded.planDigest, intent: intent() })).statusCode).toBe(200);
    const late = await as(ctx, "POST", url, { intent: intent(), plan: plan(id, [unit("z")], 2, recorded.planDigest) });
    expect(late.statusCode).toBe(409);
    expect(late.json().code).toBe("factory_plan_frozen");
    expect(ctx.events(FACTORY_INTAKE_EVENTS.planAccepted)).toHaveLength(1);
  });

  it("registers independent-verification requirements on accept, so units become claimable within budget", async () => {
    const ctx = fixture({ previewsPerMinute: 50 });
    const id = await admitted(ctx);
    const url = `/api/factory/missions/${id}/plans`;
    const recorded = (await as(ctx, "POST", url, { intent: intent(), plan: plan(id, [unit("a"), unit("b")]) })).json().plan;
    await as(ctx, "POST", `${url}/accept`, { planDigest: recorded.planDigest, intent: intent() });
    const missions = new CodingMissionStore(ctx.dbPath);
    try {
      expect(missions.verificationRequirement(id, "a")).toBeDefined();
      const at = new Date().toISOString();
      const claim = (unitId: string, token: string) => missions.claimUnit(id, unitId, { token, workerId: "w1", route: {}, claimedAt: at });
      expect(claim("a", "t1")).toMatchObject({ ok: true });
      expect(claim("b", "t2")).toMatchObject({ ok: true });
      // A third concurrent claim would exceed parallel_work_units = 2 (enforced on every claim).
      missions.addWorkUnits(id, [{ unitId: "c", kind: "coding", title: "extra", verificationPolicy: "none" }], at);
      expect(claim("c", "t3")).toMatchObject({ ok: false, outcome: "budget_exhausted" });
    } finally {
      missions.close();
    }
  });

  it("refuses accept with an intent that is not the admitted one", async () => {
    const ctx = fixture({ previewsPerMinute: 50 });
    const id = await admitted(ctx);
    const url = `/api/factory/missions/${id}/plans`;
    const recorded = (await as(ctx, "POST", url, { intent: intent(), plan: plan(id, [unit("a")]) })).json().plan;
    const response = await as(ctx, "POST", `${url}/accept`, { planDigest: recorded.planDigest, intent: intent({ objective: "Something else entirely" }) });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("factory_intent_mismatch");
  });

  it("refuses materialization once the mission wall-clock budget is spent (exact boundary)", async () => {
    let clock = Date.parse("2026-11-18T00:00:00.000Z");
    const ctx = fixture({ previewsPerMinute: 50, now: () => new Date(clock) });
    const id = await admitted(ctx);
    const url = `/api/factory/missions/${id}/plans`;
    const recorded = (await as(ctx, "POST", url, { intent: intent(), plan: plan(id, [unit("a")]) })).json().plan;
    // Budget is 1_200_000 ms from admission. One millisecond past it, materialization is refused.
    clock += 1_200_001;
    const refused = await as(ctx, "POST", `${url}/accept`, { planDigest: recorded.planDigest, intent: intent() });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: "factory_budget_refused" });
    expect(refused.json().exhausted.map((entry: { metric: string }) => entry.metric)).toContain("wall_clock_ms");
    const missions = new CodingMissionStore(ctx.dbPath);
    expect(missions.operations(id)).toHaveLength(0);
    missions.close();
    // Just inside the budget it is admitted.
    clock -= 2;
    expect((await as(ctx, "POST", `${url}/accept`, { planDigest: recorded.planDigest, intent: intent() })).statusCode).toBe(201);
  });

  it("hides other principals' missions behind a uniform 404", async () => {
    const ctx = fixture({ previewsPerMinute: 50 });
    const id = await admitted(ctx);
    const response = await as(ctx, "POST", `/api/factory/missions/${id}/plans`, { intent: intent(), plan: plan(id, [unit("a")]) }, "bob-token");
    expect(response.statusCode).toBe(404);
  });
});

describe("AI Factory F10 operator view and metrics", () => {
  const SECRET = "ghp_" + "Z".repeat(36);
  const secretIntent = () => intent({ objective: "Add endpoint; do not leak " + SECRET });
  const get = (ctx: ReturnType<typeof fixture>, url: string, token = "alice-token") =>
    ctx.app.inject({ method: "GET", url, headers: { authorization: "Bearer " + token } });
  const post = (ctx: ReturnType<typeof fixture>, url: string, payload: unknown, token = "alice-token") =>
    ctx.app.inject({ method: "POST", url, headers: { authorization: "Bearer " + token }, payload: payload as Record<string, unknown> });

  async function admittedMission(ctx: ReturnType<typeof fixture>) {
    const hash = (await ctx.post(secretIntent(), "alice-token")).json().preview.previewHash;
    return (await post(ctx, "/api/factory/admit", { intent: secretIntent(), expectedPreviewHash: hash })).json().admission.missionId as string;
  }

  it("projects stages only from recorded state and labels the next action as advisory", async () => {
    const ctx = fixture({ previewsPerMinute: 50 });
    const id = await admittedMission(ctx);
    const view = async () => (await get(ctx, `/api/factory/missions/${id}/view`)).json().view;
    expect(await view()).toMatchObject({ stage: "awaiting_plan", pinnedBaseSha: SHA, plan: null, nextAction: { authority: "advisory" } });
    const recorded = (
      await post(ctx, `/api/factory/missions/${id}/plans`, {
        intent: secretIntent(),
        plan: { schemaVersion: "acs.ai-factory.plan.v1", missionId: id, revision: 1, previousPlanDigest: null, units: [{ unitId: "a", title: "Implement a", dependsOn: [], paths: ["apps/gateway/src"] }] }
      })
    ).json().plan;
    expect(await view()).toMatchObject({ stage: "plan_review", plan: { revision: 1, accepted: false } });
    await post(ctx, `/api/factory/missions/${id}/plans/accept`, { planDigest: recorded.planDigest, intent: secretIntent() });
    const accepted = await view();
    expect(accepted).toMatchObject({ stage: "pending_dispatch", plan: { accepted: true }, units: [{ unitId: "a", status: "pending" }] });
    expect(accepted.budget.limits).toMatchObject({ parallel_work_units: 2 });
  });

  it("gives two concurrent sessions of the same operator an identical projection, and hides it from others", async () => {
    const ctx = fixture({ previewsPerMinute: 50 });
    const id = await admittedMission(ctx);
    const [a, b] = await Promise.all([get(ctx, `/api/factory/missions/${id}/view`), get(ctx, `/api/factory/missions/${id}/view`, "alice-laptop-token")]);
    expect(a.statusCode).toBe(200);
    expect(a.body).toBe(b.body);
    expect((await get(ctx, `/api/factory/missions/${id}/view`, "bob-token")).statusCode).toBe(404);
    expect((await get(ctx, "/api/factory/backlog", "bob-token")).json()).toEqual({ missions: [] });
    expect((await ctx.app.inject({ method: "GET", url: "/api/factory/backlog" })).statusCode).toBe(401);
    expect((await get(ctx, "/api/factory/backlog")).json().missions.map((m: { missionId: string }) => m.missionId)).toEqual([id]);
  });

  it("never exposes objective text or secret-shaped strings in views, backlog, audit-derived plan data or metrics", async () => {
    const ctx = fixture({ previewsPerMinute: 50 });
    const id = await admittedMission(ctx);
    for (const url of [`/api/factory/missions/${id}/view`, "/api/factory/backlog", `/api/factory/missions/${id}`, "/metrics"]) {
      const response = await get(ctx, url);
      expect(response.statusCode, url).toBe(200);
      expect(response.body, url).not.toContain(SECRET);
      expect(response.body, url).not.toContain("do not leak");
    }
    for (const name of Object.values(FACTORY_INTAKE_EVENTS)) {
      expect(JSON.stringify(ctx.events(name))).not.toContain(SECRET);
    }
  });

  it("counts factory requests by route template and status, never by mission id", async () => {
    const ctx = fixture({ previewsPerMinute: 50 });
    const id = await admittedMission(ctx);
    await get(ctx, `/api/factory/missions/${id}/view`);
    const metrics = (await get(ctx, "/metrics")).body;
    expect(metrics).toMatch(/acs_factory_requests_total\{[^}]*route="\/api\/factory\/missions\/:id\/view"[^}]*\}/u);
    expect(metrics).toMatch(/acs_factory_requests_total\{[^}]*route="\/api\/factory\/admit"/u);
    expect(metrics).not.toContain(id);
  });
});
