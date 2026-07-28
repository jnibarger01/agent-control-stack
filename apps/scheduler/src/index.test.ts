import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import {
  mostRecentScheduledFiring,
  runSchedulerOnce,
  scheduleConfigSchema,
  scheduledFiringIdempotencyKey,
  type ScheduleConfig
} from "./index.js";

function withTempDb<T>(fn: (dbPath: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "acs-scheduler-"));
  const dbPath = join(dir, "control.db");
  return Promise.resolve(fn(dbPath)).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

const readOnlySchedule: ScheduleConfig = [
  {
    scheduleId: "nightly-repo-scan",
    intervalMs: 60_000,
    workItemTemplate: {
      title: "Nightly repo scan",
      requester: "system",
      intent: "scan the repository for drift",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["src/index.ts"] } }],
      risk: "low"
    }
  }
];

describe("runSchedulerOnce", () => {
  it("creates exactly one work item across duplicate deliveries for the same firing", async () => {
    await withTempDb(async (dbPath) => {
      const now = new Date("2026-07-23T00:01:00.000Z");

      const first = await runSchedulerOnce({ dbPath, schedules: readOnlySchedule, now });
      const second = await runSchedulerOnce({
        dbPath,
        schedules: readOnlySchedule,
        now: new Date(now.getTime() + 5_000)
      });

      expect(first.firings).toHaveLength(1);
      expect(first.firings[0]?.created).toBe(true);
      expect(second.firings).toHaveLength(1);
      expect(second.firings[0]?.created).toBe(false);
      expect(second.firings[0]?.workItemId).toBe(first.firings[0]?.workItemId);
      expect(second.firings[0]?.idempotencyKey).toBe(first.firings[0]?.idempotencyKey);

      const store = new SqliteWorkItemStore(dbPath);
      try {
        const items = store.list();
        expect(items).toHaveLength(1);
        expect(items[0]?.id).toBe(first.firings[0]?.workItemId);
      } finally {
        store.close();
      }
    });
  });

  it("creates a second work item once the next interval bucket is reached", async () => {
    await withTempDb(async (dbPath) => {
      const first = await runSchedulerOnce({
        dbPath,
        schedules: readOnlySchedule,
        now: new Date("2026-07-23T00:01:00.000Z")
      });
      const second = await runSchedulerOnce({
        dbPath,
        schedules: readOnlySchedule,
        now: new Date("2026-07-23T00:02:05.000Z")
      });

      expect(first.firings[0]?.created).toBe(true);
      expect(second.firings[0]?.created).toBe(true);
      expect(second.firings[0]?.workItemId).not.toBe(first.firings[0]?.workItemId);
      expect(second.firings[0]?.idempotencyKey).not.toBe(first.firings[0]?.idempotencyKey);

      const store = new SqliteWorkItemStore(dbPath);
      try {
        expect(store.list()).toHaveLength(2);
      } finally {
        store.close();
      }
    });
  });

  it("never fires a schedule whose anchor is still in the future", async () => {
    await withTempDb(async (dbPath) => {
      const future: ScheduleConfig = [
        {
          ...readOnlySchedule[0]!,
          anchor: "2099-01-01T00:00:00.000Z"
        }
      ];

      const result = await runSchedulerOnce({ dbPath, schedules: future, now: new Date("2026-07-23T00:01:00.000Z") });

      expect(result.firings).toHaveLength(0);
      const store = new SqliteWorkItemStore(dbPath);
      try {
        expect(store.list()).toHaveLength(0);
      } finally {
        store.close();
      }
    });
  });

  it("keeps distinct schedules independent even when they fire at the same instant", async () => {
    await withTempDb(async (dbPath) => {
      const twoSchedules: ScheduleConfig = [
        readOnlySchedule[0]!,
        {
          ...readOnlySchedule[0]!,
          scheduleId: "nightly-repo-scan-2",
          workItemTemplate: { ...readOnlySchedule[0]!.workItemTemplate, title: "Second nightly scan" }
        }
      ];

      const result = await runSchedulerOnce({
        dbPath,
        schedules: twoSchedules,
        now: new Date("2026-07-23T00:01:00.000Z")
      });

      expect(result.firings).toHaveLength(2);
      expect(result.firings.every((firing) => firing.created)).toBe(true);
      expect(new Set(result.firings.map((firing) => firing.workItemId)).size).toBe(2);
      expect(new Set(result.firings.map((firing) => firing.idempotencyKey)).size).toBe(2);
    });
  });

  it("never bypasses policy evaluation: the created work item carries a real policy.decided audit event", async () => {
    await withTempDb(async (dbPath) => {
      const now = new Date("2026-07-23T00:01:00.000Z");
      const result = await runSchedulerOnce({ dbPath, schedules: readOnlySchedule, now });
      const workItemId = result.firings[0]?.workItemId;
      expect(workItemId).toBeDefined();

      const store = new SqliteWorkItemStore(dbPath);
      try {
        const workItem = store.get(workItemId!);
        expect(workItem?.status).toBe("approved");

        const events = store.readEvents();
        const eventNames = events.map((event) => event.name);
        expect(eventNames).toContain("work_item.created");
        expect(eventNames).toContain("policy.decided");

        const policyDecision = events.find(
          (event) =>
            event.name === "policy.decided" && (event.body as { workItemId?: string }).workItemId === workItemId
        );
        expect(policyDecision).toBeDefined();
        expect((policyDecision?.body as { decision?: string }).decision).toBe("allow");
      } finally {
        store.close();
      }
    });
  });

  it("blocks a scheduled high-risk template exactly like any other caller of create_work_item", async () => {
    await withTempDb(async (dbPath) => {
      const dangerousSchedule: ScheduleConfig = [
        {
          scheduleId: "denied-shell-schedule",
          intervalMs: 60_000,
          workItemTemplate: {
            title: "Sudo sweep",
            requester: "system",
            intent: "attempt a denied action",
            target: { cwd: "/repo" },
            requestedActions: [{ kind: "shell", description: "sudo", params: { command: ["sudo", "whoami"] } }],
            risk: "low"
          }
        }
      ];

      const result = await runSchedulerOnce({
        dbPath,
        schedules: dangerousSchedule,
        now: new Date("2026-07-23T00:01:00.000Z")
      });
      const workItemId = result.firings[0]?.workItemId;

      const store = new SqliteWorkItemStore(dbPath);
      try {
        expect(store.get(workItemId!)?.status).toBe("blocked");
      } finally {
        store.close();
      }
    });
  });

  it("returns no firings and creates nothing when no schedules are configured", async () => {
    await withTempDb(async (dbPath) => {
      const result = await runSchedulerOnce({ dbPath, schedules: [], now: new Date("2026-07-23T00:01:00.000Z") });
      expect(result.firings).toHaveLength(0);

      const store = new SqliteWorkItemStore(dbPath);
      try {
        expect(store.list()).toHaveLength(0);
      } finally {
        store.close();
      }
    });
  });

  it("loads and validates schedule config from a JSON file path", async () => {
    await withTempDb(async (dbPath) => {
      const dir = mkdtempSync(join(tmpdir(), "acs-scheduler-config-"));
      const configPath = join(dir, "schedules.json");
      writeFileSync(configPath, JSON.stringify(readOnlySchedule), "utf8");

      try {
        const result = await runSchedulerOnce({
          dbPath,
          scheduleConfigPath: configPath,
          now: new Date("2026-07-23T00:01:00.000Z")
        });
        expect(result.firings).toHaveLength(1);
        expect(result.firings[0]?.created).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("mostRecentScheduledFiring", () => {
  it("aligns to a fixed grid so repeated invocations within one interval agree", () => {
    const schedule = readOnlySchedule[0]!;
    const first = mostRecentScheduledFiring(schedule, new Date("2026-07-23T00:01:00.000Z"));
    const second = mostRecentScheduledFiring(schedule, new Date("2026-07-23T00:01:59.000Z"));
    expect(first?.toISOString()).toBe(second?.toISOString());
  });

  it("advances to the next grid point once intervalMs has fully elapsed", () => {
    const schedule = readOnlySchedule[0]!;
    const first = mostRecentScheduledFiring(schedule, new Date("2026-07-23T00:01:00.000Z"));
    const second = mostRecentScheduledFiring(schedule, new Date("2026-07-23T00:02:00.000Z"));
    expect(second?.getTime()).toBe((first?.getTime() ?? 0) + schedule.intervalMs);
  });

  it("returns undefined before the schedule's anchor", () => {
    const schedule: ScheduleConfig[number] = { ...readOnlySchedule[0]!, anchor: "2099-01-01T00:00:00.000Z" };
    expect(mostRecentScheduledFiring(schedule, new Date("2026-07-23T00:01:00.000Z"))).toBeUndefined();
  });
});

describe("scheduledFiringIdempotencyKey", () => {
  it("is deterministic for the same (scheduleId, firingTime) pair", () => {
    const time = new Date("2026-07-23T00:01:00.000Z");
    expect(scheduledFiringIdempotencyKey("a", time)).toBe(scheduledFiringIdempotencyKey("a", time));
  });

  it("differs when scheduleId differs, even for the same firing time", () => {
    const time = new Date("2026-07-23T00:01:00.000Z");
    expect(scheduledFiringIdempotencyKey("a", time)).not.toBe(scheduledFiringIdempotencyKey("b", time));
  });

  it("differs when firingTime differs, even for the same scheduleId", () => {
    expect(scheduledFiringIdempotencyKey("a", new Date("2026-07-23T00:01:00.000Z"))).not.toBe(
      scheduledFiringIdempotencyKey("a", new Date("2026-07-23T00:02:00.000Z"))
    );
  });
});

describe("scheduleConfigSchema validation", () => {
  const valid = readOnlySchedule[0]!;

  it("accepts a well-formed schedule entry", () => {
    expect(() => scheduleConfigSchema.parse([valid])).not.toThrow();
  });

  it("rejects a missing scheduleId", () => {
    const { scheduleId: _scheduleId, ...rest } = valid;
    expect(() => scheduleConfigSchema.parse([rest])).toThrow();
  });

  it("rejects a non-positive intervalMs", () => {
    expect(() => scheduleConfigSchema.parse([{ ...valid, intervalMs: 0 }])).toThrow();
    expect(() => scheduleConfigSchema.parse([{ ...valid, intervalMs: -1000 }])).toThrow();
  });

  it("rejects a scheduleId with unsafe characters", () => {
    expect(() => scheduleConfigSchema.parse([{ ...valid, scheduleId: "bad id!" }])).toThrow();
  });

  it("rejects an invalid requester", () => {
    expect(() =>
      scheduleConfigSchema.parse([{ ...valid, workItemTemplate: { ...valid.workItemTemplate, requester: "root" } }])
    ).toThrow();
  });

  it("rejects an empty requestedActions array", () => {
    expect(() =>
      scheduleConfigSchema.parse([{ ...valid, workItemTemplate: { ...valid.workItemTemplate, requestedActions: [] } }])
    ).toThrow();
  });

  it("rejects an invalid risk level", () => {
    expect(() =>
      scheduleConfigSchema.parse([{ ...valid, workItemTemplate: { ...valid.workItemTemplate, risk: "extreme" } }])
    ).toThrow();
  });

  it("rejects unknown top-level fields", () => {
    expect(() => scheduleConfigSchema.parse([{ ...valid, cronExpression: "* * * * *" }])).toThrow();
  });
});

describe("multi-process scheduler firing probe (R5)", () => {
  it("10 real concurrent scheduler processes racing the same firing produce exactly one work item", async () => {
    await withTempDb(async (dbPath) => {
      const now = new Date("2026-07-23T00:01:00.000Z");
      const workerScript = fileURLToPath(new URL("./concurrency-probe-worker.ts", import.meta.url));
      const tsxBin = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));

      const runs = await Promise.all(
        Array.from({ length: 10 }, () =>
          runWorker(tsxBin, [workerScript, dbPath, now.toISOString(), JSON.stringify(readOnlySchedule)])
        )
      );

      const results = runs.map((run) => {
        if (run.code !== 0) {
          throw new Error(`worker exited ${run.code}: ${run.stderr}`);
        }
        return JSON.parse(run.stdout) as { firings: Array<{ created: boolean; workItemId?: string }> };
      });

      const created = results.filter((r) => r.firings[0]?.created === true);
      expect(created).toHaveLength(1);
      // Losing processes may observe the firing while the winning process is still
      // creating the work item, so their immediate result legitimately has no ID yet.
      // The invariant is that every defined ID agrees with the sole created work item.
      const workItemIds = new Set(
        results.map((r) => r.firings[0]?.workItemId).filter((id): id is string => id !== undefined)
      );
      expect(workItemIds.size).toBe(1);

      const store = new SqliteWorkItemStore(dbPath);
      try {
        expect(store.list()).toHaveLength(1);
        const firing = store.list().find((item) => item.id === [...workItemIds][0]);
        expect(firing).toBeDefined();
      } finally {
        store.close();
      }
    });
  }, 30_000);
});

function runWorker(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}
