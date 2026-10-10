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
  current = "about:blank";
  calls: string[] = [];
  failClick = false;
  redirectTo: string | undefined;
  signal: AbortSignal | undefined;

  url(): string {
    return this.current;
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
      },
      fill: async (text: string) => {
        this.calls.push(`fill:${selector}:${text}`);
      }
    };
  }

  mouse = {
    wheel: async (dx: number, dy: number) => {
      this.calls.push(`wheel:${dx}:${dy}`);
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
      return { page, close: async () => {} };
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
    const { adapter, dispatch, store, checkpoints, opens } = harness(script([{ type: "click", selector: "#go" }]));
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
  });

  it("cancels before an action without claiming an external effect", async () => {
    const { adapter, dispatch, checkpoints, opens } = harness(script([{ type: "click", selector: "#go" }]));
    const signal = AbortSignal.abort();
    await expect(adapter.execute(dispatch, signal)).resolves.toMatchObject({
      outcome: "cancelled",
      externalStateUncertain: false,
      failure: { category: "cancelled", retrySafe: false }
    });
    expect(checkpoints()).toEqual([]);
    expect(opens()).toBe(0);
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
      failure: { category: "cancelled" }
    });
    expect(checkpoints().map((row) => [row.action_type, row.state])).toEqual([["navigate", "committed"]]);
    expect(page.calls).not.toContain("screenshot");
  });

  it("leaves a browser throw after planned uncertain and does not call the browser again", async () => {
    const { adapter, dispatch, page, checkpoints, opens } = harness(script([{ type: "click", selector: "#go" }]));
    page.current = `${ORIGIN}/inbox`;
    page.failClick = true;
    await expect(adapter.execute(dispatch)).resolves.toMatchObject({
      outcome: "unknown",
      externalStateUncertain: true,
      failure: { retrySafe: false }
    });
    expect(checkpoints()).toEqual([expect.objectContaining({ state: "uncertain", action_type: "click" })]);
    expect(page.calls.filter((call) => call.startsWith("click:"))).toHaveLength(1);
    await expect(adapter.execute(dispatch)).resolves.toMatchObject({
      outcome: "unknown",
      externalStateUncertain: true
    });
    expect(page.calls.filter((call) => call.startsWith("click:"))).toHaveLength(1);
    expect(opens()).toBe(1);
    expect(JSON.stringify(checkpoints())).not.toContain(SECRET);
  });

  it("starts a Playwright-shaped page at about:blank", async () => {
    const page = new FakePage();
    page.current = "https://evil.example/";
    const browser = new PlaywrightCuaBrowser(async () => page);
    const session = await browser.open("browser");
    expect(page.calls).toEqual(["goto:about:blank"]);
    expect(page.url()).toBe("about:blank");
    await session.close();
  });
});
