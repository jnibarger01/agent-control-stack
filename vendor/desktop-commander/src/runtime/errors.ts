export type RuntimeCauseCategory =
  | 'configuration'
  | 'authorization'
  | 'transport'
  | 'process'
  | 'filesystem'
  | 'timeout'
  | 'validation'
  | 'unknown';

export interface RuntimeErrorOptions {
  retryable?: boolean;
  requestId?: string;
  causeCategory?: RuntimeCauseCategory;
  diagnostics?: Record<string, string | number | boolean | null>;
  cause?: unknown;
}

export class RuntimeExecutionError extends Error {
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly causeCategory: RuntimeCauseCategory;
  readonly diagnostics?: Record<string, string | number | boolean | null>;

  constructor(
    readonly code: string,
    message: string,
    options: RuntimeErrorOptions = {},
  ) {
    super(message);
    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: options.cause, enumerable: false, configurable: true });
    }
    this.name = 'RuntimeExecutionError';
    this.retryable = options.retryable ?? false;
    this.requestId = options.requestId;
    this.causeCategory = options.causeCategory ?? 'unknown';
    this.diagnostics = options.diagnostics;
  }
}

export function toRuntimeError(error: unknown, fallbackCode = 'RUNTIME_FAILURE'): RuntimeExecutionError {
  if (error instanceof RuntimeExecutionError) return error;
  return new RuntimeExecutionError(
    fallbackCode,
    error instanceof Error ? error.message : 'The runtime operation failed.',
    { cause: error },
  );
}
