import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CuaExecutionAdapter, PlaywrightCuaBrowser, type CuaBrowserProvider, type CuaPage } from "./cua-execution.js";
import { parseWorkUnitPayload, type CuaAction } from "./mission-model.js";
import { CodingMissionStore } from "./store.js";
import { WorkUnitExecutionLedger } from "./worker-execution.js";

const T0 = "2026-10-10T00:00:00.000Z";
const T1 = "2026-10-10T00:00:01.000Z";
const T2 = "2026-10-10T00:00:02.000Z";
const ORIGIN = "https://app.example";
const SECRET = "super-secret-phrase";
const SHOT = Buffer.from("PNG-SECRET-BYTES");

class FakePage implements CuaPage {
  current = "https://preset.example/";
  calls: string[] = [];
  failClick = false;
  redirectTo: string | undefined;
  followTo: string | undefined;
  closed = false;
  signal: AbortSignal | undefined;

  url(): string {
    return this.current;
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
  const ledger = new WorkUnitExecutionLedger(store);
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

function harness(payload: ReturnType<typeof script> | { kind: "cua"; objective: string }, application = "browser") {
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
  const adapter = new CuaExecutionAdapter(ctx.store, browser, application, () => T2);
  const checkpoints = () =>
    ctx.store.db
      .prepare(
        `SELECT sequence, action_type, state, screenshot_hash, receipt_hash, origin, action_hash, claim_token_hash
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
});
