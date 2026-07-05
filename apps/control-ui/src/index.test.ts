import { describe, expect, it } from "vitest";
import { renderDashboard } from "./index.js";

describe("renderDashboard", () => {
  it("renders a read-only dashboard while browser session auth is absent", () => {
    const html = renderDashboard([
      {
        id: "wrk_test",
        title: "Inspect me",
        requester: "user",
        status: "needs_approval",
        intent: "verify read-only rendering",
        target: { cwd: "/repo", files: ["src/index.ts"] },
        requestedActions: [{ kind: "fs.read", description: "inspect source", params: { paths: ["src/index.ts"] } }],
        risk: "low",
        createdAt: "2026-07-05T00:00:00.000Z",
        updatedAt: "2026-07-05T00:00:00.000Z"
      }
    ]);

    expect(html).toContain("Dashboard is read-only until session auth and CSRF protection exist");
    expect(html).toContain("Inspect me");
    expect(html).toContain("fs.read");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("fetch(");
    expect(html).not.toContain("data-approve");
    expect(html).not.toContain("data-cancel");
  });
});
