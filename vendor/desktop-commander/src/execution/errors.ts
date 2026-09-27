import { RuntimeExecutionError, type RuntimeCauseCategory } from '../runtime/errors.js';

/**
 * Structured Desktop Commander error taxonomy (execution-plane only).
 *
 * These codes describe MECHANICAL outcomes (bad input, path outside scope,
 * precondition drift, timeouts). None of them is an authorization decision:
 * ACS remains the sole authority for allow/deny, approval and capabilities.
 * Built on RuntimeExecutionError so existing consumers keep working.
 */
export const DC_ERROR_CODES = [
  'DC_INVALID_ARGUMENT',
  'DC_PATH_OUTSIDE_ALLOWED_SCOPE',
  'DC_PATH_NOT_FOUND',
  'DC_PATH_CHANGED',
  'DC_HASH_MISMATCH',
  'DC_HEAD_MISMATCH',
  'DC_NOT_A_GIT_REPOSITORY',
  'DC_PROCESS_NOT_OWNED',
  'DC_PROCESS_NOT_FOUND',
  'DC_COMMAND_FORBIDDEN',
  'DC_COMMAND_NOT_FOUND',
  'DC_TIMEOUT',
  'DC_OUTPUT_TRUNCATED',
  'DC_PATCH_REJECTED',
  'DC_SNAPSHOT_INVALID',
  'DC_SNAPSHOT_TOO_LARGE',
  'DC_PERMISSION_DENIED',
  'DC_SUBSYSTEM_UNAVAILABLE',
  'DC_INTERNAL_ERROR',
] as const;

export type DcErrorCode = typeof DC_ERROR_CODES[number];

export type DcErrorStage =
  | 'validate'
  | 'resolve'
  | 'precondition'
  | 'execute'
  | 'commit'
  | 'observe'
  | 'internal';

export interface DcErrorOptions {
  stage?: DcErrorStage;
  retryable?: boolean;
  errno?: string;
  ruleId?: string;
  causeCategory?: RuntimeCauseCategory;
  details?: Record<string, string | number | boolean | null>;
  cause?: unknown;
  requestId?: string;
}

const DEFAULT_CATEGORY: Record<DcErrorCode, RuntimeCauseCategory> = {
  DC_INVALID_ARGUMENT: 'validation',
  DC_PATH_OUTSIDE_ALLOWED_SCOPE: 'validation',
  DC_PATH_NOT_FOUND: 'filesystem',
  DC_PATH_CHANGED: 'filesystem',
  DC_HASH_MISMATCH: 'validation',
  DC_HEAD_MISMATCH: 'validation',
  DC_NOT_A_GIT_REPOSITORY: 'validation',
  DC_PROCESS_NOT_OWNED: 'validation',
  DC_PROCESS_NOT_FOUND: 'process',
  DC_COMMAND_FORBIDDEN: 'validation',
  DC_COMMAND_NOT_FOUND: 'process',
  DC_TIMEOUT: 'timeout',
  DC_OUTPUT_TRUNCATED: 'process',
  DC_PATCH_REJECTED: 'validation',
  DC_SNAPSHOT_INVALID: 'filesystem',
  DC_SNAPSHOT_TOO_LARGE: 'validation',
  DC_PERMISSION_DENIED: 'filesystem',
  DC_SUBSYSTEM_UNAVAILABLE: 'configuration',
  DC_INTERNAL_ERROR: 'unknown',
};

const DEFAULT_RETRYABLE: Partial<Record<DcErrorCode, boolean>> = {
  DC_TIMEOUT: true,
  DC_SUBSYSTEM_UNAVAILABLE: true,
  DC_PATH_CHANGED: true,
};

export class DcToolError extends RuntimeExecutionError {
  readonly stage: DcErrorStage;
  readonly errno?: string;
  readonly ruleId?: string;
  readonly details?: Record<string, string | number | boolean | null>;

  constructor(readonly dcCode: DcErrorCode, message: string, options: DcErrorOptions = {}) {
    super(dcCode, message, {
      retryable: options.retryable ?? DEFAULT_RETRYABLE[dcCode] ?? false,
      requestId: options.requestId,
      causeCategory: options.causeCategory ?? DEFAULT_CATEGORY[dcCode],
      diagnostics: options.details,
      cause: options.cause,
    });
    this.name = 'DcToolError';
    this.stage = options.stage ?? 'execute';
    this.errno = options.errno;
    this.ruleId = options.ruleId;
    this.details = options.details;
  }
}

const ERRNO_MAP: Record<string, DcErrorCode> = {
  ENOENT: 'DC_PATH_NOT_FOUND',
  ENOTDIR: 'DC_PATH_NOT_FOUND',
  EACCES: 'DC_PERMISSION_DENIED',
  EPERM: 'DC_PERMISSION_DENIED',
  ETIMEDOUT: 'DC_TIMEOUT',
};

/**
 * Classify any thrown value into a DcToolError. Existing DC failure messages
 * (e.g. validatePath's "Path not allowed") are mapped onto the taxonomy so
 * callers get a code instead of only prose.
 */
export function toDcError(error: unknown, stage: DcErrorStage = 'internal'): DcToolError {
  if (error instanceof DcToolError) return error;
  const errno = typeof (error as NodeJS.ErrnoException | undefined)?.code === 'string'
    ? (error as NodeJS.ErrnoException).code
    : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (errno && ERRNO_MAP[errno]) {
    return new DcToolError(ERRNO_MAP[errno], message, { stage, errno, cause: error });
  }
  if (/^Path not allowed:/.test(message)) {
    return new DcToolError('DC_PATH_OUTSIDE_ALLOWED_SCOPE', message, { stage: 'resolve', ruleId: 'allowed_directories', cause: error });
  }
  if (/timed out|timeout/i.test(message)) {
    return new DcToolError('DC_TIMEOUT', message, { stage, cause: error });
  }
  if (error instanceof RuntimeExecutionError) {
    return new DcToolError('DC_INTERNAL_ERROR', message, { stage, causeCategory: error.causeCategory, retryable: error.retryable, cause: error });
  }
  return new DcToolError('DC_INTERNAL_ERROR', message, { stage, cause: error });
}
