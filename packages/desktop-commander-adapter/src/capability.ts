import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { ControlStackError, strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import type { ExecutionAuthorization } from "./execution-authorization.js";
import { desktopCommanderToolPolicy } from "./tool-policy.js";

export const DESKTOP_COMMANDER_CAPABILITY_VERSION = "acs.dc.v1" as const;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const KEY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const CAPABILITY_SCOPES = new Set([
  "fs.read",
  "fs.write",
  "process.exec",
  "process.spawn",
  "network.read",
  "network.write"
]);

export interface DesktopCommanderCapabilityPayload {
  readonly version: typeof DESKTOP_COMMANDER_CAPABILITY_VERSION;
  readonly issuer: "acs";
  readonly audience: "desktop-commander";
  readonly runtimeId: string;
  readonly workItemId: string;
  readonly attemptId: string;
  readonly leaseId: string;
  readonly leaseEpoch: number;
  readonly toolName: string;
  readonly normalizedArguments: Readonly<Record<string, unknown>>;
  readonly invocationHash: string;
  readonly actionHash: string;
  readonly requestHash: string;
  readonly planHash: string;
  readonly scopes: readonly string[];
  readonly approvalId?: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
}

/**
 * The action hash the durable issuance gate binds: for approval-required
 * calls this is the approval-bound action fingerprint (the exact hash the
 * execution-plan approval was granted and consumed under), so recordIssuance
 * can re-derive the approval binding and fail closed on drift. Absent means
 * "use authorization.actionHash" (the claim's execution action hash).
 */
export interface ApprovalBoundAuthorization {
  readonly approvalId?: string;
  readonly approvalActionHash?: string;
}

export interface DesktopCommanderCapability {
  readonly payload: DesktopCommanderCapabilityPayload;
  readonly signature: string;
  readonly keyId: string;
}

export interface CapabilitySigningConfig {
  readonly runtimeId: string;
  readonly keyId: string;
  /** Base64url PKCS#8 DER. Kept only in ACS process memory. */
  readonly privateKey: string;
  readonly ttlMs?: number;
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

export function desktopCommanderRequiredScopes(toolName: string): string[] {
  const policy = desktopCommanderToolPolicy(toolName);
  if (!policy)
    throw new ControlStackError("desktop_commander_tool_not_allowlisted", "capability tool is not allowlisted");
  // This is a capability vocabulary mapping, not an inference from argument
  // shape: `start_process` creates a process and process inspection consumes
  // process authority even though their arguments have no filesystem path.
  const scopeByTool: Readonly<Record<string, string>> = {
    get_config: "fs.read",
    get_file_info: "fs.read",
    list_directory: "fs.read",
    read_file: "fs.read",
    read_multiple_files: "fs.read",
    create_directory: "fs.write",
    write_file: "fs.write",
    edit_block: "fs.write",
    move_file: "fs.write",
    start_process: "process.spawn",
    list_sessions: "process.exec",
    list_processes: "process.exec",
    read_process_output: "process.exec",
    get_usage_stats: "process.exec",
    get_runtime_identity: "process.exec",
    start_search: "fs.read",
    get_more_search_results: "fs.read",
    list_searches: "fs.read",
    health: "process.exec",
    last_error: "process.exec",
    capability_manifest: "process.exec",
    operation_preview: "fs.read",
    git_state: "fs.read",
    verify_head: "fs.read",
    secret_scan: "fs.read",
    wait_for_process: "process.exec",
    run_command: "process.spawn",
    terminate_process: "process.exec",
    apply_patch: "fs.write",
    snapshot_path: "fs.write",
    restore_snapshot: "fs.write"
  };
  const scope = scopeByTool[policy.name];
  if (!scope) throw new ControlStackError("desktop_commander_capability_invalid", "tool has no v1 scope mapping");
  return [scope];
}

function requireId(label: string, value: string, pattern = ID_PATTERN): void {
  if (!pattern.test(value)) throw new ControlStackError("desktop_commander_capability_invalid", `${label} is invalid`);
}

function requireHash(label: string, value: string): void {
  if (!HASH_PATTERN.test(value))
    throw new ControlStackError("desktop_commander_capability_invalid", `${label} is invalid`);
}

/** Creates a v1 envelope using the exact strict canonical signing bytes. */
export function prepareDesktopCommanderCapability(
  authorization: ExecutionAuthorization,
  requestHash: string,
  config: CapabilitySigningConfig,
  now = new Date()
): DesktopCommanderCapabilityPayload {
  requireId("runtimeId", config.runtimeId);
  requireId("keyId", config.keyId, KEY_ID_PATTERN);
  requireHash("requestHash", requestHash);
  // Stay one second inside the protocol ceiling. SQLite's julianday() check on
  // the durable issuance row can round an exact 30-second boundary slightly
  // upward, so using the inclusive maximum would make otherwise valid live
  // capabilities nondeterministically fail closed at persistence time.
  const ttlMs = config.ttlMs ?? 29_000;
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > 30_000) {
    throw new ControlStackError("desktop_commander_capability_invalid", "capability TTL must be between 1 and 30000ms");
  }
  const policy = desktopCommanderToolPolicy(authorization.toolName);
  if (!policy)
    throw new ControlStackError("desktop_commander_tool_not_allowlisted", "capability tool is not allowlisted");
  if (policy.requiresApproval !== authorization.requiresApproval) {
    throw new ControlStackError("desktop_commander_capability_invalid", "capability approval policy drift");
  }
  if (policy.requiresApproval && !authorization.approvalId) {
    throw new ControlStackError("desktop_commander_approval_missing", "required approval is absent from authorization");
  }
  if (!policy.requiresApproval && authorization.approvalId !== undefined) {
    throw new ControlStackError("desktop_commander_capability_invalid", "unexpected approval for non-approval tool");
  }
  // The payload binds the action hash exactly as the durable issuance gate
  // will re-derive it: for approval-required calls the approval-bound action
  // fingerprint (execution_plan_approvals.action_hash), otherwise the claim's
  // execution action hash. recordIssuance recomputes the request hash from
  // this value and fails closed on any drift from the granted approval.
  const payloadActionHash =
    authorization.approvalId !== undefined && authorization.approvalActionHash !== undefined
      ? authorization.approvalActionHash
      : authorization.actionHash;
  requireHash("actionHash", payloadActionHash);
  const issuedAt = new Date(Math.floor(now.getTime() / 1_000) * 1_000).toISOString();
  const expiresAt = new Date(Date.parse(issuedAt) + ttlMs).toISOString();
  const payload: DesktopCommanderCapabilityPayload = {
    version: DESKTOP_COMMANDER_CAPABILITY_VERSION,
    issuer: "acs",
    audience: "desktop-commander",
    runtimeId: config.runtimeId,
    workItemId: authorization.workItemId,
    attemptId: authorization.attemptId,
    leaseId: authorization.leaseId,
    leaseEpoch: authorization.fencingEpoch,
    toolName: authorization.toolName,
    normalizedArguments: authorization.normalizedArguments,
    invocationHash: authorization.invocationFingerprint,
    actionHash: payloadActionHash,
    requestHash,
    planHash: authorization.planHash,
    scopes: desktopCommanderRequiredScopes(authorization.toolName),
    ...(authorization.approvalId ? { approvalId: authorization.approvalId } : {}),
    issuedAt,
    expiresAt,
    nonce: base64url(randomBytes(32))
  };
  for (const scope of payload.scopes) {
    if (!CAPABILITY_SCOPES.has(scope))
      throw new ControlStackError("desktop_commander_capability_invalid", "invalid scope");
  }
  return Object.freeze(payload);
}

function capabilityPrivateKey(config: Pick<CapabilitySigningConfig, "keyId" | "privateKey">) {
  requireId("keyId", config.keyId, KEY_ID_PATTERN);
  try {
    const privateKey = createPrivateKey({
      key: Buffer.from(config.privateKey, "base64url"),
      format: "der",
      type: "pkcs8"
    });
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error("not ed25519");
    }
    return privateKey;
  } catch {
    throw new ControlStackError(
      "desktop_commander_capability_invalid",
      "capability signing key is not a valid Ed25519 PKCS#8 key"
    );
  }
}

/** Validate signing material before any authoritative lifecycle mutation. */
export function validateCapabilitySigningConfig(config: Pick<CapabilitySigningConfig, "keyId" | "privateKey">): void {
  void capabilityPrivateKey(config);
}

/** Signs a payload only after the caller's durable issuance boundary commits. */
export function signPreparedDesktopCommanderCapability(
  payload: DesktopCommanderCapabilityPayload,
  config: Pick<CapabilitySigningConfig, "keyId" | "privateKey">
): DesktopCommanderCapability {
  const privateKey = capabilityPrivateKey(config);
  const signature = sign(null, Buffer.from(strictCanonicalJsonV1(payload), "utf8"), privateKey);
  return Object.freeze({ payload, signature: base64url(signature), keyId: config.keyId });
}

/** Store only this value for audit/provenance; raw nonces must never be persisted. */
export function desktopCommanderCapabilityNonceHash(nonce: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(nonce))
    throw new ControlStackError("desktop_commander_capability_invalid", "nonce is invalid");
  return createHash("sha256").update(Buffer.from(nonce, "base64url")).digest("hex");
}
