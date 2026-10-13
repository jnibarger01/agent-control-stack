import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_ROUTES, ModelRouteError, selectModelRoute } from "./router.js";

describe("selectModelRoute", () => {
  it("picks the first installed route for the operation and ignores later ones", () => {
    const installed = new Set(["qwen3-coder:30b", "qwen2.5-coder:7b"]);
    expect(selectModelRoute(DEFAULT_MODEL_ROUTES, "review_plan", installed).model).toBe("qwen3-coder:30b");
    expect(selectModelRoute(DEFAULT_MODEL_ROUTES, "diagnose_failure", installed).model).toBe("qwen2.5-coder:7b");
  });

  it("does not select a configured model that is not installed", () => {
    const installed = new Set(["qwen2.5-coder:7b"]);
    expect(selectModelRoute(DEFAULT_MODEL_ROUTES, "review_plan", installed).role).toBe("fallback");
  });

  it("fails closed when nothing installed matches", () => {
    expect(() => selectModelRoute(DEFAULT_MODEL_ROUTES, "review_plan", new Set())).toThrow(ModelRouteError);
  });
});
