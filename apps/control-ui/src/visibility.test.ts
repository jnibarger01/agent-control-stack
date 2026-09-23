import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import {
  auditAttributesHtml,
  METRICS_POLL_MS,
  renderDashboard,
  summarizePolicyDecisions,
  THEME_STORAGE_KEY,
  type MissionControlViewModel
} from "./index.js";
import { bootLive } from "./live-harness.test-support.js";

type AuditEvent = MissionControlViewModel["events"][number];
const NOW = new Date("2026-09-22T00:01:00.000Z");

function decided(sequence: number, decision: string, kind: string, rules: string[], reason = `${decision} ${kind}`) {
  return {
    sequence,
    name: "policy.decided",
    timeUnixNano: String(BigInt(1_790_000_000_000 + sequence) * 1_000_000n),
    attributes: { "work_item.id": `wrk_${sequence}`, "policy.decision": decision },
    body: { workItemId: `wrk_${sequence}`, decision, reason, matchedRules: rules, context: { action: { kind } } }
  } as unknown as AuditEvent;
}

const POLICY_EVENTS = [
  decided(1, "allow", "fs.read", ["allow:read"]),
  decided(2, "allow", "fs.read", ["allow:read"]),
  decided(3, "require_approval", "fs.write", ["require:fs-write"]),
  decided(4, "deny", "teleport", ["deny:unknown-action"], "unknown action kind is denied"),
  decided(5, "deny", "shell", ["deny:sudo", "deny:shell"], "sudo is denied"),
  { sequence: 6, name: "work_item.created", timeUnixNano: "1", attributes: {} } as unknown as AuditEvent
];

describe("policy decisions panel (#18)", () => {
  it("summarizes decisions, kinds, rules, and recent denials", () => {
    const summary = summarizePolicyDecisions(POLICY_EVENTS);
    expect(summary.total).toBe(5);
    expect(summary.byDecision).toEqual({ allow: 2, require_approval: 1, deny: 2 });
    expect(summary.byKind.map((row) => row.kind)).toEqual(["shell", "teleport", "fs.write", "fs.read"]);
    expect(summary.byKind.find((row) => row.kind === "fs.read")).toEqual({
      kind: "fs.read",
      allow: 2,
      require_approval: 0,
      deny: 0
    });
    expect(summary.topRules[0]).toEqual({ rule: "allow:read", count: 2 });
    expect(summary.recentDenials.map((denial) => denial.workItemId)).toEqual(["wrk_5", "wrk_4"]);
    expect(summary.recentDenials[0]?.reason).toBe("sudo is denied");
  });

  it("renders the summary and supported kinds on the Policy panel", () => {
    const html = renderDashboard({
      workItems: [],
      events: [],
      policyDecisionEvents: POLICY_EVENTS,
      composerActionKinds: ["fs.read", "fs.write"],
      now: NOW
    });
    const { document } = new JSDOM(html).window;
    const panel = document.querySelector("#policy-body");
    expect(panel?.querySelector(".decision-deny dd")?.textContent).toBe("2");
    expect(panel?.querySelector(".decision-allow dd")?.textContent).toBe("2");
    expect(panel?.textContent).toContain("Last 5 decisions.");
    expect(panel?.textContent).toContain("unknown action kind is denied");
    expect([...(panel?.querySelectorAll(".chip") ?? [])].map((chip) => chip.textContent)).toEqual([
      "fs.read",
      "fs.write"
    ]);
  });

  it("says so when there are no decisions", () => {
    const html = renderDashboard({ workItems: [], events: [], now: NOW });
    expect(new JSDOM(html).window.document.querySelector("#policy-body")?.textContent).toContain(
      "No policy decisions in the recent window."
    );
  });
});

describe("readable audit rows (#20)", () => {
  it("shows a short summary with an expandable, redacted key/value list", () => {
    const { document } = new JSDOM(
      `<li>${auditAttributesHtml({
        "http.method": "POST",
        "work_item.id": "wrk_1",
        // Assembled at runtime so secret scanners never see a credential-shaped literal.
        authorization: ["Bear", "er ", "abcdefghijklmnop"].join(""),
        "policy.decision": "deny",
        nested: { token: "t" }
      })}</li>`
    ).window;
    expect(document.querySelector(".event-summary")?.textContent).toBe("work_item.id=wrk_1 · policy.decision=deny");
    expect(document.querySelector("summary")?.textContent).toBe("5 attributes");
    const rows = [...document.querySelectorAll(".event-attrs dl div")].map((row) => [
      row.querySelector("dt")?.textContent,
      row.querySelector("dd")?.textContent
    ]);
    expect(rows).toContainEqual(["authorization", "[redacted]"]);
    expect(rows).toContainEqual(["nested", '{"token":"[redacted]"}']);
    expect(document.body.textContent).not.toContain("abcdefghijklmnop");
    expect(auditAttributesHtml({})).toBe('<small class="event-summary">no attributes</small>');
  });

  it("renders live SSE rows with the same markup as server rows", async () => {
    const attributes = { "work_item.id": "wrk_9", "agent.id": "agent-1", note: "x" };
    const event = { sequence: 9, name: "work_item.running", timeUnixNano: "1790000000000000000", attributes };
    const server = new JSDOM(
      renderDashboard({ workItems: [], events: [event as unknown as AuditEvent], now: NOW })
    ).window.document.querySelector("#events-timeline li");
    const app = bootLive({ workItems: [], events: [], now: NOW });
    app.open();
    app.emit("work_item.running", attributes);
    const client = app.document.querySelector("#events-timeline li");
    for (const selector of [".event-summary", ".event-attrs"]) {
      expect(client?.querySelector(selector)?.outerHTML, selector).toBe(server?.querySelector(selector)?.outerHTML);
    }
  });
});

describe("live operator metrics (#19)", () => {
  it("polls only on the Metrics view and shows totals, deltas, and trends", async () => {
    let http429 = 2;
    let polls = 0;
    const app = bootLive(
      { workItems: [], events: [], now: NOW },
      {
        "/dashboard/metrics": () => {
          polls += 1;
          return {
            body: {
              at: "2026-09-22T00:00:00.000Z",
              metrics: {
                sqliteReady: true,
                httpRequests: 100 + polls * 10,
                http429,
                http5xx: 0,
                rateLimited: http429,
                authLockouts: 0,
                sseRejected: 0,
                sseDropped: 0,
                auditEvents: 40
              }
            }
          };
        }
      }
    );
    app.open();
    await app.advance(METRICS_POLL_MS * 2);
    expect(polls).toBe(0);

    (app.document.querySelector('nav a[data-nav="metrics"]') as HTMLElement).click();
    await app.flush();
    expect(polls).toBe(1);
    const row = (label: string) =>
      [...app.document.querySelectorAll("#live-metrics tbody tr")].find(
        (tr) => tr.querySelector("th")?.textContent === label
      );
    expect(row("HTTP 429 responses")?.querySelectorAll("td")[0]?.textContent).toBe("2");
    expect(row("HTTP 429 responses")?.querySelectorAll("td")[1]?.textContent).toBe("—");

    http429 = 5;
    await app.advance(METRICS_POLL_MS);
    expect(row("HTTP 429 responses")?.querySelectorAll("td")[1]?.textContent).toBe("+3");
    expect(row("HTTP 429 responses")?.classList.contains("metric-hot")).toBe(true);
    expect(row("HTTP requests")?.classList.contains("metric-hot")).toBe(false);
    expect(row("HTTP 429 responses")?.querySelector(".metric-trend")?.textContent).toBe("█");
    expect(app.text("#live-metrics")).toContain("SQLite ready");
    // Live section patches must not wipe the counters.
    expect(app.document.querySelector("#operator-metrics-body #live-metrics")).toBeNull();

    (app.document.querySelector('nav a[data-nav="overview"]') as HTMLElement).click();
    await app.advance(METRICS_POLL_MS * 3);
    expect(polls).toBe(2);
  });
});

describe("theme (#20)", () => {
  it("ships a light palette that follows the OS, plus explicit light/dark overrides", () => {
    const html = renderDashboard({ workItems: [], events: [], now: NOW });
    expect(html).toContain('@media (prefers-color-scheme: light) {\n  :root:not([data-theme="dark"]) {');
    expect(html).toContain(':root[data-theme="light"] {');
    const styles = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    const outsideTokens = styles
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(outsideTokens).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });

  it("cycles auto → light → dark → auto and remembers the choice", () => {
    const app = bootLive({ workItems: [], events: [], now: NOW });
    const toggle = app.document.getElementById("theme-toggle") as HTMLButtonElement;
    const root = app.document.documentElement;
    expect(toggle.textContent).toBe("Theme: auto");
    toggle.click();
    expect(root.dataset.theme).toBe("light");
    expect(app.window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    toggle.click();
    expect(root.dataset.theme).toBe("dark");
    expect(toggle.textContent).toBe("Theme: dark");
    toggle.click();
    expect(root.dataset.theme).toBeUndefined();
    expect(app.window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("applies a saved theme from <head> before the body renders", () => {
    const app = bootLive(
      { workItems: [], events: [], now: NOW },
      {},
      {
        beforeParse(window) {
          (window as unknown as Window).localStorage.setItem(THEME_STORAGE_KEY, "light");
        }
      }
    );
    expect(app.document.documentElement.dataset.theme).toBe("light");
    expect(app.document.getElementById("theme-toggle")?.textContent).toBe("Theme: light");
  });
});
