import { FIXED_ACS_SCOPES, type AcsScope } from '../managed-acs.js';

/**
 * Narrow, validated configuration for the OpenClaw ACS bridge.
 *
 * The bridge is an unprivileged MCP-facing adapter: it never holds an ACS
 * signing private key and never decides approvals. It only needs enough
 * configuration to (a) start the managed Desktop Commander child with the
 * public verification material it already supports, and (b) know where to
 * ask a separately configured issuer for a signed capability per tool call.
 */
export interface OpenClawBridgeConfig {
  issuerUrl: URL;
  issuerTimeoutMs: number;
  issuerToken?: string;
  workItemId: string;
  attemptId: string;
  childPublicKey: string;
  childKeyId: string;
  childScopes?: readonly AcsScope[];
}

export class OpenClawBridgeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenClawBridgeConfigError';
  }
}

const KEY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const DEFAULT_ISSUER_TIMEOUT_MS = 8_000;
const MIN_ISSUER_TIMEOUT_MS = 100;
const MAX_ISSUER_TIMEOUT_MS = 60_000;

function requireNonEmpty(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new OpenClawBridgeConfigError(`${name} must be set to a non-empty value`);
  }
  return value;
}

function parseIssuerUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OpenClawBridgeConfigError('OPENCLAW_ACS_ISSUER_URL must be an absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OpenClawBridgeConfigError('OPENCLAW_ACS_ISSUER_URL must use the http or https scheme');
  }
  return url;
}

function parseIssuerTimeout(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_ISSUER_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_ISSUER_TIMEOUT_MS || value > MAX_ISSUER_TIMEOUT_MS) {
    throw new OpenClawBridgeConfigError(
      `OPENCLAW_ACS_ISSUER_TIMEOUT_MS must be an integer between ${MIN_ISSUER_TIMEOUT_MS} and ${MAX_ISSUER_TIMEOUT_MS}`,
    );
  }
  return value;
}

function parseChildKeyId(raw: string): string {
  if (!KEY_ID_PATTERN.test(raw)) {
    throw new OpenClawBridgeConfigError('DESKTOP_COMMANDER_ACS_KEY_ID must match /^[A-Za-z0-9._:-]{1,64}$/');
  }
  return raw;
}

function parseChildPublicKey(raw: string): string {
  if (!BASE64URL_PATTERN.test(raw)) {
    throw new OpenClawBridgeConfigError('DESKTOP_COMMANDER_ACS_PUBLIC_KEY must be base64url-encoded');
  }
  return raw;
}

function parseChildScopes(raw: string | undefined): readonly AcsScope[] | undefined {
  if (raw === undefined || raw === '') return undefined;
  const scopes = raw.split(',');
  const isSortedUniqueSubset = scopes.length > 0
    && scopes.every((scope) => FIXED_ACS_SCOPES.includes(scope as AcsScope))
    && scopes.every((scope, index) => index === 0 || scopes[index - 1] < scope);
  if (!isSortedUniqueSubset) {
    throw new OpenClawBridgeConfigError(
      'DESKTOP_COMMANDER_ACS_SCOPES must be a sorted, unique, comma-separated subset of the ACS v1 scope vocabulary',
    );
  }
  return scopes as AcsScope[];
}

/**
 * Loads and validates the bridge's environment configuration. Fails closed
 * (throws) rather than substituting a default for anything security-relevant:
 * there is no safe default issuer endpoint, and a missing child key means the
 * managed child could never authorize a single tool call anyway.
 */
export function loadOpenClawBridgeConfig(env: NodeJS.ProcessEnv = process.env): OpenClawBridgeConfig {
  const issuerUrl = parseIssuerUrl(requireNonEmpty(env, 'OPENCLAW_ACS_ISSUER_URL'));
  const issuerTimeoutMs = parseIssuerTimeout(env.OPENCLAW_ACS_ISSUER_TIMEOUT_MS);
  const issuerToken = env.OPENCLAW_ACS_ISSUER_TOKEN?.trim() || undefined;
  const workItemId = requireNonEmpty(env, 'OPENCLAW_ACS_WORK_ITEM_ID');
  const attemptId = requireNonEmpty(env, 'OPENCLAW_ACS_ATTEMPT_ID');
  const childPublicKey = parseChildPublicKey(requireNonEmpty(env, 'DESKTOP_COMMANDER_ACS_PUBLIC_KEY'));
  const childKeyId = parseChildKeyId(requireNonEmpty(env, 'DESKTOP_COMMANDER_ACS_KEY_ID'));
  const childScopes = parseChildScopes(env.DESKTOP_COMMANDER_ACS_SCOPES);

  return {
    issuerUrl,
    issuerTimeoutMs,
    ...(issuerToken ? { issuerToken } : {}),
    workItemId,
    attemptId,
    childPublicKey,
    childKeyId,
    ...(childScopes ? { childScopes } : {}),
  };
}
