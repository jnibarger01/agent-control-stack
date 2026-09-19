// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcsApiError } from "../api/errors";
import { workItem } from "../test-fixtures";
import { button, cleanup, click, flush, openDialog, render, type as typeInto } from "../test-utils";
import { NewWorkItemDialog } from "./NewWorkItemDialog";
import { RegisterAgentDialog } from "./RegisterAgentDialog";

const api = vi.hoisted(() => ({ createWorkItem: vi.fn(), registerAgent: vi.fn() }));
vi.mock("../api/endpoints", () => ({ endpoints: api }));

beforeEach(() => {
  api.createWorkItem.mockReset();
  api.registerAgent.mockReset();
});
afterEach(cleanup);

const field = (label: RegExp) =>
  [...openDialog()!.querySelectorAll("label")]
    .find((l) => label.test(l.textContent ?? ""))!
    .querySelector("input, textarea, select") as HTMLInputElement;
const submit = () => click(openDialog()!.querySelector("button[type=submit]"));

describe("New work item", () => {
  async function open() {
    return render(<NewWorkItemDialog open onClose={() => undefined} />, "/console/work");
  }
  async function fillRequired() {
    await typeInto(field(/^Title/), "Rotate cache");
    await typeInto(field(/^Intent/), "Overwrite the cache manifest");
    await typeInto(field(/^Action kind/), "fs.write");
    await typeInto(field(/^Action description/), "write cache.json");
  }

  it("refuses to submit without the required fields and sends nothing", async () => {
    await open();
    await submit();
    expect(openDialog()!.textContent).toMatch(/are required/);
    expect(api.createWorkItem).not.toHaveBeenCalled();
  });

  it("rejects malformed or non-object JSON parameters before any request", async () => {
    await open();
    await fillRequired();
    await typeInto(field(/^Action parameters/), "{not json");
    await submit();
    expect(openDialog()!.textContent).toMatch(/valid JSON/);
    await typeInto(field(/^Action parameters/), "[1,2]");
    await submit();
    expect(openDialog()!.textContent).toMatch(/JSON object/);
    expect(api.createWorkItem).not.toHaveBeenCalled();
  });

  it("creates through POST /work-items without client-supplied requester/status, and reports the status ACS assigned", async () => {
    api.createWorkItem.mockResolvedValue(workItem({ id: "wrk_new", status: "blocked" }));
    await open();
    await fillRequired();
    await typeInto(field(/^Risk/), "high");
    await typeInto(field(/^Action parameters/), '{"path":"cache.json"}');
    await submit();
    await flush();
    expect(api.createWorkItem).toHaveBeenCalledTimes(1);
    const body = api.createWorkItem.mock.calls[0]![0];
    expect(body).toMatchObject({
      title: "Rotate cache",
      intent: "Overwrite the cache manifest",
      risk: "high",
      requestedActions: [{ kind: "fs.write", description: "write cache.json", params: { path: "cache.json" } }]
    });
    expect(body).not.toHaveProperty("requester");
    expect(body).not.toHaveProperty("requesterSubject");
    expect(body).not.toHaveProperty("status");
    expect(document.body.textContent).toContain("ACS set status “blocked”");
    expect(window.location.pathname).toBe("/console/work/wrk_new");
  });

  it("a rejected creation (429 queue full) stays open with the real error", async () => {
    api.createWorkItem.mockRejectedValue(
      new AcsApiError("rate_limited", "pending work-item limit reached", { status: 429, code: "work_queue_full" })
    );
    await open();
    await fillRequired();
    await submit();
    await flush();
    expect(openDialog()!.textContent).toContain("work_queue_full");
    expect(document.body.textContent).not.toContain("Created");
  });
});

describe("Register agent", () => {
  it("requires id, name and kind, then registers via POST /api/agents", async () => {
    api.registerAgent.mockResolvedValue({ agent: {} });
    await render(<RegisterAgentDialog open onClose={() => undefined} />, "/console/agents");
    await submit();
    expect(api.registerAgent).not.toHaveBeenCalled();
    expect(openDialog()!.textContent).toMatch(/are required/);
    await typeInto(field(/^Agent ID/), "builder-9");
    await typeInto(field(/^Display name/), "Builder 9");
    await typeInto(field(/^ACP role/), "IMPLEMENTATION_AGENT");
    await submit();
    await flush();
    expect(api.registerAgent).toHaveBeenCalledWith({
      id: "builder-9",
      name: "Builder 9",
      kind: "llm",
      acpRole: "IMPLEMENTATION_AGENT"
    });
    expect(document.body.textContent).toContain("Registered agent builder-9");
  });

  it("says plainly that registering does not make an agent online", async () => {
    await render(<RegisterAgentDialog open onClose={() => undefined} />, "/console/agents");
    expect(openDialog()!.textContent).toMatch(/does not make the agent online/);
    expect(button(openDialog()!, "Register agent")).toBeDefined();
  });
});
