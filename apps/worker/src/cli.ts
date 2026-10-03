import { ControlStackError } from "@agent-control-stack/shared";
import { runWorkerOnce, runConfiguredMission } from "./index.js";
import { authenticatedWorkerClaimFromEnv } from "./claim-client.js";
import { runWorkerLoop, workerPollIntervalMsFromEnv } from "./worker-loop.js";

if (process.env.ACS_MISSION_ID) {
  try {
    const result = await runConfiguredMission();
    console.log(JSON.stringify(result));
    process.exitCode = result.status === "completed" ? 0 : 2;
  } catch (error) {
    // Transport/parser failures may carry raw response data. Only stable,
    // non-secret control-plane codes cross the CLI output boundary.
    console.error(
      JSON.stringify({
        status: "blocked",
        code: error instanceof ControlStackError ? error.code : "mission_runner_failed"
      })
    );
    process.exitCode = 1;
  }
} else {
  const claimOptions = authenticatedWorkerClaimFromEnv();
  if (!claimOptions) {
    console.log(JSON.stringify(await runWorkerOnce()));
  } else {
    const shutdown = new AbortController();
    const stop = (): void => shutdown.abort();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    try {
      await runWorkerLoop({
        workerOptions: claimOptions,
        pollIntervalMs: workerPollIntervalMsFromEnv(),
        signal: shutdown.signal,
        onResult: (result) => {
          if (result.executed || result.reason !== "no approved work item") console.log(JSON.stringify(result));
        },
        onTransientFailure: (code, retryInMs) =>
          process.stderr.write(`${JSON.stringify({ event: "worker_claim_retry", code, retryInMs })}\n`)
      });
    } finally {
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
    }
  }
}
