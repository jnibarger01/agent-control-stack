/* global setInterval */
// Test fixture: ACS claims a unit, starts an attempt process, records it, then waits to be SIGKILLed.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [dbPath, registryPath, missionId, unitId, readyFile] = process.argv.slice(2);
const { CodingMissionStore } = await import("@agent-control-stack/coding-mission");
const { createFileAttemptRegistry, processIdentity } = await import("@agent-control-stack/ai-factory-runtime");
const store = new CodingMissionStore(dbPath);
const token = "crash-token";
const claim = store.claimUnit(missionId, unitId, { token, workerId: "w", route: {}, claimedAt: new Date().toISOString() });
if (!claim.ok) throw new Error("claim failed " + claim.outcome);
const attempt = spawn("/bin/sleep", ["120"], { detached: true, stdio: "ignore" });
attempt.unref();
const identity = processIdentity(attempt.pid);
createFileAttemptRegistry(registryPath).put({ missionId, unitId, claimToken: token, process: identity, startedAt: new Date().toISOString() });
writeFileSync(readyFile, JSON.stringify({ pid: attempt.pid, identity }));
setInterval(() => undefined, 1_000);
