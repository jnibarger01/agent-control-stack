import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDeterministicSqliteEvaluation } from "./sqlite-eval.js";

describe("deterministic evaluation workspace", () => {
  it("resets its owned fixture databases before every run", () => {
    const root = mkdtempSync(join(tmpdir(), "acs-deterministic-reset-"));
    try {
      const first = runDeterministicSqliteEvaluation(root);
      const second = runDeterministicSqliteEvaluation(root);
      expect(second.runs.map((run) => run.semanticDigest)).toEqual(first.runs.map((run) => run.semanticDigest));
      expect(second.tamperDetection).toEqual(first.tamperDetection);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
