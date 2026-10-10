import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { commandPolicyCorpus, DECISION_RANK } from "./command-policy-corpus.test-support.js";
import { evaluatePolicy } from "./policy.js";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "command-policy-legacy.fixture.json");
const legacy = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<
  string,
  { decision: keyof typeof DECISION_RANK; matchedRules: string[] }
>;

describe("command classification is monotonic (never looser than the pre-P0-1 fixture)", () => {
  const corpus = commandPolicyCorpus();

  it("covers every fixture entry and every corpus entry", () => {
    const corpusIds = new Set(corpus.map((entry) => entry.id));
    expect(Object.keys(legacy).sort()).toEqual([...corpusIds].sort());
  });

  for (const entry of corpus) {
    it(`does not loosen: ${entry.id}`, () => {
      const previous = legacy[entry.id];
      expect(previous, `missing fixture entry for ${entry.id}`).toBeDefined();
      const current = evaluatePolicy(entry.context);
      expect(DECISION_RANK[current.decision]).toBeGreaterThanOrEqual(DECISION_RANK[previous.decision]);
    });
  }
});
