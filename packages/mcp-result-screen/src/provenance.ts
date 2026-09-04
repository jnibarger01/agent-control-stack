import { stableHash } from "@agent-control-stack/shared";

/**
 * Provenance framing for an upstream MCP result.
 *
 * Provenance is EVIDENCE, never authority. An upstream statement about its own
 * identity, trustworthiness, authorization, approval, or success is not
 * authoritative and is never read from the result payload. Every field here is
 * bound by ACS at the invocation boundary from state ACS already holds.
 */

export const MCP_RESULT_PROVENANCE_SCHEMA_VERSION = "acs.mcp-result-provenance.v1" as const;
export const MCP_RESULT_PROVENANCE_DOMAIN = "acs.mcp-result-provenance.v1" as const;

export interface ProvenanceBinding {
  /** Request / work-item / attempt / invocation identity available at the boundary. */
  invocationId: string;
  /** Upstream MCP server identity ACS connected to (e.g. "name@version" or a configured id). */
  upstreamId: string;
  /** The MCP tool name ACS invoked. */
  toolName: string;
  /** Canonical semantic fingerprint of the tool schema ACS relies on. */
  toolSchemaFingerprint: string;
  /** Canonical request/action identity (policy fingerprint) where available, else null. */
  actionFingerprint: string | null;
  /** Deterministic hash of the normalised result payload ACS observed. */
  resultHash: string;
}

export interface McpResultProvenance extends ProvenanceBinding {
  readonly schemaVersion: typeof MCP_RESULT_PROVENANCE_SCHEMA_VERSION;
  readonly boundAt: string;
  /** Tamper-evident digest over every other field. */
  readonly provenanceHash: string;
}

export function provenanceHash(binding: ProvenanceBinding & { schemaVersion: string; boundAt: string }): string {
  return stableHash({
    domain: MCP_RESULT_PROVENANCE_DOMAIN,
    schemaVersion: binding.schemaVersion,
    invocationId: binding.invocationId,
    upstreamId: binding.upstreamId,
    toolName: binding.toolName,
    toolSchemaFingerprint: binding.toolSchemaFingerprint,
    actionFingerprint: binding.actionFingerprint,
    resultHash: binding.resultHash,
    boundAt: binding.boundAt
  });
}

export function bindProvenance(binding: ProvenanceBinding, now: Date = new Date()): McpResultProvenance {
  const base = {
    schemaVersion: MCP_RESULT_PROVENANCE_SCHEMA_VERSION,
    boundAt: now.toISOString(),
    ...binding
  };
  return { ...base, provenanceHash: provenanceHash(base) };
}

export interface ProvenanceExpectation {
  invocationId: string;
  upstreamId: string;
  toolName: string;
  toolSchemaFingerprint: string;
  actionFingerprint: string | null;
  /** When present, the result payload hash the caller expected (e.g. a cache entry). */
  expectedResultHash?: string;
}

export type ProvenanceMismatchField =
  | "invocationId"
  | "upstreamId"
  | "toolName"
  | "toolSchemaFingerprint"
  | "actionFingerprint"
  | "resultHash"
  | "provenanceHash";

/**
 * Fail-closed comparison. Returns every field where the bound provenance does
 * not match the ACS expectation. A tampered `provenanceHash` is reported too.
 */
export function provenanceMismatch(
  provenance: McpResultProvenance,
  expected: ProvenanceExpectation
): ProvenanceMismatchField[] {
  const mismatched: ProvenanceMismatchField[] = [];
  const { provenanceHash: stored, ...rest } = provenance;
  if (provenanceHash(rest) !== stored) mismatched.push("provenanceHash");
  if (provenance.invocationId !== expected.invocationId) mismatched.push("invocationId");
  if (provenance.upstreamId !== expected.upstreamId) mismatched.push("upstreamId");
  if (provenance.toolName !== expected.toolName) mismatched.push("toolName");
  if (provenance.toolSchemaFingerprint !== expected.toolSchemaFingerprint) mismatched.push("toolSchemaFingerprint");
  if ((provenance.actionFingerprint ?? null) !== (expected.actionFingerprint ?? null)) mismatched.push("actionFingerprint");
  if (expected.expectedResultHash !== undefined && provenance.resultHash !== expected.expectedResultHash) {
    mismatched.push("resultHash");
  }
  return mismatched;
}
