import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { renderDashboard, renderWorkItemDetailHtml } from "./index.js";

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const workItem = {
  id: "wrk_a11y",
  title: "Approve deploy gate",
  requester: "user" as const,
  status: "needs_approval" as const,
  intent: "human approval surface",
  target: { cwd: "/repo" },
  requestedActions: [{ kind: "fs.write", description: "update gate", params: {} }],
  risk: "medium" as const,
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z"
};

const blockedItem = {
  ...workItem,
  id: "wrk_blocked_a11y",
  title: "Blocked lease",
  status: "blocked" as const,
  result: { error: "lease expired" }
};

type AxeViolation = {
  id: string;
  impact?: string | null;
  help: string;
  nodes: Array<{ target: string[] }>;
};

async function runAxe(html: string): Promise<AxeViolation[]> {
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      // Dashboard client expects EventSource; stub so inline scripts do not throw in jsdom.
      (window as unknown as { EventSource: unknown }).EventSource = class {
        addEventListener() {}
        close() {}
      };
    }
  });
  const { window } = dom;
  // Drop app client script before axe; we only need static markup landmarks/controls.
  window.document.querySelectorAll("script").forEach((node) => node.remove());
  const script = window.document.createElement("script");
  script.textContent = axeSource;
  window.document.head.appendChild(script);
  const axe = (
    window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: AxeViolation[] }> } }
  ).axe;
  const result = await axe.run(window.document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "best-practice"] },
    rules: {
      // jsdom lacks layout/paint; contrast checks are unreliable here.
      "color-contrast": { enabled: false },
      // Landmark heuristics vary for single-page operator dashboards.
      region: { enabled: false }
    }
  });
  return result.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious");
}

describe("mission-control a11y + mobile smoke", () => {
  it("clears critical axe findings on the home dashboard", async () => {
    const html = renderDashboard({
      workItems: [workItem, blockedItem],
      events: [],
      approvalActionHashesByWorkItem: { wrk_a11y: ["hash-a"] },
      now: new Date("2026-09-13T00:01:00.000Z")
    });

    expect(html).toContain('href="#main-content"');
    expect(html).toContain('id="main-content"');
    expect(html).toContain('for="reason-wrk_a11y"');
    expect(html).toContain('aria-describedby="reason-wrk_a11y"');
    expect(html).toContain("@media (max-width: 767px)");
    expect(html).toContain("min-height: 44px");
    expect(html).toContain(":focus-visible");

    const violations = await runAxe(html);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("clears critical axe findings on work-item detail", async () => {
    const detail = renderWorkItemDetailHtml(workItem, [
      {
        name: "work_item.needs_approval",
        timeUnixNano: String(Date.parse("2026-09-13T00:00:30.000Z") * 1_000_000),
        attributes: { "work_item.id": "wrk_a11y" }
      }
    ]);
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Work item detail</title></head><body><main id="main-content"><section id="work-detail" class="detail-panel work-detail" tabindex="-1" aria-labelledby="work-detail-title">${detail}</section></main></body></html>`;

    expect(detail).toContain('id="work-detail-title"');
    expect(detail).toContain("Requested Actions");
    expect(detail).toContain("Timeline");

    const violations = await runAxe(html);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("keeps approval controls in reason-then-action focus order", () => {
    const html = renderDashboard({
      workItems: [workItem],
      events: [],
      approvalActionHashesByWorkItem: { wrk_a11y: ["hash-a"] },
      now: new Date("2026-09-13T00:01:00.000Z")
    });
    const reasonIdx = html.indexOf('id="reason-wrk_a11y"');
    const approveIdx = html.indexOf('data-approve="wrk_a11y"');
    const rejectIdx = html.indexOf('data-reject="wrk_a11y"');
    expect(reasonIdx).toBeGreaterThan(-1);
    expect(approveIdx).toBeGreaterThan(reasonIdx);
    expect(rejectIdx).toBeGreaterThan(approveIdx);
  });
});
