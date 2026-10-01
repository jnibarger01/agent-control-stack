import { runSchedulerOnce } from "./index.js";

const result = await runSchedulerOnce();
console.log(JSON.stringify(result));
// A failing schedule is reported in `failures` instead of aborting the other
// schedules, so the run itself must still fail: a scheduled unit that exits 0
// while schedules did not fire is a silent outage.
for (const failure of result.failures) {
  console.error(`scheduler ${failure.scheduleId} failed at ${failure.stage}: ${failure.error}`);
}
if (result.failures.length > 0) {
  process.exitCode = 1;
}
