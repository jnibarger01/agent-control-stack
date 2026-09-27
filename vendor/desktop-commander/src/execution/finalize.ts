import type { ServerResult } from '../types.js';
import { getRuntimeIdentityState } from '../runtime-identity.js';
import type { RequestContext } from './context.js';
import { executionEvents, type ExecutionOutcome } from './events.js';
import { recordLastError, recordLastErrorCode } from './last-error.js';
import { toDcError } from './errors.js';
import { operationClass, toolMechanics } from './tool-catalog.js';

/**
 * Central per-call finalization (every tool, old and new):
 *  - results carry _meta.dcExecution {requestId, correlationId}
 *  - error results without a structured body gain one extra content item
 *    {"dcError": {...}} (the original first content item is unchanged)
 *  - every failure is recorded for last_error
 *  - one redacted execution event is emitted (evidence, never a gate)
 */
let runtimeIdCache: string | null = null;
let runtimeIdLoading: Promise<void> | null = null;
function runtimeId(): string | null {
  if (runtimeIdCache === null && runtimeIdLoading === null) {
    runtimeIdLoading = getRuntimeIdentityState()
      .then((state) => { runtimeIdCache = state.runtime_id; })
      .catch(() => { runtimeIdLoading = null; });
  }
  return runtimeIdCache;
}

function firstText(result: ServerResult | undefined): string {
  const item = (result as any)?.content?.[0];
  return item && item.type === 'text' && typeof item.text === 'string' ? item.text : '';
}

function hasStructuredError(result: ServerResult): boolean {
  return ((result as any).content ?? []).some((item: any) => item?.type === 'text' && typeof item.text === 'string' && /^\{\s*"(error|dcError)"\s*:/.test(item.text));
}

function managedRejection(result: ServerResult): string | undefined {
  const acs = (result as any)?._meta?.acsAuthorization;
  return acs && acs.decision === 'denied' && typeof acs.code === 'string' ? acs.code : undefined;
}

export function decorateExecutionResult(result: ServerResult, context: RequestContext): ServerResult {
  const decorated: any = { ...result, _meta: { ...((result as any)._meta ?? {}), dcExecution: { requestId: context.requestId, correlationId: context.correlationId } } };
  if (!decorated.isError || (context as any).errorRecorded) return decorated;
  const rejection = managedRejection(result);
  let body;
  if (rejection) {
    const record = recordLastErrorCode(context, rejection, 'Desktop Commander managed authorization rejected the call', {
      stage: 'validate', causeCategory: 'authorization', retryable: false, ruleId: 'acs.dc.v1',
    });
    body = { code: record.errorCode, requestId: record.requestId, correlationId: record.correlationId, stage: record.stage, message: record.message, retryable: false, causeCategory: 'authorization' };
  } else {
    const text = firstText(result).replace(/^Error:\s*/, '');
    const record = recordLastError(context, toDcError(new Error(text || 'tool returned an error')), 'execute');
    body = { code: record.errorCode, requestId: record.requestId, correlationId: record.correlationId, stage: record.stage, message: record.message, retryable: record.retryable, causeCategory: record.causeCategory };
  }
  (context as any).errorRecorded = true;
  context.evidence.errorCode = body.code;
  context.evidence.errorCategory = body.causeCategory;
  if (!hasStructuredError(result)) {
    decorated.content = [...(decorated.content ?? []), { type: 'text', text: JSON.stringify({ dcError: body }) }];
  }
  return decorated;
}

export function finalizeExecution(context: RequestContext, result: ServerResult | undefined, thrown: unknown): void {
  let outcome: ExecutionOutcome = 'success';
  if (thrown !== undefined) {
    outcome = 'error';
    if (!(context as any).errorRecorded) {
      const record = recordLastError(context, thrown, 'internal');
      context.evidence.errorCode = record.errorCode;
      context.evidence.errorCategory = record.causeCategory;
    }
  } else if (result && (result as any).isError) {
    outcome = managedRejection(result) ? 'refused' : 'error';
  }
  const e = context.evidence as Record<string, any>;
  try {
    executionEvents.emit({
      requestId: context.requestId,
      correlationId: context.correlationId,
      runtimeId: runtimeId(),
      tool: context.tool,
      operationClass: operationClass(context.tool),
      outcome,
      normalizedArgumentsHash: context.normalizedArgumentsHash,
      origin: context.origin,
      durationMs: Date.now() - context.startedAt,
      ...(typeof e.cwd === 'string' ? { cwd: e.cwd } : {}),
      ...(typeof e.repoHeadSha === 'string' ? { repoHeadSha: e.repoHeadSha } : {}),
      ...(e.preconditions ? { preconditions: e.preconditions } : {}),
      ...(e.results ? { results: e.results } : {}),
      ...('exitCode' in e ? { exitCode: e.exitCode } : {}),
      ...('signal' in e ? { signal: e.signal } : {}),
      ...(e.truncated ? { truncated: e.truncated } : {}),
      ...(e.errorCode ? { errorCode: e.errorCode, errorCategory: e.errorCategory } : {}),
      mechanical: { riskClass: toolMechanics(context.tool)?.riskClass ?? 'unknown', authorization: 'external' },
      ...(context.acs ? { acs: context.acs } : {}),
    });
  } catch {
    // Evidence emission never affects the tool result.
  }
}
