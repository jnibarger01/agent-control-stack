import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { codingMissionApprovalDecision, codingMissionPanelSource } from "./coding-mission-panel.js";

const HASH = "a".repeat(64);
const NEXT = "b".repeat(64);

describe("coding mission approval panel", () => {
  it("refreshes a stale change set without approving the replacement", async () => {
    expect(codingMissionApprovalDecision(409)).toBe("refresh");
    expect(codingMissionApprovalDecision(200)).toBe("accepted");
    const posts: unknown[] = [];
    let listed = [
      {
        missionId: "mission-1",
        state: "WAITING_FOR_APPROVAL",
        summary: "Ship <script>",
        repository: "acme/app",
        files: ["src/app.ts"],
        checks: { tests: "PASS" },
        changeSet: HASH,
        pullRequest: { number: 9, url: "https://github.test/acme/app/pull/9" },
        deploymentRequired: false,
        deploymentImpact: "no runtime mutation"
      }
    ];
    const dom = new JSDOM(`<div id="coding-mission-list"></div>`, {
      url: "http://127.0.0.1/",
      runScripts: "dangerously"
    });
    const window = dom.window;
    window.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      if (method === "POST") {
        posts.push(init?.body ? JSON.parse(init.body) : undefined);
        listed = [{ ...listed[0]!, changeSet: NEXT }];
        return { status: 409, ok: false, json: async () => ({ code: "coding_mission_stale_approval" }) };
      }
      return { status: 200, ok: true, json: async () => ({ missions: listed }) };
    }) as typeof window.fetch;
    window.eval(codingMissionPanelSource());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const button = window.document.querySelector<HTMLButtonElement>("[data-approve-change-set]");
    expect(button?.dataset.changeSetHash).toBe(HASH);
    expect(window.document.body.textContent).toContain(HASH);
    expect(window.document.body.textContent).toContain("not required");
    expect(window.document.querySelector("script")).toBeNull();
    button?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(posts).toEqual([{ expectedChangeSetHash: HASH }]);
    expect(window.document.body.textContent).toContain("This change set changed. Refreshing the proposal.");
    expect(window.document.querySelector("[data-approve-change-set]")?.getAttribute("data-change-set-hash")).toBe(NEXT);
    expect(posts).toHaveLength(1);
    window.close();
  });
});
