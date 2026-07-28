// Standalone worker process for the multi-process scheduler concurrency
// probe (see index.test.ts). Spawned via tsx so it runs the same TS source
// as the rest of the package, no build step required. Deliberately minimal:
// read dbPath + now + schedule JSON from argv, call runSchedulerOnce once,
// print the result as JSON on stdout for the parent to collect.
import { runSchedulerOnce, type ScheduleConfig } from "./index.js";

const [, , dbPath, nowIso, scheduleJson] = process.argv;
if (!dbPath || !nowIso || !scheduleJson) {
  throw new Error("usage: concurrency-probe-worker.ts <dbPath> <nowIso> <scheduleJson>");
}

const schedules = JSON.parse(scheduleJson) as ScheduleConfig;

const result = await runSchedulerOnce({ dbPath, schedules, now: new Date(nowIso) });
process.stdout.write(JSON.stringify(result));
