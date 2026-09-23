import { describe, expect, it } from "vitest";
import { COMPOSER_PREVIEW_DEBOUNCE_MS, composerHtml } from "./index.js";
import { bootLive } from "./live-harness.test-support.js";

const KINDS = ["agent.prompt", "fs.read", "fs.write", "shell"];

function bootComposer(
  preview: (body: unknown) => unknown = () => ({
    outcome: "auto_admitted",
    reason: "all actions allowed",
    matchedRules: ["allow:read"],
    actions: []
  })
) {
  const previews: unknown[] = [];
  const app = bootLive(
    { workItems: [], events: [], composerActionKinds: KINDS, now: new Date("2026-09-22T00:00:00.000Z") },
    {
      "/dashboard/policy-preview": () => {
        const call = app.calls.at(-1);
        previews.push(call?.body);
        return { body: preview(call?.body) };
      }
    }
  );
  const form = app.document.getElementById("task-form") as HTMLFormElement;
  const field = <T extends HTMLElement>(name: string) => form.querySelector(`[name="${name}"]`) as unknown as T;
  const type = (name: string, value: string) => {
    const input = field<HTMLInputElement>(name);
    input.value = value;
    input.dispatchEvent(new app.window.Event("input", { bubbles: true }));
  };
  const submit = () => form.dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true }));
  const posts = () => app.calls.filter((call) => call.method === "POST" && call.url === "/work-items");
  return { app, form, field, type, submit, previews, posts };
}

describe("task composer (#17)", () => {
  it("suggests the policy's action kinds", () => {
    const html = composerHtml(KINDS);
    for (const kind of KINDS) expect(html).toContain(`<option value="${kind}"></option>`);
    expect(html).toContain('list="composer-action-kinds"');
    expect(composerHtml([])).toContain("Defaults to agent.prompt.");
  });

  it("previews policy after a debounce once title and instructions are filled", async () => {
    const c = bootComposer(() => ({
      outcome: "needs_approval",
      reason: "file writes require approval",
      matchedRules: ["require:fs-write"],
      actions: [{ kind: "fs.write", decision: "require_approval", reason: "file writes require approval" }]
    }));
    c.type("title", "Write notes");
    await c.app.advance(COMPOSER_PREVIEW_DEBOUNCE_MS);
    expect(c.previews).toHaveLength(0);
    expect(c.app.text("#composer-preview")).toBe("Fill in a title and instructions to preview policy.");

    c.type("intent", "update the notes");
    c.type("actionKind", "fs.write");
    await c.app.advance(COMPOSER_PREVIEW_DEBOUNCE_MS - 1);
    expect(c.previews).toHaveLength(0);
    await c.app.advance(1);

    expect(c.previews).toEqual([
      {
        title: "Write notes",
        intent: "update the notes",
        risk: "medium",
        target: {},
        requestedActions: [{ kind: "fs.write", description: "Dispatch prompt to selected agent", params: {} }]
      }
    ]);
    expect(c.app.document.getElementById("composer-preview")?.dataset.outcome).toBe("needs_approval");
    expect(c.app.text("#composer-preview")).toContain("Would wait for operator approval.");
    expect(c.app.text("#composer-preview")).toContain("fs.write");
    expect(c.app.text("#composer-preview")).toContain("Rules: require:fs-write");
    expect(c.posts()).toHaveLength(0);
  });

  it("flags action kinds policy does not know", async () => {
    const c = bootComposer();
    c.type("actionKind", "teleport");
    await c.app.advance(COMPOSER_PREVIEW_DEBOUNCE_MS);
    const hint = c.app.document.getElementById("composer-kind-hint");
    expect(hint?.textContent).toBe("teleport is not an action kind policy knows; it will be denied.");
    expect(hint?.classList.contains("field-error")).toBe(true);
    c.type("actionKind", "fs.read");
    await c.app.advance(COMPOSER_PREVIEW_DEBOUNCE_MS);
    expect(hint?.classList.contains("field-error")).toBe(false);
  });

  it("validates JSON params and refuses to submit or preview invalid ones", async () => {
    const c = bootComposer();
    c.type("title", "Read");
    c.type("intent", "read a file");
    c.type("actionParams", "{not json");
    await c.app.advance(COMPOSER_PREVIEW_DEBOUNCE_MS);
    expect(c.app.text("#composer-params-error")).toMatch(/^Params are not valid JSON/);
    expect(c.field<HTMLTextAreaElement>("actionParams").getAttribute("aria-invalid")).toBe("true");
    expect(c.previews).toHaveLength(0);

    c.submit();
    await c.app.flush();
    expect(c.posts()).toHaveLength(0);
    expect(c.app.text("#task-result")).toBe("Fix the action params first");
    expect(c.app.document.activeElement).toBe(c.field("actionParams"));

    c.type("actionParams", "[1, 2]");
    await c.app.advance(COMPOSER_PREVIEW_DEBOUNCE_MS);
    expect(c.app.text("#composer-params-error")).toBe('Params must be a JSON object, like {"paths": ["README.md"]}.');
  });

  it("sends parsed params with the created work item and resets the draft", async () => {
    const c = bootComposer();
    c.app.setPostResponse({ status: 201, body: { id: "wrk_new", status: "needs_approval" } });
    c.type("title", "Read");
    c.type("intent", "read a file");
    c.type("actionKind", "fs.read");
    c.type("actionParams", '{"paths": ["README.md"]}');
    c.submit();
    await c.app.flush();

    expect(c.posts()).toEqual([
      {
        url: "/work-items",
        method: "POST",
        body: {
          title: "Read",
          intent: "read a file",
          risk: "medium",
          target: {},
          requestedActions: [
            { kind: "fs.read", description: "Dispatch prompt to selected agent", params: { paths: ["README.md"] } }
          ]
        }
      }
    ]);
    expect(c.app.text("#task-result")).toBe("Created wrk_new (needs_approval)");
    expect(c.field<HTMLInputElement>("title").value).toBe("");
    expect(c.app.text("#composer-preview")).toBe("Fill in a title and instructions to preview policy.");
  });

  it("requires a title and instructions before posting", async () => {
    const c = bootComposer();
    c.submit();
    await c.app.flush();
    expect(c.posts()).toHaveLength(0);
    expect(c.app.text("#task-result")).toBe("Title and instructions are required");
    expect(c.app.document.activeElement).toBe(c.field("title"));
  });
});
