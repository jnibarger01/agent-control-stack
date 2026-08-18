import { writeFileSync } from "node:fs";
import { runWorkerOnce, type WorkerExecute } from "./index.js";

const dbPath = process.argv[2];
const outPath = process.argv[3];
if (!dbPath || !outPath) {
  throw new Error("usage: learning-worker-child <dbPath> <outPath>");
}

const execute: WorkerExecute = async (workItem) => {
  const payload = {
    workItemId: workItem.id,
    retrievedSkills: workItem.retrievedSkills.map((skill) => ({
      skillId: skill.skillId,
      version: skill.version,
      confidence: skill.confidence
    }))
  };
  writeFileSync(outPath, JSON.stringify(payload));
  return {
    ok: true,
    executionMode: "dry_run",
    output: `injected ${payload.retrievedSkills.map((skill) => skill.skillId).join(",")}`,
    usedSkillNames: payload.retrievedSkills.map((skill) => skill.skillId)
  };
};

const result = await runWorkerOnce({
  dbPath,
  workerId: "e2e-child-worker",
  execute,
  validator: {
    async validate() {
      return {
        passed: true,
        checks: [{ name: "engine_outcome", passed: true, detail: "child validator pass" }]
      };
    }
  }
});
writeFileSync(`${outPath}.result.json`, JSON.stringify(result));
