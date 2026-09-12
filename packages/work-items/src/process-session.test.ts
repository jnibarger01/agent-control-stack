import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ControlStackError } from "@agent-control-stack/shared";
import { SqliteWorkItemStore, executionActionHash } from "./index.js";

const domainTransition = { via: "domain_service" } as const;

function fixture(dir: string) {
  const store = new SqliteWorkItemStore(join(dir, "control.db"));
  const workItem = store.create({
    title: "start_process target",
    requester: "user",
    intent: "verify dc_process_session ownership",
    target: { cwd: "/repo" },
    requestedActions: [{ kind: "manual", description: "start_process" }],
    risk: "low"
  });
  store.approveWorkItem(workItem.id, domainTransition);
  const actionHash = executionActionHash(workItem);
  return { store, workItem, actionHash };
}

describe("ADR-0016 Slice 4: SqliteWorkItemStore process-session ownership", () => {
  it("creates an active session on a successful start_process and finds it by (pid, bootId)", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-process-session-"));
    const { store, workItem, actionHash } = fixture(dir);
    try {
      const session = store.createProcessSession(
        {
          workItemId: workItem.id,
          actionHash,
          workerId: "worker-a",
          pid: 4242,
          bootId: "boot-a",
          procStartTicks: 100
        },
        domainTransition
      );

      expect(session.status).toBe("active");
      expect(session.pid).toBe(4242);

      const found = store.getActiveProcessSession(4242, "boot-a");
      expect(found?.id).toBe(session.id);
      expect(found?.workItemId).toBe(workItem.id);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("verifies ownership only for the exact (pid, bootId, procStartTicks, workItemId) match", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-process-session-"));
    const { store, workItem, actionHash } = fixture(dir);
    try {
      store.createProcessSession(
        { workItemId: workItem.id, actionHash, workerId: "worker-a", pid: 4242, bootId: "boot-a", procStartTicks: 100 },
        domainTransition
      );

      expect(
        store.verifyProcessSessionOwnership({
          workItemId: workItem.id,
          pid: 4242,
          bootId: "boot-a",
          procStartTicks: 100
        })
      ).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("denies ownership when procStartTicks differs - the pid was reused by an unrelated process", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-process-session-"));
    const { store, workItem, actionHash } = fixture(dir);
    try {
      store.createProcessSession(
        { workItemId: workItem.id, actionHash, workerId: "worker-a", pid: 4242, bootId: "boot-a", procStartTicks: 100 },
        domainTransition
      );

      expect(
        store.verifyProcessSessionOwnership({
          workItemId: workItem.id,
          pid: 4242,
          bootId: "boot-a",
          procStartTicks: 999 // a different process now holds this pid
        })
      ).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("denies ownership when the session belongs to a different work item", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-process-session-"));
    const { store, workItem, actionHash } = fixture(dir);
    const other = store.create({
      title: "unrelated work item",
      requester: "user",
      intent: "unrelated",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "manual", description: "unrelated" }],
      risk: "low"
    });
    try {
      store.createProcessSession(
        { workItemId: workItem.id, actionHash, workerId: "worker-a", pid: 4242, bootId: "boot-a", procStartTicks: 100 },
        domainTransition
      );

      expect(
        store.verifyProcessSessionOwnership({
          workItemId: other.id,
          pid: 4242,
          bootId: "boot-a",
          procStartTicks: 100
        })
      ).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("denies ownership when there is no session at all for that pid/bootId", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-process-session-"));
    const { store, workItem } = fixture(dir);
    try {
      expect(
        store.verifyProcessSessionOwnership({
          workItemId: workItem.id,
          pid: 9999,
          bootId: "boot-a",
          procStartTicks: 1
        })
      ).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects creating a second active session for the same (pid, bootId, procStartTicks)", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-process-session-"));
    const { store, workItem, actionHash } = fixture(dir);
    try {
      store.createProcessSession(
        { workItemId: workItem.id, actionHash, workerId: "worker-a", pid: 4242, bootId: "boot-a", procStartTicks: 100 },
        domainTransition
      );

      expect(() =>
        store.createProcessSession(
          { workItemId: workItem.id, actionHash, workerId: "worker-b", pid: 4242, bootId: "boot-a", procStartTicks: 100 },
          domainTransition
        )
      ).toThrow(ControlStackError);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows reusing the same (pid, bootId, procStartTicks) once the prior session is closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-process-session-"));
    const { store, workItem, actionHash } = fixture(dir);
    try {
      const first = store.createProcessSession(
        { workItemId: workItem.id, actionHash, workerId: "worker-a", pid: 4242, bootId: "boot-a", procStartTicks: 100 },
        domainTransition
      );
      store.closeProcessSession(first.id, domainTransition);

      const second = store.createProcessSession(
        { workItemId: workItem.id, actionHash, workerId: "worker-a", pid: 4242, bootId: "boot-a", procStartTicks: 100 },
        domainTransition
      );
      expect(second.status).toBe("active");
      expect(
        store.verifyProcessSessionOwnership({
          workItemId: workItem.id,
          pid: 4242,
          bootId: "boot-a",
          procStartTicks: 100
        })
      ).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closing an already-closed session is rejected rather than silently no-op'd", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-process-session-"));
    const { store, workItem, actionHash } = fixture(dir);
    try {
      const session = store.createProcessSession(
        { workItemId: workItem.id, actionHash, workerId: "worker-a", pid: 4242, bootId: "boot-a", procStartTicks: 100 },
        domainTransition
      );
      store.closeProcessSession(session.id, domainTransition);
      expect(() => store.closeProcessSession(session.id, domainTransition)).toThrow(ControlStackError);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reconcileProcessSessionsForBoot marks sessions from a prior boot as lost and denies their ownership", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-process-session-"));
    const { store, workItem, actionHash } = fixture(dir);
    try {
      store.createProcessSession(
        { workItemId: workItem.id, actionHash, workerId: "worker-a", pid: 4242, bootId: "boot-old", procStartTicks: 100 },
        domainTransition
      );

      const lost = store.reconcileProcessSessionsForBoot("boot-new", domainTransition);
      expect(lost).toHaveLength(1);
      expect(lost[0].status).toBe("lost");

      // A restart means the old (pid, bootId) identity can never come back -
      // the boot id itself changed - so ownership is denied regardless of
      // which bootId is queried for the stale pid.
      expect(
        store.verifyProcessSessionOwnership({
          workItemId: workItem.id,
          pid: 4242,
          bootId: "boot-old",
          procStartTicks: 100
        })
      ).toBe(false);
      expect(store.getActiveProcessSession(4242, "boot-old")).toBeUndefined();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reconcileProcessSessionsForBoot leaves sessions from the current boot untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-process-session-"));
    const { store, workItem, actionHash } = fixture(dir);
    try {
      store.createProcessSession(
        { workItemId: workItem.id, actionHash, workerId: "worker-a", pid: 4242, bootId: "boot-current", procStartTicks: 100 },
        domainTransition
      );

      const lost = store.reconcileProcessSessionsForBoot("boot-current", domainTransition);
      expect(lost).toHaveLength(0);
      expect(
        store.verifyProcessSessionOwnership({
          workItemId: workItem.id,
          pid: 4242,
          bootId: "boot-current",
          procStartTicks: 100
        })
      ).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("createProcessSession requires a privileged transition (domain_service or policy_gate)", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-process-session-"));
    const { store, workItem, actionHash } = fixture(dir);
    try {
      expect(() =>
        store.createProcessSession(
          { workItemId: workItem.id, actionHash, workerId: "worker-a", pid: 4242, bootId: "boot-a", procStartTicks: 100 },
          undefined as unknown as { via: "domain_service" }
        )
      ).toThrow(ControlStackError);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
