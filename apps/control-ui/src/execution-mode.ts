import { escapeHtml } from "./html.js";

/**
 * Execution mode derived from a work item's persisted result metadata, per the
 * Mission Control wave-2 plan item #10 (unmistakable dry-run labeling).
 *
 * The chip always comes from persisted result data, never from configuration:
 * `unknown` means a result exists but carries no mode metadata, which is
 * itself an operator-visible anomaly.
 */
export type ResultExecutionMode = "dry_run" | "desktop_commander" | "unknown";

export interface ResultBearingWorkItem {
  result?: Record<string, unknown>;
}

const RESULT_EXECUTION_MODE_VALUES: readonly ResultExecutionMode[] = ["dry_run", "desktop_commander", "unknown"];

function modeFromRecord(value: unknown): string | undefined {
  return value && typeof value === "object" && typeof (value as Record<string, unknown>).executionMode === "string"
    ? ((value as Record<string, unknown>).executionMode as string)
    : undefined;
}

/**
 * Derive the execution mode from the persisted result: the top-level
 * `executionMode` (snake_case accepted), else `simulationMetadata.executionMode`.
 * Returns `unknown` when the result carries no recognizable mode.
 */
export function resultExecutionMode(item: ResultBearingWorkItem): ResultExecutionMode {
  const result = item.result;
  if (!result || !hasExecutionResult(item)) return "unknown";
  const candidates = [
    result.executionMode,
    result.execution_mode,
    modeFromRecord(result.simulationMetadata)
  ];
  for (const candidate of candidates) {
    if (candidate === "dry_run" || candidate === "desktop_commander") {
      return candidate;
    }
  }
  return "unknown";
}

/** True when the item has a persisted result, i.e. its mode must be visible. */
export function hasExecutionResult(item: ResultBearingWorkItem): boolean {
  return Boolean(item.result && typeof item.result === "object" && !Array.isArray(item.result));
}

const EXECUTION_MODE_CHIP_LABELS: Record<ResultExecutionMode, string> = {
  dry_run: "DRY RUN",
  desktop_commander: "LIVE EXECUTION",
  unknown: "MODE UNKNOWN"
};

/**
 * Mode chip for a work item with a persisted result. Returns empty markup for
 * items without a result (no result shown, no chip required), so every UI path
 * that surfaces an execution result also surfaces its mode.
 */
export function executionModeChip(item: ResultBearingWorkItem): string {
  if (!hasExecutionResult(item)) return "";
  const mode = resultExecutionMode(item);
  return `<span class="pill execution-mode execution-mode-${escapeHtml(mode)}" data-execution-mode="${escapeHtml(mode)}">${EXECUTION_MODE_CHIP_LABELS[mode]}</span>`;
}

/**
 * Chip from an already-derived mode value, for view models that carry the mode
 * explicitly (`"none"` or omitted means no persisted result, so no chip).
 */
export function executionModeChipHtml(mode: ResultExecutionMode | "none" | undefined): string {
  if (!mode || mode === "none" || !RESULT_EXECUTION_MODE_VALUES.includes(mode)) return "";
  return ` <span class="pill execution-mode execution-mode-${escapeHtml(mode)}" data-execution-mode="${escapeHtml(mode)}">${EXECUTION_MODE_CHIP_LABELS[mode]}</span>`;
}
