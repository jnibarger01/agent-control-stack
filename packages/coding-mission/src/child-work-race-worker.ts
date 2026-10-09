import { createInterface } from "node:readline";
import type { ChildWorkRequest } from "./child-work.js";
import { CodingMissionStore } from "./store.js";

/**
 * Test-only process used by child-work.test.ts. Each process opens its own connection to the shared database, reports
 * "ready", waits for "go" on stdin so all racers start together, then issues one request_child_work and prints the
 * result as JSON. The parent test owns the assertions.
 */
const [dbPath, requestJson] = process.argv.slice(2);
if (!dbPath || !requestJson) throw new Error("usage: child-work-race-worker <db> <request-json>");
const request = JSON.parse(requestJson) as ChildWorkRequest;

const store = new CodingMissionStore(dbPath);
const lines = createInterface({ input: process.stdin });
process.stdout.write("ready\n");
lines.once("line", () => {
  let output: unknown;
  try {
    output = store.requestChildWork(request);
  } catch (error) {
    output = { threw: error instanceof Error ? error.message : String(error) };
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  store.close();
  process.exit(0);
});
