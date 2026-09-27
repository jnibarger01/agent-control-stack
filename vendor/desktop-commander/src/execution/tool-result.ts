import type { ServerResult } from '../types.js';
import { DcToolError, toDcError } from './errors.js';
import { currentRequestContext } from './context.js';
import { recordLastError, sanitizeMessage } from './last-error.js';

/**
 * Uniform result shapes for execution tools: JSON text on success; on failure
 * a structured error { code, requestId, stage, message, retryable, … } that is
 * also recorded for last_error. Messages are secret-redacted; stack traces are
 * never returned.
 */
export function jsonResult(value: unknown): ServerResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export interface StructuredErrorBody {
  code: string;
  requestId: string | null;
  correlationId: string | null;
  stage: string;
  message: string;
  retryable: boolean;
  causeCategory: string;
  errno?: string;
  ruleId?: string;
  details?: Record<string, string | number | boolean | null>;
}

export function structuredError(error: unknown): StructuredErrorBody {
  const dcError: DcToolError = toDcError(error);
  const context = currentRequestContext();
  return {
    code: dcError.dcCode,
    requestId: context?.requestId ?? null,
    correlationId: context?.correlationId ?? null,
    stage: dcError.stage,
    message: sanitizeMessage(dcError.message),
    retryable: dcError.retryable,
    causeCategory: dcError.causeCategory,
    ...(dcError.errno ? { errno: dcError.errno } : {}),
    ...(dcError.ruleId ? { ruleId: dcError.ruleId } : {}),
    ...(dcError.details ? { details: dcError.details } : {}),
  };
}

export function errorResult(error: unknown): ServerResult {
  const body = structuredError(error);
  const context = currentRequestContext();
  if (context) {
    recordLastError(context, error, body.stage as any);
    (context as any).errorRecorded = true;
    context.evidence.errorCode = body.code;
    context.evidence.errorCategory = body.causeCategory;
  }
  return { content: [{ type: 'text', text: JSON.stringify({ error: body }, null, 2) }], isError: true };
}

export async function runTool<T>(fn: () => Promise<T>): Promise<ServerResult> {
  try {
    return jsonResult(await fn());
  } catch (error) {
    return errorResult(error);
  }
}
