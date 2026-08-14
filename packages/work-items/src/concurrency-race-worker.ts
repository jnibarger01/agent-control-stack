import { workerData, parentPort } from "node:worker_threads";
import { SqliteWorkItemStore } from "./store.js";

type Race =
  | { kind: "claim"; dbPath: string; workerId: string }
  | { kind: "consume"; dbPath: string; workItemId: string; actionHash: string }
  | { kind: "result"; dbPath: string; input: unknown }
  | { kind: "retry"; dbPath: string; workItemId: string; actor: string }
  | { kind: "cancel"; dbPath: string; workItemId: string; actor: string }
  | { kind: "mixed"; dbPath: string; workItemId: string; actor: string; op: "retry" | "cancel" }
  | { kind: "lease"; dbPath: string; input: any };

const input = workerData as Race & { barrier: SharedArrayBuffer };
const barrier = new Int32Array(input.barrier);
Atomics.add(barrier, 0, 1);
Atomics.notify(barrier, 0);
while (Atomics.load(barrier, 0) < 2) Atomics.wait(barrier, 0, 1);

try {
  const store = new SqliteWorkItemStore(input.dbPath);
  let value: unknown;
  if (input.kind === "claim")
    value = store.claimNextApprovedWorkItem(input.workerId, { allowLegacyClaimForTests: true });
  else if (input.kind === "lease")
    value = store.leaseAttempt({ ...input.input, workerId: input.workerId }, { via: "domain_service" });
  else if (input.kind === "consume") value = store.consumeApproval(input.workItemId, input.actionHash);
  else if (input.kind === "result") value = store.submitWorkResult(input.input);
  else if (input.kind === "retry" || (input.kind === "mixed" && input.op === "retry"))
    value = store.retryWorkItem(input.workItemId, { actor: input.actor, reason: "concurrent retry" });
  else
    value = store.cancelWorkItem(
      input.workItemId,
      { actor: input.actor },
      { via: "domain_service", actorId: input.actor }
    );
  store.close();
  parentPort?.postMessage({ ok: true, value });
} catch (error) {
  const e = error as { code?: string; message?: string };
  parentPort?.postMessage({ ok: false, error: { code: e.code, message: e.message } });
}
