import { ControlStackError } from "@agent-control-stack/shared";
import { runWorkerOnce, runConfiguredMission } from "./index.js";

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
  console.log(JSON.stringify(await runWorkerOnce()));
}
