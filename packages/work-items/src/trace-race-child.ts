import { SqliteWorkItemStore } from "./store.js";

const [dbPath, workItemId, actionHash, instance] = process.argv.slice(2);
if (!dbPath || !workItemId || !actionHash || !instance) {
  process.stderr.write("usage: trace-race-child <db> <workItemId> <actionHash> <instance>\n");
  process.exit(2);
}

const store = new SqliteWorkItemStore(dbPath, { traceInstance: instance, releaseSha: "unreleased" });
try {
  store.recordApproval({ workItemId, actionHash, approvedBy: "user" });
} finally {
  store.close();
}
