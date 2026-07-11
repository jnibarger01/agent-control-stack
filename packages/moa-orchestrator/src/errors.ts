export type MoaErrorCode =
  | "ADVISOR_FAILED"
  | "AGGREGATOR_INVALID"
  | "CONFIG_INVALID"
  | "DECISION_INCONSISTENT"
  | "ENVELOPE_INVALID"
  | "EXECUTION_NOT_APPROVED"
  | "IDEMPOTENCY_REQUIRED"
  | "PRESET_UNKNOWN"
  | "RECURSION_REJECTED";

export class MoaError extends Error {
  constructor(
    public readonly code: MoaErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "MoaError";
  }
}

export function isMoaError(error: unknown): error is MoaError {
  return error instanceof MoaError;
}
