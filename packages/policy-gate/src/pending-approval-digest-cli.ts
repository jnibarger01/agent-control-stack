import { runPendingApprovalDigestOnce } from "./pending-approval-digest.js";

try {
  await runPendingApprovalDigestOnce();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
