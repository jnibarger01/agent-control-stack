import { DcToolError, toDcError, type DcErrorStage } from './errors.js';
import type { RequestContext } from './context.js';
import { redactText } from './secret-scan.js';

/**
 * Structured "last error" diagnostics (last_error tool).
 *
 * Records are sanitized at write time: messages are secret-redacted and
 * length-bounded, only argument HASHES are kept (never raw arguments), and
 * stack traces never leave the process (they stay in local debug logs).
 */
export interface LastErrorRecord {
  requestId: string;
  correlationId: string | null;
  timestamp: string;
  tool: string;
  stage: DcErrorStage;
  errorCode: string;
  errno: string | null;
  ruleId: string | null;
  message: string;
  normalizedArgumentsHash: string | null;
  causeCategory: string;
  retryable: boolean;
}

const MAX_RECORDS = 50;
const MAX_MESSAGE = 1_000;
const records: LastErrorRecord[] = [];

export function sanitizeMessage(message: string): string {
  // Collapse whitespace, strip anything that looks like a stack frame, bound.
  const noStack = message.split('\n').filter((line) => !/^\s+at\s/.test(line)).join(' ');
  return redactText(noStack).replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE);
}

export function recordLastError(context: Pick<RequestContext, 'requestId' | 'correlationId' | 'tool' | 'normalizedArgumentsHash'>, error: unknown, stage?: DcErrorStage): LastErrorRecord {
  const dcError: DcToolError = toDcError(error, stage ?? 'internal');
  const record: LastErrorRecord = {
    requestId: context.requestId,
    correlationId: context.correlationId,
    timestamp: new Date().toISOString(),
    tool: context.tool,
    stage: stage ?? dcError.stage,
    errorCode: dcError.dcCode,
    errno: dcError.errno ?? null,
    ruleId: dcError.ruleId ?? null,
    message: sanitizeMessage(dcError.message),
    normalizedArgumentsHash: context.normalizedArgumentsHash,
    causeCategory: dcError.causeCategory,
    retryable: dcError.retryable,
  };
  records.push(record);
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
  return record;
}

/** Record a failure that surfaced as a structured code (e.g. managed guard rejection). */
export function recordLastErrorCode(
  context: Pick<RequestContext, 'requestId' | 'correlationId' | 'tool' | 'normalizedArgumentsHash'>,
  code: string,
  message: string,
  options: { stage: DcErrorStage; causeCategory: string; retryable: boolean; ruleId?: string },
): LastErrorRecord {
  const record: LastErrorRecord = {
    requestId: context.requestId,
    correlationId: context.correlationId,
    timestamp: new Date().toISOString(),
    tool: context.tool,
    stage: options.stage,
    errorCode: code,
    errno: null,
    ruleId: options.ruleId ?? null,
    message: sanitizeMessage(message),
    normalizedArgumentsHash: context.normalizedArgumentsHash,
    causeCategory: options.causeCategory,
    retryable: options.retryable,
  };
  records.push(record);
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
  return record;
}

export function lastErrors(filter: { limit?: number; tool?: string; requestId?: string; correlationId?: string } = {}): LastErrorRecord[] {
  const limit = Math.max(1, Math.min(filter.limit ?? 1, MAX_RECORDS));
  return records
    .filter((record) => (!filter.tool || record.tool === filter.tool)
      && (!filter.requestId || record.requestId === filter.requestId)
      && (!filter.correlationId || record.correlationId === filter.correlationId))
    .slice(-limit)
    .reverse();
}

/** Test hook. */
export function clearLastErrors(): void {
  records.length = 0;
}
