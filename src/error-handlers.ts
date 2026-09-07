import crypto from 'crypto';
import { ServerResult } from './types.js';
import {capture} from "./utils/capture.js";

/**
 * Coarse, stable classification of why a tool call failed. Lets a caller
 * (or a future control-plane UI) branch on the shape of the failure without
 * parsing the human-readable message text, which is free to change wording.
 */
export type ErrorCauseCategory =
  | 'validation'   // bad/missing arguments
  | 'not_found'    // referenced path/pid/session/resource does not exist
  | 'permission'   // denied by path policy, ACS authorization, or the OS
  | 'timeout'      // operation did not complete in time
  | 'conflict'     // e.g. concurrent modification, already-in-progress
  | 'internal'     // unexpected server-side failure
  | 'unknown';     // not yet classified at the call site

export interface StructuredErrorOptions {
  /**
   * Machine-readable, stable error code (e.g. 'PATH_NOT_ALLOWED'). Defaults
   * to the upper-cased causeCategory when omitted, so every error always
   * carries *some* stable code even before call sites are migrated to a
   * more specific one.
   */
  code?: string;
  /** See ErrorCauseCategory. Defaults to 'unknown' for unmigrated call sites. */
  causeCategory?: ErrorCauseCategory;
  /** Whether retrying the identical call might succeed. Defaults to false. */
  retryable?: boolean;
}

export interface StructuredErrorInfo {
  code: string;
  causeCategory: ErrorCauseCategory;
  retryable: boolean;
  /** Unique per error response, for correlating this failure across logs/telemetry. */
  correlationId: string;
}

/**
 * Creates a standard error response for tools.
 *
 * The human-readable `content[0].text` shape (`Error: <message>`) is
 * unchanged from before — every existing call site and consumer keeps
 * working exactly as it did. Structured fields are added under `_meta`,
 * which MCP clients already tolerate as free-form and ignore when unused,
 * so this is purely additive.
 *
 * @param message The (human-safe) error message
 * @param options Optional structured fields — see StructuredErrorOptions
 * @returns A ServerResult with the error message and structured error metadata
 */
export function createErrorResponse(message: string, options: StructuredErrorOptions = {}): ServerResult {
  const causeCategory = options.causeCategory ?? 'unknown';
  const code = options.code ?? causeCategory.toUpperCase();
  const retryable = options.retryable ?? false;
  const correlationId = crypto.randomUUID();

  capture('server_request_error', {
    error: message,
    errorCode: code,
    causeCategory,
  });

  const errorInfo: StructuredErrorInfo = { code, causeCategory, retryable, correlationId };

  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
    _meta: { errorInfo },
  };
}
