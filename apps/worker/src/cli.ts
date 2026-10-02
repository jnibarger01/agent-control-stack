import { runWorkerOnce } from "./index.js";
import { authenticatedWorkerClaimFromEnv } from "./claim-client.js";
import { runWorkerLoop, workerPollIntervalMsFromEnv } from "./worker-loop.js";

const claimOptions = authenticatedWorkerClaimFromEnv();
if (!claimOptions) {
  const result = await runWorkerOnce();
  console.log(JSON.stringify(result));
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
