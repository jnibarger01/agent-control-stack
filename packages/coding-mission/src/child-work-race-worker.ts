import { createInterface } from "node:readline";
import { PARENT_TOKEN, PARENT_WORKER, MISSION, NOW, childItem, openLedger } from "./child-work-race-fixture.js";

/**
 * Test-only process used by child-work-race.test.ts. Each process opens its own connection to the shared database,
 * prints "ready", waits for "go" on stdin so every racer starts together, performs exactly one operation, and prints
 * the result as JSON. The parent test owns the assertions.
 */
type Job = { kind: "request"; unitId: string } | { kind: "claim"; unitId: string; token: string; workerId: string };

const [dbPath, jobJson] = process.argv.slice(2);
if (!dbPath || !jobJson) throw new Error("usage: child-work-race-worker <db> <job-json>");
const job = JSON.parse(jobJson) as Job;

const { store, ledger } = openLedger(dbPath);
const lines = createInterface({ input: process.stdin });
process.stdout.write("ready\n");
lines.once("line", () => {
  let output: unknown;
  try {
    output =
      job.kind === "request"
        ? ledger.requestChildWork({
            missionId: MISSION,
            parentUnitId: "root",
            workerId: PARENT_WORKER,
            claimToken: PARENT_TOKEN,
            children: [childItem(job.unitId)]
          })
        : store.claimUnit(MISSION, job.unitId, {
            token: job.token,
            workerId: job.workerId,
            route: {},
            claimedAt: NOW
          });
  } catch (error) {
    output = { threw: error instanceof Error ? error.message : String(error) };
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  store.close();
  process.exit(0);
});
