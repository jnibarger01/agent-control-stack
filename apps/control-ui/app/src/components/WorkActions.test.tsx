// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcsApiError } from "../api/errors";
import { event, HASH_A, HASH_B, policyDecided, workItem } from "../test-fixtures";
import { button, cleanup, click, flush, openDialog, render, type as typeInto } from "../test-utils";
import { WorkActions } from "./WorkActions";

const mutations = vi.hoisted(() => ({
  approve: vi.fn(),
  reject: vi.fn(),
  cancel: vi.fn(),
  unblock: vi.fn(),
  retry: vi.fn(),
  clone: vi.fn()
}));
vi.mock("../state/mutations", () => ({ workMutations: mutations }));

const needsApprovalEvents = [policyDecided("wrk_1", HASH_A, "require_approval")];

beforeEach(() => {
  for (const fn of Object.values(mutations)) fn.mockReset();
});
afterEach(cleanup);

async function submitDialog() {
  await click(openDialog()!.querySelector("button[type=submit]"));
}

describe("approve", () => {
  it("shows the exact recorded action hash, and Approve opens a confirmation naming it", async () => {
    const { container } = await render(<WorkActions workItem={workItem()} events={needsApprovalEvents} trustworthy />);
    expect(container.querySelector("[data-testid=action-hash]")?.textContent).toContain(HASH_A);
    await click(button(container, "Approve this action"));
    const dialog = openDialog()!;
    expect(dialog.textContent).toContain(HASH_A);
    expect(dialog.textContent).toContain("wrk_1");
    expect(mutations.approve).not.toHaveBeenCalled();
  });

  it("blocks an approval with no reason and sends nothing", async () => {
    const { container } = await render(<WorkActions workItem={workItem()} events={needsApprovalEvents} trustworthy />);
    await click(button(container, "Approve this action"));
    await submitDialog();
    expect(openDialog()!.textContent).toMatch(/reason is required/i);
    expect(mutations.approve).not.toHaveBeenCalled();
    await typeInto(openDialog()!.querySelector("textarea"), "   "); // whitespace is not a reason
    await submitDialog();
    expect(mutations.approve).not.toHaveBeenCalled();
  });

  it("sends the exact action hash and trimmed reason, then closes and reports success", async () => {
    mutations.approve.mockResolvedValue({});
    const { container } = await render(<WorkActions workItem={workItem()} events={needsApprovalEvents} trustworthy />);
    await click(button(container, "Approve this action"));
    await typeInto(openDialog()!.querySelector("textarea"), "  looks right  ");
    await submitDialog();
    await flush();
    expect(mutations.approve).toHaveBeenCalledTimes(1);
    expect(mutations.approve).toHaveBeenCalledWith("wrk_1", HASH_A, "looks right");
    expect(openDialog()).toBeNull();
    expect(document.body.textContent).toContain("Approved action for wrk_1");
  });

  it("repeated clicks while the request is pending send exactly one approval", async () => {
    let release!: () => void;
    mutations.approve.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
    const { container } = await render(<WorkActions workItem={workItem()} events={needsApprovalEvents} trustworthy />);
    await click(button(container, "Approve this action"));
    await typeInto(openDialog()!.querySelector("textarea"), "ok");
    const submit = openDialog()!.querySelector("button[type=submit]") as HTMLButtonElement;
    await click(submit);
    await click(submit);
    await click(submit);
    expect(mutations.approve).toHaveBeenCalledTimes(1);
    expect(submit.disabled).toBe(true);
    release();
    await flush();
  });

  it("a stale/conflicting action hash fails safely: error shown, dialog stays open, NO success claimed", async () => {
    mutations.approve.mockRejectedValue(
      new AcsApiError("conflict", "approval action hash does not match work item", {
        status: 409,
        code: "approval_action_mismatch"
      })
    );
    const { container } = await render(<WorkActions workItem={workItem()} events={needsApprovalEvents} trustworthy />);
    await click(button(container, "Approve this action"));
    await typeInto(openDialog()!.querySelector("textarea"), "ok");
    await submitDialog();
    await flush();
    const dialog = openDialog()!;
    expect(dialog.textContent).toContain("Not completed");
    expect(dialog.textContent).toContain("approval_action_mismatch");
    expect(document.body.textContent).not.toContain("Approved action");
  });

  it("a policy denial (403) is shown as a refusal, never as success", async () => {
    mutations.approve.mockRejectedValue(
      new AcsApiError("forbidden", "high-risk self-approval is denied", { status: 403 })
    );
    const { container } = await render(<WorkActions workItem={workItem()} events={needsApprovalEvents} trustworthy />);
    await click(button(container, "Approve this action"));
    await typeInto(openDialog()!.querySelector("textarea"), "ok");
    await submitDialog();
    await flush();
    expect(openDialog()!.textContent).toMatch(/Not permitted/);
    expect(openDialog()!.textContent).toContain("self-approval is denied");
  });

  it("each required hash gets its own Approve control; an already-granted one is not offered again", async () => {
    const events = [
      policyDecided("wrk_1", HASH_A, "require_approval"),
      policyDecided("wrk_1", HASH_B, "require_approval"),
      event("approval.granted", { "work_item.id": "wrk_1", "action.hash": HASH_A }, { actionHash: HASH_A })
    ];
    const { container } = await render(<WorkActions workItem={workItem()} events={events} trustworthy />);
    const rows = [...container.querySelectorAll("[data-testid=approval-row]")];
    expect(rows).toHaveLength(2);
    const enabled = rows.filter((row) => !(button(row, "Approve this action") as HTMLButtonElement).disabled);
    expect(enabled).toHaveLength(1);
    expect(enabled[0]!.textContent).toContain(HASH_B);
  });
});

describe("fail-closed gating", () => {
  it("disables approve/reject/unblock/cancel with a visible reason when the stream is not trustworthy", async () => {
    const { container } = await render(
      <WorkActions workItem={workItem({ status: "needs_approval" })} events={needsApprovalEvents} trustworthy={false} />
    );
    expect((button(container, "Approve this action") as HTMLButtonElement).disabled).toBe(true);
    expect((button(container, "Reject") as HTMLButtonElement).disabled).toBe(true);
    expect((button(container, "Cancel work item") as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).toMatch(/Live event stream is not connected/);
    await click(button(container, "Approve this action"));
    expect(openDialog()).toBeNull();
  });

  it("blocked items: unblock/reject/cancel disabled while stale", async () => {
    const { container } = await render(
      <WorkActions workItem={workItem({ status: "blocked" })} events={[]} trustworthy={false} />
    );
    expect((button(container, "Unblock") as HTMLButtonElement).disabled).toBe(true);
    expect((button(container, "Reject") as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers no Approve control unless the item is needs_approval", async () => {
    for (const status of [
      "approved",
      "running",
      "blocked",
      "succeeded",
      "failed",
      "cancelled",
      "rejected",
      "draft"
    ] as const) {
      const { container } = await render(
        <WorkActions workItem={workItem({ status })} events={needsApprovalEvents} trustworthy />
      );
      expect(button(container, "Approve this action"), status).toBeUndefined();
      await cleanup();
    }
  });

  it("with no recorded policy evidence there is nothing to approve, and the UI says why", async () => {
    const { container } = await render(<WorkActions workItem={workItem()} events={[]} trustworthy />);
    expect(button(container, "Approve this action")).toBeUndefined();
    expect(container.textContent).toMatch(/No policy decision requiring approval/);
  });
});

describe("other mutations", () => {
  it("reject sends the optional reason", async () => {
    mutations.reject.mockResolvedValue({});
    const { container } = await render(<WorkActions workItem={workItem()} events={needsApprovalEvents} trustworthy />);
    await click(button(container, "Reject"));
    await typeInto(openDialog()!.querySelector("textarea"), "not acceptable");
    await submitDialog();
    await flush();
    expect(mutations.reject).toHaveBeenCalledWith("wrk_1", "not acceptable");
  });

  it("unblock asks first, then calls once; a backend denial surfaces as an error", async () => {
    mutations.unblock.mockRejectedValue(new AcsApiError("forbidden", "destructive command is denied", { status: 403 }));
    const { container } = await render(
      <WorkActions workItem={workItem({ status: "blocked" })} events={[]} trustworthy />
    );
    await click(button(container, "Unblock"));
    expect(mutations.unblock).not.toHaveBeenCalled();
    await submitDialog();
    await flush();
    expect(mutations.unblock).toHaveBeenCalledTimes(1);
    expect(openDialog()!.textContent).toContain("destructive command is denied");
    expect(document.body.textContent).not.toContain("Unblock evaluated");
  });

  it("cancel asks first and is available for cancellable states", async () => {
    mutations.cancel.mockResolvedValue({});
    const { container } = await render(
      <WorkActions workItem={workItem({ status: "running" })} events={[]} trustworthy />
    );
    await click(button(container, "Cancel work item"));
    expect(mutations.cancel).not.toHaveBeenCalled();
    await submitDialog();
    await flush();
    expect(mutations.cancel).toHaveBeenCalledWith("wrk_1", "");
  });

  it("retry requires a reason and is only offered for failed items; clone for terminal ones", async () => {
    mutations.retry.mockResolvedValue({ workItem: workItem({ id: "wrk_2" }) });
    const { container } = await render(
      <WorkActions workItem={workItem({ status: "failed" })} events={[]} trustworthy />
    );
    await click(button(container, "Retry"));
    await submitDialog();
    expect(mutations.retry).not.toHaveBeenCalled();
    await typeInto(openDialog()!.querySelector("textarea"), "transient failure");
    await submitDialog();
    await flush();
    expect(mutations.retry).toHaveBeenCalledWith("wrk_1", "transient failure");
    expect(button(container, "Clone")).toBeDefined();
    await cleanup();
    const running = await render(<WorkActions workItem={workItem({ status: "running" })} events={[]} trustworthy />);
    expect(button(running.container, "Retry")).toBeUndefined();
    expect(button(running.container, "Clone")).toBeUndefined();
  });
});
