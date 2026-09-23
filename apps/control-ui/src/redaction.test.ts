import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import {
  redactAttributes,
  redactSecrets,
  renderDashboard,
  renderWorkItemDetailHtml,
  requestApprovalConfirm,
  type ApprovalConfirmDocument,
  type MissionControlViewModel
} from "./index.js";

// Fake credentials are assembled at runtime so secret scanners never see a
// credential-shaped literal in source; the redaction rules still see one.
const fake = (...parts: string[]) => parts.join("");

const SECRET_SAMPLES = {
  bearer: "Authorization: Bearer abc.def-ghi_123==",
  openai: fake("key sk", "-proj-", "ABCDEFGHIJKLMNOP1234"),
  github: fake("token gh", "p_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"),
  slack: fake("xox", "b-", "1234567890-abcdefghij"),
  jwt: fake("ey", "JhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiJ1c2VyMTIzIn0", ".", "c2lnbmF0dXJlLXZhbHVl"),
  githubPat: fake("pat github", "_pat_", "11ABCDEFG0123456789_abcdefghijklmnopqrstuv"),
  envLine: fake("DEPLOY_", "API_KEY=", "zzq7value"),
  query: "https://example.test/cb?code=ok&access_token=s3cr3tvalue&x=1",
  basicAuth: "postgres://admin:hunter2@db.internal:5432/acs"
};

const LEAKED = [
  "11ABCDEFG0123456789_abcdefghijklmnopqrstuv",
  "zzq7value",
  "abc.def-ghi_123",
  "ABCDEFGHIJKLMNOP1234",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
  "1234567890-abcdefghij",
  "c2lnbmF0dXJlLXZhbHVl",
  "s3cr3tvalue",
  "hunter2"
];

function expectNoLeaks(text: string): void {
  for (const secret of LEAKED) expect(text).not.toContain(secret);
}

const baseWorkItem = {
  id: "wrk_redact",
  title: "Redaction fixture",
  requester: "user" as const,
  status: "needs_approval" as const,
  intent: "call api with Bearer abc.def-ghi_123==",
  target: { cwd: "/repo", url: SECRET_SAMPLES.basicAuth },
  requestedActions: [
    { kind: "fs.read", description: "inspect source", params: {} },
    { kind: "shell", description: "run npm test", params: {} }
  ],
  risk: "high" as const,
  createdAt: "2026-09-22T00:00:00.000Z",
  updatedAt: "2026-09-22T00:00:00.000Z"
};

describe("redactSecrets", () => {
  it("redacts every known secret shape", () => {
    for (const sample of Object.values(SECRET_SAMPLES)) {
      expect(redactSecrets(sample)).toContain("[redacted]");
    }
    expectNoLeaks(Object.values(SECRET_SAMPLES).map(redactSecrets).join("\n"));
  });

  it("keeps non-secret text and query params intact", () => {
    expect(redactSecrets("worker lease expired")).toBe("worker lease expired");
    expect(redactSecrets(SECRET_SAMPLES.query)).toContain("code=ok");
    expect(redactSecrets(SECRET_SAMPLES.query)).toContain("&x=1");
    expect(redactSecrets(SECRET_SAMPLES.basicAuth)).toBe("postgres://admin:[redacted]@db.internal:5432/acs");
  });
});

describe("redactAttributes", () => {
  it("redacts secret-named keys of any type at any depth, keeping only token-count accounting keys", () => {
    const redacted = redactAttributes({
      "work_item.id": "wrk_1",
      accessToken: "plain-looking-value",
      nested: { client_secret: "abc", headers: { Authorization: "Basic Zm9vOmJhcg==" } },
      list: [{ password: "pw" }, "Bearer abc.def-ghi_123=="],
      inputTokens: 1234,
      "x-api-key": "k",
      api_key: 123456,
      password: 1234,
      tokenIssued: true
    }) as Record<string, unknown>;

    expect(redacted).toEqual({
      "work_item.id": "wrk_1",
      accessToken: "[redacted]",
      nested: { client_secret: "[redacted]", headers: { Authorization: "[redacted]" } },
      list: [{ password: "[redacted]" }, "Bearer [redacted]"],
      inputTokens: 1234,
      "x-api-key": "[redacted]",
      api_key: "[redacted]",
      password: "[redacted]",
      tokenIssued: "[redacted]"
    });
  });

  it("stays linear on long non-matching input (no catastrophic backtracking)", () => {
    const hostile = "a://" + "b".repeat(200_000) + ":" + "c".repeat(200_000);
    const started = performance.now();
    expect(redactSecrets(hostile)).toBe(hostile);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("truncates pathologically deep input instead of recursing forever", () => {
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let i = 0; i < 20; i += 1) deep = { child: deep };
    expect(JSON.stringify(redactAttributes(deep))).toContain("[truncated]");
  });
});

describe("mission control display redaction", () => {
  const secretEvent = {
    timeUnixNano: "1790000000000000000",
    name: "tool.result",
    attributes: {
      "work_item.id": "wrk_redact",
      "http.url": SECRET_SAMPLES.query,
      authorization: "Bearer abc.def-ghi_123==",
      note: SECRET_SAMPLES.github
    }
  } as unknown as MissionControlViewModel["events"][number];

  it("redacts audit attributes, agent lastError, and work item errors in the server render (#1, #2)", () => {
    const html = renderDashboard({
      workItems: [{ ...baseWorkItem, status: "blocked", result: { error: `upstream said ${SECRET_SAMPLES.openai}` } }],
      events: [secretEvent],
      agents: [
        {
          id: "agent-1",
          displayName: "Agent One",
          kind: "worker",
          status: "online",
          health: "unhealthy",
          lastError: `connect failed ${SECRET_SAMPLES.basicAuth} ${SECRET_SAMPLES.slack}`,
          capabilities: [],
          metadata: {}
        }
      ],
      now: new Date("2026-09-22T00:01:00.000Z")
    });

    const markup = html.slice(0, html.indexOf("<script>"));
    expectNoLeaks(markup);
    expect(markup).toContain("[redacted]");
    expect(markup).toContain("tool.result");
    expect(markup).toContain("wrk_redact");
  });

  it("redacts live SSE audit events and client-rendered details with the same rules (#1)", async () => {
    const listeners = new Map<string, (event: { data: string; type: string }) => void>();
    const dom = new JSDOM(
      renderDashboard({ workItems: [baseWorkItem], events: [], now: new Date("2026-09-22T00:01:00.000Z") }),
      {
        runScripts: "dangerously",
        beforeParse(window) {
          (window as unknown as { EventSource: unknown }).EventSource = class {
            addEventListener(name: string, listener: (event: { data: string; type: string }) => void) {
              listeners.set(name, listener);
            }
            close() {}
          };
          (window as unknown as { fetch: unknown }).fetch = async () => ({
            ok: true,
            status: 200,
            json: async () => ({ agents: [] })
          });
        }
      }
    );
    const window = dom.window as unknown as {
      redactClient(value: unknown): string;
      redactAttributesClient(value: unknown): unknown;
      document: Document;
    };

    // Client and server helpers agree on every sample.
    for (const sample of Object.values(SECRET_SAMPLES)) {
      expect(window.redactClient(sample)).toBe(redactSecrets(sample));
    }
    const attrs = {
      token: "t",
      nested: { cookie: "c", ok: SECRET_SAMPLES.jwt },
      count: 3,
      api_key: 99,
      inputTokens: 7
    };
    expect(window.redactAttributesClient(attrs)).toEqual(redactAttributes(attrs));

    listeners.get("open")?.({ data: "", type: "open" });
    listeners.get("work_item.created")?.({ data: JSON.stringify(secretEvent), type: "work_item.created" });

    const timeline = window.document.querySelector("#events .timeline")?.textContent ?? "";
    expect(timeline).toContain("tool.result");
    expect(timeline).toContain("[redacted]");
    expectNoLeaks(timeline);
  });
});

describe("approval buttons name the action they approve (#4)", () => {
  it("labels each approve button with the action kind and hash prefix", () => {
    const html = renderDashboard({
      workItems: [baseWorkItem],
      events: [],
      approvalActionsByWorkItem: {
        wrk_redact: [
          { actionHash: "aaaaaaaa11112222", kind: "fs.read", description: "inspect source" },
          { actionHash: "bbbbbbbb33334444", kind: "shell", description: "run npm test" }
        ]
      },
      now: new Date("2026-09-22T00:01:00.000Z")
    });
    const { document } = new JSDOM(html).window;
    const buttons = [...document.querySelectorAll('[data-approve="wrk_redact"]')];

    expect(buttons).toHaveLength(2);
    expect(buttons.map((button) => button.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "Approve fs.read aaaaaaaa…",
      "Approve shell bbbbbbbb…"
    ]);
    expect(buttons[1]?.getAttribute("data-action-hash")).toBe("bbbbbbbb33334444");
    expect(buttons[1]?.getAttribute("data-action-kind")).toBe("shell");
    expect(buttons[1]?.getAttribute("aria-label")).toBe(
      "Approve shell: run npm test (hash bbbbbbbb…) for Redaction fixture"
    );
    expect(html).not.toContain(">Approve 1<");
  });

  it("redacts action descriptions in approval labels and detail markup", () => {
    const html = renderDashboard({
      workItems: [
        {
          ...baseWorkItem,
          requestedActions: [{ kind: "shell", description: `curl -H "${SECRET_SAMPLES.bearer}"`, params: {} }]
        }
      ],
      events: [],
      approvalActionsByWorkItem: {
        wrk_redact: [{ actionHash: "aaaaaaaa11112222", kind: "shell", description: `use ${SECRET_SAMPLES.github}` }]
      },
      now: new Date("2026-09-22T00:01:00.000Z")
    });
    expectNoLeaks(html.slice(0, html.lastIndexOf("<script>")));
    expect(
      new JSDOM(html).window.document.querySelector('[data-approve="wrk_redact"]')?.getAttribute("aria-label")
    ).toContain("use token [redacted]");
    expectNoLeaks(
      renderWorkItemDetailHtml({
        ...baseWorkItem,
        requestedActions: [{ kind: "shell", description: SECRET_SAMPLES.bearer }]
      })
    );
  });

  it("falls back to numbered labels with the hash prefix for legacy hash-only input", () => {
    const html = renderDashboard({
      workItems: [baseWorkItem],
      events: [],
      approvalActionHashesByWorkItem: { wrk_redact: ["cccccccc55556666"] },
      now: new Date("2026-09-22T00:01:00.000Z")
    });
    const button = new JSDOM(html).window.document.querySelector('[data-approve="wrk_redact"]');

    expect(button?.textContent?.replace(/\s+/g, " ").trim()).toBe("Approve 1 cccccccc…");
    expect(button?.hasAttribute("data-action-kind")).toBe(false);
  });

  it("shows the action kind in the high-risk confirm dialog", async () => {
    const html = renderDashboard({ workItems: [baseWorkItem], events: [], now: new Date("2026-09-22T00:01:00.000Z") });
    expect(html).toContain("actionKind: button.dataset.actionKind");
    expect(html).toContain('class="approval-confirm-kind"');

    const { document } = new JSDOM("<!doctype html><body></body>").window;
    const pending = requestApprovalConfirm(document as unknown as ApprovalConfirmDocument, {
      workItemId: "wrk_redact",
      action: "approve",
      actionHash: "bbbbbbbb33334444",
      actionKind: "shell",
      risk: "high"
    });
    expect(document.querySelector(".approval-confirm-kind")?.textContent).toBe("Action: shell");
    (document.querySelector("#approval-confirm-cancel") as HTMLElement).click();
    await expect(pending).resolves.toBe(false);
  });
});

describe("safety notes (#5)", () => {
  it("describes only the controls the dashboard actually exposes", () => {
    const html = renderDashboard({ workItems: [baseWorkItem], events: [], now: new Date("2026-09-22T00:01:00.000Z") });
    expect(html).toContain("Approve, reject, and unblock use authenticated backend routes");
    expect(html).toContain("Cancel, retry, and clone live in work-item detail");
    expect(html).not.toContain("Approval and cancellation actions");
  });
});
