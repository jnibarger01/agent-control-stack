import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDeterministicEvaluation } from "./deterministic.js";

const root = mkdtempSync(join(tmpdir(), "acs-deterministic-eval-"));
try {
  console.log(JSON.stringify(runDeterministicEvaluation(root), null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
