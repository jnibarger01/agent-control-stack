import { describe, expect, it } from "vitest";
import { estimateCost, estimateRoutedCost, priceFor } from "./cost.js";
import { MODEL_IDS } from "./routing.js";

describe("routing cost model", () => {
  it("uses the introductory Sonnet 5 price through 2026-08-31", () => {
    expect(priceFor(MODEL_IDS.sonnet, "2026-08-31")).toMatchObject({
      inputUsdPerMTok: 2,
      outputUsdPerMTok: 10
    });
  });

  it("uses the standard Sonnet 5 price starting 2026-09-01", () => {
    expect(priceFor(MODEL_IDS.sonnet, "2026-09-01")).toMatchObject({
      inputUsdPerMTok: 3,
      outputUsdPerMTok: 15
    });
  });

  it.each([
    [MODEL_IDS.fable, 10, 50],
    [MODEL_IDS.mythos, 10, 50],
    [MODEL_IDS.opus, 5, 25],
    [MODEL_IDS.haiku, 1, 5]
  ] as const)("keeps the verified fixed price for %s", (modelId, input, output) => {
    expect(priceFor(modelId, "2026-07-09")).toMatchObject({
      inputUsdPerMTok: input,
      outputUsdPerMTok: output
    });
  });

  it("estimates input, output, and total spend from token counts", () => {
    expect(
      estimateCost({
        modelId: MODEL_IDS.fable,
        inputTokens: 1_000_000,
        outputTokens: 2_000_000,
        onDate: "2026-07-09"
      })
    ).toMatchObject({ inputUsd: 10, outputUsd: 100, totalUsd: 110 });
  });

  it("routes a task before estimating its predicted cost", () => {
    expect(
      estimateRoutedCost({
        taskClass: "bulk_worker",
        attempt: 0,
        lastFailure: null,
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        onDate: "2026-08-31"
      })
    ).toMatchObject({ modelId: MODEL_IDS.sonnet, inputUsd: 2, outputUsd: 10, totalUsd: 12 });
  });

  it("rejects invalid token counts and ambiguous dates", () => {
    expect(() =>
      estimateCost({
        modelId: MODEL_IDS.haiku,
        inputTokens: -1,
        outputTokens: 0,
        onDate: "2026-07-09"
      })
    ).toThrow("inputTokens");
    expect(() => priceFor(MODEL_IDS.sonnet, "09/01/2026")).toThrow("YYYY-MM-DD");
  });
});
