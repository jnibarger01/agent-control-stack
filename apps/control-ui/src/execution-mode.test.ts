import { describe, expect, it } from "vitest";
import {
  executionModeChip,
  executionModeChipHtml,
  hasExecutionResult,
  resultExecutionMode
} from "./execution-mode.js";

describe("result execution mode derivation (wave-2 plan item #10)", () => {
  it("returns unknown when there is no result at all", () => {
    expect(resultExecutionMode({})).toBe("unknown");
    expect(resultExecutionMode({ result: undefined })).toBe("unknown");
  });

  it("reads the camelCase executionMode from the persisted result", () => {
    expect(resultExecutionMode({ result: { executionMode: "dry_run", summary: "ok" } })).toBe("dry_run");
    expect(resultExecutionMode({ result: { executionMode: "desktop_commander" } })).toBe("desktop_commander");
  });

  it("accepts the snake_case variant emitted by the audit attributes", () => {
    expect(resultExecutionMode({ result: { execution_mode: "dry_run" } })).toBe("dry_run");
  });

  it("falls back to simulationMetadata.executionMode", () => {
    expect(
      resultExecutionMode({
        result: { simulationMetadata: { executionMode: "dry_run", simulated: true, reason: "approved_dispatch" } }
      })
    ).toBe("dry_run");
  });

  it("prefers the top-level mode over simulation metadata", () => {
    expect(
      resultExecutionMode({
        result: { executionMode: "desktop_commander", simulationMetadata: { executionMode: "dry_run" } }
      })
    ).toBe("desktop_commander");
  });

  it("returns unknown for a result without recognizable mode metadata", () => {
    expect(resultExecutionMode({ result: { summary: "done" } })).toBe("unknown");
    expect(resultExecutionMode({ result: { executionMode: "yolo" } })).toBe("unknown");
    expect(resultExecutionMode({ result: { simulationMetadata: "corrupt" } })).toBe("unknown");
  });

  it("flags which items carry a persisted result", () => {
    expect(hasExecutionResult({})).toBe(false);
    expect(hasExecutionResult({ result: { summary: "done" } })).toBe(true);
    // Arrays and primitives are not result records.
    expect(hasExecutionResult({ result: [] as unknown as Record<string, unknown> })).toBe(false);
  });
});

describe("execution mode chip", () => {
  it("renders no chip when the item has no persisted result", () => {
    expect(executionModeChip({})).toBe("");
  });

  it("always renders a chip alongside a result, even without mode metadata", () => {
    const chip = executionModeChip({ result: { summary: "done" } });
    expect(chip).toContain("MODE UNKNOWN");
    expect(chip).toContain('data-execution-mode="unknown"');
  });

  it("marks dry-run results unmistakably", () => {
    const chip = executionModeChip({ result: { executionMode: "dry_run" } });
    expect(chip).toContain("DRY RUN");
    expect(chip).toContain('class="pill execution-mode execution-mode-dry_run"');
  });

  it("marks live results explicitly", () => {
    expect(executionModeChip({ result: { executionMode: "desktop_commander" } })).toContain("LIVE EXECUTION");
  });

  it("escapes hostile mode values instead of trusting result metadata", () => {
    const chip = executionModeChipHtml("unknown");
    expect(chip).toContain("MODE UNKNOWN");
    // Non-enum values render nothing rather than injecting markup.
    expect(executionModeChipHtml("dry_run\"><script>" as never)).toBe("");
  });
});
