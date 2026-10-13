import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CuaExecutionAdapter,
  PlaywrightCuaBrowser,
  secretBrokerCuaResolver,
  type CuaBrowserContext,
  type CuaBrowserProvider,
  type CuaExecutionOptions,
  type CuaPage,
  type CuaRoute
} from "./cua-execution.js";
import { parseWorkUnitPayload, type CuaAction } from "./mission-model.js";
import { CodingMissionStore } from "./store.js";
import { cuaCheckpointReceiptHash, cuaResultHash } from "./cua-evidence.js";
import { WorkUnitExecutionLedger, resultBase, type DispatchEnvelope } from "./worker-execution.js";
import { setupRealGrants } from "./child-work-real-grants-fixture.js";

const T0 = "2026-10-10T00:00:00.000Z";
const T1 = "2026-10-10T00:00:01.000Z";
const T2 = "2026-10-10T00:00:02.000Z";
const ORIGIN = "https://app.example";
const SECRET = "super-secret-phrase";
const SHOT = Buffer.from("PNG-SECRET-BYTES");

/** A Playwright-shaped context: a context-wide route, its page list, and the "page" event for popups. */
class FakeContext implements CuaBrowserContext {
  routes: Array<(route: CuaRoute) => unknown> = [];
  extraPages: CuaPage[] = [];
  listeners: Array<(page: CuaPage) => void> = [];
  blocked: string[] = [];
  allowed: string[] = [];
  constructor(private readonly owner: FakePage) {}

  async route(_url: string, handler: (route: CuaRoute) => unknown): Promise<void> {
    this.routes.push(handler);
  }

  pages(): CuaPage[] {
    return [this.owner, ...this.extraPages];
  }

  on(_event: "page", listener: (page: CuaPage) => void): void {
    this.listeners.push(listener);
  }

  /** Simulate a request leaving any page in the context; returns whether the route let it through. */
  async request(url: string): Promise<boolean> {
    let verdict = true;
    for (const handler of this.routes) {
      await handler({
        request: () => ({ url: () => url }),
        continue: async () => {
          this.allowed.push(url);
        },
        abort: async () => {
          verdict = false;
          this.blocked.push(url);
        }
      });
    }
    return verdict;
  }

  /** Simulate a popup (window.open / target=_blank) opening in the context. */
  popup(page: CuaPage): void {
    this.extraPages.push(page);
    for (const listener of this.listeners) listener(page);
  }
}

class FakePage implements CuaPage {
  current = "https://preset.example/";
  fakeContext: FakeContext = new FakeContext(this);
  calls: string[] = [];
  failClick = false;
  redirectTo: string | undefined;
  followTo: string | undefined;
  closed = false;
  signal: AbortSignal | undefined;

  url(): string {
    return this.current;
  }

  context(): CuaBrowserContext {
    return this.fakeContext;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async screenshot(): Promise<Uint8Array> {
    this.calls.push("screenshot");
    return SHOT;
  }

  locator(selector: string) {
    return {
      click: async () => {
        this.calls.push(`click:${selector}`);
        if (this.failClick) throw new Error(`click failed token=${SECRET}`);
        if (this.followTo) this.current = this.followTo;
      },
      fill: async (text: string) => {
        this.calls.push(`fill:${selector}:${text}`);
        if (this.followTo) this.current = this.followTo;
      }
    };
  }

  mouse = {
    wheel: async (dx: number, dy: number) => {
      this.calls.push(`wheel:${dx}:${dy}`);
      if (this.followTo) this.current = this.followTo;
    }
  };

  async goto(url: string): Promise<void> {
    this.calls.push(`goto:${url}`);
    this.current = this.redirectTo ?? url;
    if (this.signal) this.signal.throwIfAborted?.();
  }
}

function script(actions: CuaAction[], extra: { applications?: string[]; origins?: string[] } = {}) {
  return {
    kind: "cua" as const,
    objective: "inspect",
    allowedApplications: extra.applications ?? ["browser"],
    allowedOrigins: extra.origins ?? [ORIGIN],
    actions
  };
}

function claimed(payload: ReturnType<typeof script> | { kind: "cua"; objective: string }) {
  const store = new CodingMissionStore(":memory:");
  store.createGeneral({ missionId: "m1", summary: "cua", now: T0 });
  store.addWorkUnits("m1", [{ unitId: "u1", kind: "cua", title: "browse", payload }], T0);
  store.releaseReadyUnits("m1", T0);
  const claim = {
    token: "claim-super-secret",
    workerId: "worker-1",
    route: { lane: "cua" as const, implementerEngineId: "browser-worker" },
    claimedAt: T1
  };
  expect(store.claimUnit("m1", "u1", claim)).toMatchObject({ ok: true, attempt: 1 });
  // CUA runs only in governed missions. These adapter tests bind the mission and stand in a verifier that admits this
  // dispatch; the real browser-grant verifier is exercised in dispatch-authority.test.ts and the R2 end-to-end test.
  store.db
    .prepare(
      `INSERT INTO mission_authority (mission_id, envelope_json, envelope_hash, policy_json, policy_hash, approver_id,
         reason, grant_id, grant_hash, created_at) VALUES ('m1', '{}', ?, '{}', ?, 'human', 'cua test', 'g1', ?, ?)`
    )
    .run("a".repeat(64), "b".repeat(64), "c".repeat(64), T0);
  const ledger = new WorkUnitExecutionLedger(store, {
    clock: () => T1,
    authority: {
      verifyDispatch: () => ({
        ok: true,
        grantId: "g1",
        unitAuthorityHash: "d".repeat(64),
        executingActorId: "worker-1",
        maxRuntimeMs: 3_600_000,
        expiresAt: "2099-01-01T00:00:00.000Z"
      })
    }
  });
  const dispatch = ledger.beginDispatch({
    missionId: "m1",
    unitId: "u1",
    claimToken: claim.token,
    workerId: claim.workerId,
    lane: "cua",
    authority: { leaseId: "lease-1", fencingToken: 7, actionHash: "a".repeat(64) },
    now: T1
  });
  return { store, ledger, dispatch, claim };
}

function harness(
  payload: ReturnType<typeof script> | { kind: "cua"; objective: string },
  application = "browser",
  options: CuaExecutionOptions = {}
) {
  const ctx = claimed(payload);
  const page = new FakePage();
  let opens = 0;
  const browser: CuaBrowserProvider = {
    async open(opened) {
      opens += 1;
      page.calls.push(`open:${opened}`);
      page.current = "about:blank";
      return page;
    }
  };
  const adapter = new CuaExecutionAdapter(ctx.store, browser, application, () => T2, options);
  const checkpoints = () =>
    ctx.store.db
      .prepare(
        `SELECT sequence, action_type, state, screenshot_hash, receipt_hash, origin, action_hash, claim_token_hash, application
         FROM cua_action_checkpoints ORDER BY sequence`
      )
      .all() as Array<Record<string, unknown>>;
  return { ...ctx, page, adapter, checkpoints, opens: () => opens };
}

describe("CUA payload boundary", () => {
  it("rejects unknown actions, oversized fields, and non-exact origins", () => {
    expect(() => parseWorkUnitPayload("cua", { objective: "x", actions: [{ type: "evaluate" }] })).toThrow(
      /bad actions/
    );
    expect(() =>
      parseWorkUnitPayload("cua", { objective: "x", actions: [{ type: "click", selector: "a", extra: 1 }] })
    ).toThrow(/bad actions/);
    expect(() => parseWorkUnitPayload("cua", { objective: "x", allowedOrigins: ["https://app.example/path"] })).toThrow(
      /bad allowedOrigins/
    );
    expect(() => parseWorkUnitPayload("cua", { objective: "x", allowedOrigins: ["https://*.example"] })).toThrow(
      /bad allowedOrigins/
    );
    expect(() => parseWorkUnitPayload("cua", { objective: "x", grant: "admin" })).toThrow(/unknown field/);
    expect(parseWorkUnitPayload("cua", script([{ type: "scroll", dx: 0, dy: -10 }]))).toMatchObject({
      actions: [{ type: "scroll", dx: 0, dy: -10 }]
    });
  });
});

describe("governed CUA browser execution", () => {
  it("stores hashes for an allowlisted script and never the screenshot bytes or typed text", async () => {
    const actions: CuaAction[] = [
      { type: "observe" },
      { type: "navigate", url: `${ORIGIN}/inbox` },
      { type: "type", selector: "#q", text: SECRET },
      { type: "click", selector: "#go" },
      { type: "scroll", dx: 0, dy: 40 }
    ];
    const { adapter, dispatch, page, checkpoints } = harness(script(actions));
    const result = await adapter.execute(dispatch);
    expect(result).toMatchObject({
      outcome: "succeeded",
      externalStateUncertain: false,
      receipts: [
        { kind: "cua_observe" },
        { kind: "cua_navigate" },
        { kind: "cua_type" },
        { kind: "cua_click" },
        { kind: "cua_scroll" }
      ]
    });
    expect(page.calls).toContain(`fill:#q:${SECRET}`);
    const rows = checkpoints();
    expect(rows.map((row) => row.state)).toEqual(["committed", "committed", "committed", "committed", "committed"]);
    expect(rows[0]).toMatchObject({
      screenshot_hash: createHash("sha256").update(SHOT).digest("hex"),
      origin: "about:blank"
    });
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain("PNG-SECRET-BYTES");
    expect(stored).not.toContain("claim-super-secret");
    expect(page.closed).toBe(true);
    expect(page.calls[0]).toBe("open:browser");
    expect(page.calls[1]).toBe("screenshot");
  });

  it("refuses a disallowed origin without committing a checkpoint or calling the page", async () => {
    const { adapter, dispatch, checkpoints, opens, page } = harness(
      script([{ type: "navigate", url: "https://evil.example/phish" }])
    );
    await expect(adapter.execute(dispatch)).resolves.toMatchObject({
      outcome: "failed",
      externalStateUncertain: false,
      failure: { category: "policy_denied", nativeCode: "cua_origin_denied", retrySafe: false }
    });
    expect(checkpoints()).toEqual([]);
    expect(opens()).toBe(0);
    expect(page.calls).toEqual([]);
  });

  it("refuses an application outside the allowlist before any page call", async () => {
    const { adapter, dispatch, checkpoints, opens } = harness(script([{ type: "observe" }]), "terminal");
    await expect(adapter.execute(dispatch)).resolves.toMatchObject({
      outcome: "failed",
      failure: { category: "policy_denied", nativeCode: "cua_application_denied" }
    });
    expect(checkpoints()).toEqual([]);
    expect(opens()).toBe(0);
  });

  it("fails closed when either allowlist is empty or missing", async () => {
    const navigate = script([{ type: "navigate", url: `${ORIGIN}/inbox` }]);
    const cases = [
      script([{ type: "observe" }], { applications: [] }),
      { kind: "cua" as const, objective: "inspect", allowedOrigins: [ORIGIN], actions: [{ type: "observe" as const }] },
      { ...navigate, allowedOrigins: [] as string[] },
      { kind: "cua" as const, objective: "inspect", allowedApplications: ["browser"], actions: navigate.actions }
    ];
    for (const payload of cases) {
      const { adapter, dispatch, checkpoints, opens } = harness(payload);
      await expect(adapter.execute(dispatch)).resolves.toMatchObject({
        outcome: "failed",
        failure: { category: "policy_denied", retrySafe: false }
      });
      expect(checkpoints()).toEqual([]);
      expect(opens()).toBe(0);
    }
  });

  it("refuses a javascript URL before navigation", async () => {
    const { adapter, dispatch, checkpoints, opens, page } = harness(
      script([{ type: "navigate", url: "javascript:alert(1)" }])
    );
    await expect(adapter.execute(dispatch)).resolves.toMatchObject({
      outcome: "failed",
      failure: { nativeCode: "cua_scheme_denied" }
    });
    expect(checkpoints()).toEqual([]);
    expect(opens()).toBe(0);
    expect(page.calls).toEqual([]);
  });

  it("treats an off-origin landing as uncertain and stops the script", async () => {
    const { adapter, dispatch, page, checkpoints, opens } = harness(
      script([
        { type: "navigate", url: `${ORIGIN}/inbox` },
        { type: "click", selector: "#next" }
      ])
    );
    page.redirectTo = "https://evil.example/landed";
    await expect(adapter.execute(dispatch)).resolves.toMatchObject({
      outcome: "unknown",
      externalStateUncertain: true,
      failure: { retrySafe: false }
    });
    expect(checkpoints()).toEqual([
      expect.objectContaining({ action_type: "navigate", state: "uncertain", origin: "https://evil.example" })
    ]);
    expect(page.calls).toEqual([`open:browser`, `goto:${ORIGIN}/inbox`]);
    expect(opens()).toBe(1);
    expect(JSON.stringify(checkpoints().map((row) => row.origin))).not.toContain("?");
  });

  it.each(["claim", "fence"] as const)("rejects a stale %s and does not append a checkpoint", async (kind) => {
    const { adapter, dispatch, store, checkpoints, opens, page } = harness(
      script([
        { type: "navigate", url: `${ORIGIN}/inbox` },
        { type: "click", selector: "#go" }
      ])
    );
    if (kind === "claim") {
      store.db.prepare("UPDATE coding_operations SET claim_token = ? WHERE operation_id = 'u1'").run("replaced-token");
    } else {
      store.db
        .prepare("UPDATE work_unit_execution_attempts SET authority_json = ? WHERE attempt_id = ?")
        .run(JSON.stringify({ fencingToken: 8 }), dispatch.attemptId);
    }
    await expect(adapter.execute(dispatch)).rejects.toThrow(/CUA (fence|fencing token)/);
    expect(checkpoints()).toEqual([]);
    expect(opens()).toBe(0);
    expect(page.calls).toEqual([]);
    expect(page.current).toBe("https://preset.example/");
  });

  it("cancels before an action without claiming an external effect", async () => {
    const { adapter, dispatch, checkpoints, opens, page } = harness(
      script([
        { type: "navigate", url: `${ORIGIN}/inbox` },
        { type: "click", selector: "#go" }
      ])
    );
    const signal = AbortSignal.abort();
    await expect(adapter.execute(dispatch, signal)).resolves.toMatchObject({
      outcome: "cancelled",
      externalStateUncertain: false,
      failure: { category: "cancelled", retrySafe: false }
    });
    expect(checkpoints()).toEqual([]);
    expect(opens()).toBe(0);
    expect(page.calls).toEqual([]);
    expect(page.current).toBe("https://preset.example/");
  });

  it("cancels as uncertain after a committed mutating action", async () => {
    const controller = new AbortController();
    const { adapter, dispatch, page, checkpoints } = harness(
      script([{ type: "navigate", url: `${ORIGIN}/inbox` }, { type: "observe" }])
    );
    const original = page.goto.bind(page);
    page.goto = async (url: string) => {
      await original(url);
      controller.abort();
    };
    await expect(adapter.execute(dispatch, controller.signal)).resolves.toMatchObject({
      outcome: "cancelled",
      externalStateUncertain: true,
      receipts: [expect.objectContaining({ kind: "cua_navigate" })],
      failure: { category: "cancelled", retrySafe: false }
    });
    expect(checkpoints().map((row) => [row.action_type, row.state])).toEqual([["navigate", "committed"]]);
    expect(page.calls).not.toContain("screenshot");
    expect(page.closed).toBe(true);
  });

  it("leaves a browser throw after an allowlisted navigate uncertain and does not call the browser again", async () => {
    const { adapter, dispatch, page, checkpoints, opens } = harness(
      script([
        { type: "navigate", url: `${ORIGIN}/inbox` },
        { type: "click", selector: "#go" }
      ])
    );
    page.failClick = true;
    await expect(adapter.execute(dispatch)).resolves.toMatchObject({
      outcome: "unknown",
      externalStateUncertain: true,
      receipts: [expect.objectContaining({ kind: "cua_navigate" })],
      failure: { retrySafe: false }
    });
    expect(checkpoints().map((row) => [row.action_type, row.state])).toEqual([
      ["navigate", "committed"],
      ["click", "uncertain"]
    ]);
    expect(page.calls).toEqual(["open:browser", `goto:${ORIGIN}/inbox`, "click:#go"]);
    expect(page.current).toBe(`${ORIGIN}/inbox`);
    await expect(adapter.execute(dispatch)).resolves.toMatchObject({
      outcome: "unknown",
      externalStateUncertain: true,
      receipts: [expect.objectContaining({ kind: "cua_navigate" })]
    });
    expect(page.calls.filter((call) => call.startsWith("click:"))).toHaveLength(1);
    expect(opens()).toBe(1);
    expect(JSON.stringify(checkpoints())).not.toContain(SECRET);
  });

  it("does not resume committed checkpoints on a fresh session", async () => {
    const { adapter, dispatch, page, checkpoints, opens } = harness(
      script([{ type: "navigate", url: `${ORIGIN}/inbox` }, { type: "observe" }])
    );
    await expect(adapter.execute(dispatch)).resolves.toMatchObject({
      outcome: "succeeded",
      externalStateUncertain: false,
      receipts: [expect.objectContaining({ kind: "cua_navigate" }), expect.objectContaining({ kind: "cua_observe" })]
    });
    const calls = [...page.calls];
    await expect(adapter.execute(dispatch)).resolves.toMatchObject({
      outcome: "unknown",
      externalStateUncertain: true,
      receipts: [expect.objectContaining({ kind: "cua_navigate" }), expect.objectContaining({ kind: "cua_observe" })],
      failure: { nativeCode: "cua_external_state_uncertain", retrySafe: false }
    });
    expect(page.calls).toEqual(calls);
    expect(opens()).toBe(1);
    expect(checkpoints().map((row) => row.state)).toEqual(["committed", "committed"]);
  });

  it("keeps a committed mutation uncertain when the signal is already aborted", async () => {
    const { adapter, dispatch, page, opens } = harness(
      script([
        { type: "navigate", url: `${ORIGIN}/inbox` },
        { type: "click", selector: "#go" }
      ])
    );
    await expect(adapter.execute(dispatch)).resolves.toMatchObject({ outcome: "succeeded" });
    const calls = page.calls.length;
    await expect(adapter.execute(dispatch, AbortSignal.abort())).resolves.toMatchObject({
      outcome: "cancelled",
      externalStateUncertain: true,
      receipts: [expect.objectContaining({ kind: "cua_navigate" }), expect.objectContaining({ kind: "cua_click" })],
      failure: { category: "cancelled", retrySafe: false }
    });
    expect(opens()).toBe(1);
    expect(page.calls).toHaveLength(calls);
  });

  it("cancels an observe-only checkpoint without claiming an external effect", async () => {
    const { adapter, dispatch, opens } = harness(script([{ type: "observe" }]));
    await expect(adapter.execute(dispatch)).resolves.toMatchObject({
      outcome: "succeeded",
      receipts: [expect.objectContaining({ kind: "cua_observe" })]
    });
    await expect(adapter.execute(dispatch, AbortSignal.abort())).resolves.toMatchObject({
      outcome: "cancelled",
      externalStateUncertain: false,
      receipts: [expect.objectContaining({ kind: "cua_observe" })],
      failure: { category: "cancelled", retrySafe: false }
    });
    expect(opens()).toBe(1);
  });

  it.each([
    [{ type: "click" as const, selector: "#go" }, "click:#go"],
    [{ type: "type" as const, selector: "#q", text: "visible" }, "fill:#q:visible"],
    [{ type: "scroll" as const, dx: 3, dy: 4 }, "wheel:3:4"]
  ])("stops when %j leaves an off-allowlist origin", async (action, call) => {
    const { adapter, dispatch, page, checkpoints } = harness(
      script([{ type: "navigate", url: `${ORIGIN}/inbox` }, action, { type: "observe" }])
    );
    page.followTo = "https://evil.example/after";
    await expect(adapter.execute(dispatch)).resolves.toMatchObject({
      outcome: "unknown",
      externalStateUncertain: true,
      receipts: [expect.objectContaining({ kind: "cua_navigate" })],
      failure: { retrySafe: false }
    });
    expect(checkpoints().map((row) => [row.action_type, row.state, row.origin])).toEqual([
      ["navigate", "committed", ORIGIN],
      [action.type, "uncertain", "https://evil.example"]
    ]);
    expect(page.calls).toEqual(["open:browser", `goto:${ORIGIN}/inbox`, call]);
    expect(page.closed).toBe(true);
  });

  it("returns unknown when an open page leaves the allowlist before the next action", async () => {
    const { adapter, dispatch, page, checkpoints } = harness(
      script([
        { type: "navigate", url: `${ORIGIN}/inbox` },
        { type: "click", selector: "#go" }
      ])
    );
    const readUrl = page.url.bind(page);
    let reads = 0;
    page.url = () => {
      const value = readUrl();
      reads += 1;
      if (reads === 1) page.current = "https://evil.example/drift";
      return value;
    };
    await expect(adapter.execute(dispatch)).resolves.toMatchObject({
      outcome: "unknown",
      externalStateUncertain: true,
      receipts: [expect.objectContaining({ kind: "cua_navigate" })],
      failure: { category: "unknown", nativeCode: "cua_external_state_uncertain", retrySafe: false }
    });
    expect(checkpoints().map((row) => [row.action_type, row.state, row.origin])).toEqual([
      ["navigate", "committed", ORIGIN]
    ]);
    expect(page.calls).toEqual(["open:browser", `goto:${ORIGIN}/inbox`]);
    expect(page.current).toBe("https://evil.example/drift");
  });

  it("refuses a click on the fresh about:blank page before opening", async () => {
    const { adapter, dispatch, page, checkpoints, opens } = harness(script([{ type: "click", selector: "#go" }]));
    page.current = `${ORIGIN}/inbox`;
    await expect(adapter.execute(dispatch)).resolves.toMatchObject({
      outcome: "failed",
      externalStateUncertain: false,
      failure: { category: "policy_denied", nativeCode: "cua_origin_denied", retrySafe: false }
    });
    expect(checkpoints()).toEqual([]);
    expect(opens()).toBe(0);
    expect(page.calls).toEqual([]);
    expect(page.current).toBe(`${ORIGIN}/inbox`);
  });

  it("starts a Playwright-shaped page at about:blank and closes that page", async () => {
    const page = new FakePage();
    page.current = "https://evil.example/";
    const browser = new PlaywrightCuaBrowser(async () => page);
    const opened = await browser.open("browser");
    expect(page.calls).toEqual(["goto:about:blank"]);
    expect(page.url()).toBe("about:blank");
    expect(opened).toBe(page);
    await opened.close();
    expect(page.closed).toBe(true);
  });

  it("closes the page when the about:blank reset throws and still rethrows that error", async () => {
    const page = new FakePage();
    page.goto = async (url: string) => {
      page.calls.push(`goto:${url}`);
      throw new Error("about:blank reset failed");
    };
    page.close = async () => {
      page.closed = true;
      throw new Error("close failed");
    };
    const browser = new PlaywrightCuaBrowser(async () => page);
    await expect(browser.open("browser")).rejects.toThrow("about:blank reset failed");
    expect(page.closed).toBe(true);
    expect(page.calls).toEqual(["goto:about:blank"]);
  });
});

const BROKERED = "hunter2-brokered-value";

describe("R4: typed secrets are broker-resolved references", () => {
  it("accepts a secretRef and refuses literal secrets in the payload", () => {
    expect(
      parseWorkUnitPayload("cua", script([{ type: "type", selector: "#password", secretRef: "APP_LOGIN" }]))
    ).toMatchObject({ actions: [{ type: "type", selector: "#password", secretRef: "APP_LOGIN" }] });
    const bad = (action: Record<string, unknown>) => () =>
      parseWorkUnitPayload("cua", { objective: "x", actions: [action] });
    expect(bad({ type: "type", selector: "#password", text: "hunter2" })).toThrow(/bad actions/);
    expect(bad({ type: "type", selector: "input[name=api_key]", text: "abc" })).toThrow(/bad actions/);
    expect(bad({ type: "type", selector: "#q", text: "ghp_" + "a".repeat(36) })).toThrow(/bad actions/);
    expect(bad({ type: "type", selector: "#q", text: "Bearer abcdefghijklmnop" })).toThrow(/bad actions/);
    expect(bad({ type: "type", selector: "#q", text: "sk-" + "b".repeat(32) })).toThrow(/bad actions/);
    expect(bad({ type: "type", selector: "#password", text: "x", secretRef: "APP_LOGIN" })).toThrow(/bad actions/);
    expect(bad({ type: "type", selector: "#password", secretRef: "bad ref!" })).toThrow(/bad actions/);
  });

  it("resolves the secret only at execution and never persists it in payload, dispatch, checkpoints or result", async () => {
    const resolved: Array<[string, Record<string, string>]> = [];
    const { adapter, dispatch, page, store, checkpoints } = harness(
      script([
        { type: "navigate", url: `${ORIGIN}/login` },
        { type: "type", selector: "#password", secretRef: "APP_LOGIN" }
      ]),
      "browser",
      {
        secrets: {
          async resolve(ref, principal) {
            resolved.push([ref, { ...principal }]);
            return BROKERED;
          }
        }
      }
    );
    const result = await adapter.execute(dispatch);
    expect(result).toMatchObject({ outcome: "succeeded" });
    expect(page.calls).toContain(`fill:#password:${BROKERED}`);
    expect(resolved).toEqual([
      [
        "APP_LOGIN",
        { workerId: "worker-1", missionId: "m1", unitId: "u1", attemptId: dispatch.attemptId, application: "browser" }
      ]
    ]);
    const persisted = JSON.stringify([
      store.db.prepare("SELECT payload_json FROM coding_operations").all(),
      store.db.prepare("SELECT dispatch_json FROM work_unit_execution_attempts").all(),
      checkpoints(),
      result,
      dispatch
    ]);
    expect(persisted).toContain("APP_LOGIN");
    expect(persisted).not.toContain(BROKERED);
  });

  it("refuses a secretRef script before any browser call when no resolver is configured", async () => {
    const { adapter, dispatch, page, opens, checkpoints } = harness(
      script([{ type: "type", selector: "#password", secretRef: "APP_LOGIN" }])
    );
    await expect(adapter.execute(dispatch)).resolves.toMatchObject({
      outcome: "failed",
      failure: { category: "policy_denied", nativeCode: "cua_secret_unavailable" }
    });
    expect(opens()).toBe(0);
    expect(page.calls).toEqual([]);
    expect(checkpoints()).toEqual([]);
  });

  it("leases the scope once for the dispatch principal through the secret broker and revokes it", async () => {
    const events: string[] = [];
    const handle = {
      injectInto(env: Record<string, string | undefined>, redeemer: Record<string, string>) {
        events.push(`inject:${JSON.stringify(redeemer)}`);
        env.APP_LOGIN = BROKERED;
      }
    };
    const resolver = secretBrokerCuaResolver({
      async lease(request) {
        events.push(`lease:${request.scope}:${request.maxUses}:${JSON.stringify(request.principal)}`);
        return handle;
      },
      async revoke(revoked) {
        expect(revoked).toBe(handle);
        events.push("revoke");
      }
    });
    const value = await resolver.resolve("APP_LOGIN", {
      workerId: "worker-1",
      missionId: "m1",
      unitId: "u1",
      attemptId: "att1",
      application: "browser"
    });
    expect(value).toBe(BROKERED);
    const principal = JSON.stringify({
      workerId: "worker-1",
      workItemId: "m1:u1",
      attemptId: "att1",
      engineId: "browser"
    });
    expect(events).toEqual([`lease:APP_LOGIN:1:${principal}`, `inject:${principal}`, "revoke"]);
  });
});

describe("R3: browser boundary", () => {
  it("enforces the origin allowlist on the whole context before the first action", async () => {
    const { adapter, dispatch, page } = harness(script([{ type: "navigate", url: `${ORIGIN}/inbox` }]));
    await expect(adapter.execute(dispatch)).resolves.toMatchObject({ outcome: "succeeded" });
    expect(page.fakeContext.routes).toHaveLength(1);
    await expect(page.fakeContext.request(`${ORIGIN}/api`)).resolves.toBe(true);
    await expect(page.fakeContext.request("https://evil.example/exfil")).resolves.toBe(false);
    await expect(page.fakeContext.request("javascript:alert(1)")).resolves.toBe(false);
    expect(page.fakeContext.blocked).toEqual(["https://evil.example/exfil", "javascript:alert(1)"]);
  });

  it("treats a popup as an escape: closes it, marks the action uncertain and stops", async () => {
    const { adapter, dispatch, page, checkpoints } = harness(
      script([{ type: "navigate", url: `${ORIGIN}/inbox` }, { type: "click", selector: "#open" }, { type: "observe" }])
    );
    const popup = new FakePage();
    popup.current = "https://evil.example/";
    const original = page.locator.bind(page);
    page.locator = (selector: string) => ({
      ...original(selector),
      click: async () => {
        page.calls.push(`click:${selector}`);
        page.fakeContext.popup(popup);
      }
    });
    await expect(adapter.execute(dispatch)).resolves.toMatchObject({
      outcome: "unknown",
      externalStateUncertain: true
    });
    expect(checkpoints().map((row) => [row.action_type, row.state])).toEqual([
      ["navigate", "committed"],
      ["click", "uncertain"]
    ]);
    expect(page.calls).not.toContain("screenshot");
    await Promise.resolve();
    expect(popup.closed).toBe(true);
    expect(page.closed).toBe(true);
  });

  it("fails closed when the page exposes no browser context", async () => {
    const { adapter, dispatch, page, checkpoints } = harness(script([{ type: "observe" }]));
    (page as unknown as { context: unknown }).context = undefined;
    await expect(adapter.execute(dispatch)).resolves.toMatchObject({ outcome: "unknown" });
    expect(page.calls).not.toContain("screenshot");
    expect(checkpoints().map((row) => row.state)).toEqual(["uncertain"]);
    expect(page.closed).toBe(true);
  });

  it("re-checks ownership immediately before each browser action", async () => {
    const ctx = harness(script([{ type: "observe" }]));
    const { adapter, dispatch, page, store } = ctx;
    // The claim moves to another worker after the checkpoint is planned but before the action runs.
    const browser = (adapter as unknown as { browser: CuaBrowserProvider }).browser;
    const open = browser.open.bind(browser);
    browser.open = async (application: string) => {
      const opened = await open(application);
      store.db.prepare("UPDATE coding_operations SET worker_id = 'worker-2' WHERE operation_id = 'u1'").run();
      return opened;
    };
    await expect(adapter.execute(dispatch)).rejects.toMatchObject({ code: "coding_mission_claim_conflict" });
    expect(page.calls).not.toContain("screenshot");
    expect(page.closed).toBe(true);
  });

  it("bounds every browser call by a deadline and closes the page", async () => {
    const { adapter, dispatch, page, checkpoints } = harness(script([{ type: "observe" }]), "browser", {
      actionTimeoutMs: 30
    });
    page.screenshot = () => new Promise<Uint8Array>(() => undefined);
    await expect(adapter.execute(dispatch)).resolves.toMatchObject({
      outcome: "unknown",
      externalStateUncertain: true
    });
    expect(checkpoints().map((row) => row.state)).toEqual(["uncertain"]);
    expect(page.closed).toBe(true);
  });

  it("aborts a hung browser call on the signal as an uncertain cancellation", async () => {
    const controller = new AbortController();
    const { adapter, dispatch, page, checkpoints } = harness(
      script([
        { type: "navigate", url: `${ORIGIN}/inbox` },
        { type: "click", selector: "#hang" }
      ]),
      "browser",
      { actionTimeoutMs: 60_000 }
    );
    const original = page.locator.bind(page);
    page.locator = (selector: string) => ({
      ...original(selector),
      click: () => {
        setTimeout(() => controller.abort(), 10);
        return new Promise<void>(() => undefined);
      }
    });
    await expect(adapter.execute(dispatch, controller.signal)).resolves.toMatchObject({
      outcome: "cancelled",
      externalStateUncertain: true
    });
    expect(checkpoints().map((row) => [row.action_type, row.state])).toEqual([
      ["navigate", "committed"],
      ["click", "uncertain"]
    ]);
    expect(page.closed).toBe(true);
  });

  it("bounds browser open by the deadline", async () => {
    const ctx = claimed(script([{ type: "observe" }]));
    const browser: CuaBrowserProvider = { open: () => new Promise<CuaPage>(() => undefined) };
    const adapter = new CuaExecutionAdapter(ctx.store, browser, "browser", () => T2, { actionTimeoutMs: 30 });
    await expect(adapter.execute(ctx.dispatch)).resolves.toMatchObject({ outcome: "unknown" });
  });
});

describe("R1: evidence-bound CUA acceptance", () => {
  const twoStep = () =>
    script(
      [
        { type: "navigate", url: `${ORIGIN}/inbox` },
        { type: "click", selector: "#go" }
      ],
      {
        applications: ["browser", "browser-profile-2"]
      }
    );

  it("accepts a result whose receipts are rebuilt from the committed checkpoints", async () => {
    const { adapter, dispatch, ledger, claim } = harness(twoStep());
    const result = await adapter.execute(dispatch);
    expect(result.outcome).toBe("succeeded");
    expect(ledger.applyResult({ claimToken: claim.token, result })).toEqual({ applied: "completed" });
  });

  it("refuses a success submitted without running the adapter (no checkpoints)", () => {
    const { dispatch, ledger, claim } = harness(twoStep());
    const forged = {
      ...resultBase(dispatch, T2),
      outcome: "succeeded" as const,
      receipts: [],
      result: { resultHash: "f".repeat(64), files: [] },
      externalStateUncertain: false
    };
    expect(ledger.applyResult({ claimToken: claim.token, result: forged })).toMatchObject({
      applied: "rejected_invalid",
      reason: "cua success requires every action to be committed"
    });
  });

  it("refuses receipts that differ from the committed checkpoints", async () => {
    const { adapter, dispatch, ledger, claim } = harness(twoStep());
    const result = await adapter.execute(dispatch);
    const forged = { ...result, receipts: [...result.receipts, { kind: "cua_click", hash: "e".repeat(64) }] };
    expect(ledger.applyResult({ claimToken: claim.token, result: forged })).toMatchObject({
      applied: "rejected_invalid",
      reason: "cua receipts do not match committed checkpoints"
    });
  });

  it("refuses a success whose script did not fully commit", async () => {
    const controller = new AbortController();
    const { adapter, dispatch, ledger, claim, page } = harness(twoStep());
    const original = page.goto.bind(page);
    page.goto = async (url: string) => {
      await original(url);
      controller.abort();
    };
    const partial = await adapter.execute(dispatch, controller.signal);
    const forged = {
      ...partial,
      outcome: "succeeded" as const,
      failure: undefined,
      result: { resultHash: cuaResultHash(partial.receipts), files: [] },
      externalStateUncertain: false
    };
    expect(ledger.applyResult({ claimToken: claim.token, result: forged })).toMatchObject({
      applied: "rejected_invalid",
      reason: "cua success requires every action to be committed"
    });
  });

  it("rejects a cua unit with no actions instead of reporting success", async () => {
    const { adapter, dispatch, ledger, claim, opens } = harness(script([]));
    const result = await adapter.execute(dispatch);
    expect(result).toMatchObject({
      outcome: "failed",
      failure: { category: "invalid_output", nativeCode: "cua_payload_invalid" }
    });
    expect(opens()).toBe(0);
    const forged = {
      ...resultBase(dispatch, T2),
      outcome: "succeeded" as const,
      receipts: [],
      result: { resultHash: cuaResultHash([]), files: [] },
      externalStateUncertain: false
    };
    expect(ledger.applyResult({ claimToken: claim.token, result: forged })).toMatchObject({
      applied: "rejected_invalid",
      reason: "cua success requires a non-empty action script"
    });
  });

  it("serializes executions: a second run cannot settle a live run's planned checkpoint", async () => {
    const { adapter, dispatch, page, checkpoints } = harness(twoStep());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = page.goto.bind(page);
    page.goto = async (url: string) => {
      await gate;
      await original(url);
    };
    const first = adapter.execute(dispatch);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(checkpoints().map((row) => row.state)).toEqual(["planned"]);
    await expect(adapter.execute(dispatch)).rejects.toMatchObject({ code: "cua_execution_in_progress" });
    expect(checkpoints().map((row) => row.state)).toEqual(["planned"]);
    release();
    await expect(first).resolves.toMatchObject({ outcome: "succeeded" });
    expect(checkpoints().map((row) => row.state)).toEqual(["committed", "committed"]);
  });

  it("recovers a planned checkpoint only after the previous owner's lock expired", async () => {
    const { adapter, dispatch, store, checkpoints } = harness(twoStep());
    const first = await adapter.execute(dispatch);
    expect(first.outcome).toBe("succeeded");
    // Simulate a crashed owner: a planned row past the end of the script cannot exist, so plant a stale lock instead.
    store.db
      .prepare("INSERT INTO cua_execution_locks (attempt_id, owner_id, expires_at) VALUES (?, 'crashed', ?)")
      .run(dispatch.attemptId, "2099-01-01T00:00:00.000Z");
    await expect(adapter.execute(dispatch)).rejects.toMatchObject({ code: "cua_execution_in_progress" });
    store.db
      .prepare("UPDATE cua_execution_locks SET expires_at = ? WHERE attempt_id = ?")
      .run("2000-01-01T00:00:00.000Z", dispatch.attemptId);
    await expect(adapter.execute(dispatch)).resolves.toMatchObject({ outcome: "unknown" });
    expect(checkpoints().map((row) => row.state)).toEqual(["committed", "committed"]);
  });

  it.each([
    ["a recomputed receipt hash mismatch", "UPDATE cua_action_checkpoints SET receipt_hash = 'x' WHERE sequence = 0"],
    [
      "an action hash that is not the dispatched action",
      "UPDATE cua_action_checkpoints SET action_hash = 'x' WHERE sequence = 0"
    ],
    [
      "a checkpoint bound to another worker",
      "UPDATE cua_action_checkpoints SET worker_id = 'worker-9' WHERE sequence = 0"
    ],
    [
      "a checkpoint for an application the payload does not allow",
      "UPDATE cua_action_checkpoints SET application = 'other' WHERE sequence = 0"
    ]
  ])("verifies persisted checkpoints on resume: %s is an integrity failure", async (_name, tamper) => {
    const controller = new AbortController();
    const { adapter, dispatch, page, store, ledger, claim } = harness(twoStep());
    const original = page.goto.bind(page);
    page.goto = async (url: string) => {
      await original(url);
      controller.abort();
    };
    const partial = await adapter.execute(dispatch, controller.signal);
    store.db.exec(tamper);
    await expect(adapter.execute(dispatch)).rejects.toMatchObject({ code: "cua_checkpoint_integrity" });
    expect(ledger.applyResult({ claimToken: claim.token, result: partial })).toMatchObject({
      applied: "rejected_invalid",
      reason: expect.stringContaining("cua checkpoint integrity failure")
    });
  });

  it("binds the selected application into every checkpoint and receipt hash", async () => {
    const { adapter, dispatch, checkpoints } = harness(twoStep());
    await adapter.execute(dispatch);
    const rows = checkpoints();
    expect(rows.map((row) => row.application)).toEqual(["browser", "browser"]);
    const row = rows[0]!;
    const hashFor = (application: string) =>
      cuaCheckpointReceiptHash({
        attemptId: dispatch.attemptId,
        sequence: 0,
        application,
        actionType: "navigate",
        actionHash: row.action_hash as string,
        state: "committed",
        origin: row.origin as string,
        screenshotHash: null
      });
    expect(row.receipt_hash).toBe(hashFor("browser"));
    expect(hashFor("browser-profile-2")).not.toBe(row.receipt_hash);
  });

  it("refuses to resume an attempt with a different selected application", async () => {
    const controller = new AbortController();
    const ctx = harness(twoStep());
    const original = ctx.page.goto.bind(ctx.page);
    ctx.page.goto = async (url: string) => {
      await original(url);
      controller.abort();
    };
    await ctx.adapter.execute(ctx.dispatch, controller.signal);
    const other = new CuaExecutionAdapter(ctx.store, { open: async () => ctx.page }, "browser-profile-2", () => T2);
    await expect(other.execute(ctx.dispatch)).rejects.toMatchObject({
      code: "cua_checkpoint_integrity",
      message: expect.stringContaining("application_mismatch")
    });
  });
});

describe("R2: the executor runs only the stored dispatch", () => {
  const actions: CuaAction[] = [{ type: "navigate", url: `${ORIGIN}/` }, { type: "observe" }];
  const tampered = (dispatch: DispatchEnvelope, edit: (payload: Record<string, unknown>) => void): DispatchEnvelope => {
    const copy = JSON.parse(JSON.stringify(dispatch)) as DispatchEnvelope;
    edit(copy.payload as unknown as Record<string, unknown>);
    return copy;
  };

  it("rejects a tampered payload (actions, origins or application) before any browser call", async () => {
    const edits: Array<(payload: Record<string, unknown>) => void> = [
      (p) => {
        p.actions = [{ type: "navigate", url: "https://evil.example/" }];
      },
      (p) => {
        p.allowedOrigins = [ORIGIN, "https://evil.example"];
      },
      (p) => {
        p.allowedApplications = ["browser", "other-app"];
      },
      (p) => {
        (p.actions as CuaAction[]).push({ type: "click", selector: "#buy" });
      }
    ];
    for (const edit of edits) {
      const h = harness(script(actions));
      await expect(h.adapter.execute(tampered(h.dispatch, edit))).rejects.toMatchObject({
        code: "cua_dispatch_mismatch"
      });
      expect(h.opens()).toBe(0);
      expect(h.page.calls).toEqual([]);
      expect(h.checkpoints()).toEqual([]);
    }
  });

  it("cannot widen the grant through the caller's payload, even when every other field matches", async () => {
    const h = harness(script(actions, { origins: [ORIGIN] }));
    const widened = tampered(h.dispatch, (p) => {
      p.allowedOrigins = ["https://evil.example"];
      p.actions = [{ type: "navigate", url: "https://evil.example/" }];
    });
    // Recomputing payloadHash on the caller side does not help: the stored dispatch hash is the authority.
    await expect(h.adapter.execute(widened)).rejects.toMatchObject({ code: "cua_dispatch_mismatch" });
    expect(h.opens()).toBe(0);
  });

  it("fails closed when the stored dispatch is missing", async () => {
    const h = harness(script(actions));
    // The attempt lock references the attempt row, so an unknown attempt is refused before the stored-dispatch load
    // (FOREIGN KEY on cua_execution_locks); executeLocked's own cua_dispatch_missing check is the second line.
    const unknown = { ...h.dispatch, attemptId: "attempt-never-stored" };
    await expect(h.adapter.execute(unknown)).rejects.toThrow();
    expect(h.opens()).toBe(0);
  });

  it("fails closed with cua_dispatch_missing when the stored attempt is not a cua dispatch", async () => {
    const h = harness(script(actions));
    h.store.db
      .prepare("UPDATE work_unit_execution_attempts SET executor_lane = 'coder' WHERE attempt_id = ?")
      .run(h.dispatch.attemptId);
    await expect(h.adapter.execute(h.dispatch)).rejects.toMatchObject({ code: "cua_dispatch_missing" });
    expect(h.opens()).toBe(0);
  });

  it("fails closed when the stored dispatch no longer matches its recorded hash", async () => {
    const h = harness(script(actions));
    const row = h.store.db
      .prepare("SELECT dispatch_json FROM work_unit_execution_attempts WHERE attempt_id = ?")
      .get(h.dispatch.attemptId) as { dispatch_json: string };
    const stored = JSON.parse(row.dispatch_json) as DispatchEnvelope;
    (stored.payload as unknown as { allowedOrigins: string[] }).allowedOrigins = ["https://evil.example"];
    h.store.db
      .prepare("UPDATE work_unit_execution_attempts SET dispatch_json = ? WHERE attempt_id = ?")
      .run(JSON.stringify(stored), h.dispatch.attemptId);
    await expect(h.adapter.execute(stored)).rejects.toMatchObject({ code: "cua_dispatch_integrity" });
    await expect(h.adapter.execute(h.dispatch)).rejects.toMatchObject({ code: "cua_dispatch_integrity" });
    expect(h.opens()).toBe(0);
  });

  it("fails closed when the stored hash itself is altered", async () => {
    const h = harness(script(actions));
    h.store.db
      .prepare("UPDATE work_unit_execution_attempts SET dispatch_hash = ? WHERE attempt_id = ?")
      .run("0".repeat(64), h.dispatch.attemptId);
    await expect(h.adapter.execute(h.dispatch)).rejects.toMatchObject({ code: "cua_dispatch_integrity" });
    expect(h.opens()).toBe(0);
  });

  it("runs the unmodified stored dispatch", async () => {
    const h = harness(script(actions));
    const result = await h.adapter.execute(JSON.parse(JSON.stringify(h.dispatch)) as DispatchEnvelope);
    expect(result.outcome).toBe("succeeded");
    expect(h.opens()).toBe(1);
  });

  it("runs end to end under a real human-issued browser grant and the real dispatch verifier", async () => {
    const f = setupRealGrants({
      cuaRootPayload: script(actions),
      extraToolClasses: [
        { runtime: "browser", toolName: "cua", allowedOrigins: [ORIGIN], allowedApplications: ["browser"] }
      ]
    });
    f.ledger.grantMissionAuthority({ missionId: f.item.id, grantId: f.grant.grantId });
    expect(f.missions.claimUnit(f.item.id, "root", f.claim)).toMatchObject({ ok: true });
    const dispatcher = new WorkUnitExecutionLedger(f.missions, { authority: f.ledger });
    const dispatch = dispatcher.beginDispatch({
      missionId: f.item.id,
      unitId: "root",
      claimToken: f.claim.token,
      workerId: f.claim.workerId,
      lane: "cua",
      now: f.iso(2_000)
    });
    const page = new FakePage();
    let opens = 0;
    const adapter = new CuaExecutionAdapter(
      f.missions,
      {
        async open() {
          opens += 1;
          page.current = "about:blank";
          return page;
        }
      },
      "browser",
      () => f.iso(2_100)
    );
    const result = await adapter.execute(dispatch);
    expect(result.outcome).toBe("succeeded");
    expect(opens).toBe(1);
  });
});
