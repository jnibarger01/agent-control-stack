import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import { ControlStackError, strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import {
  executionActionHash,
  executionPlanApprovalRequestHash,
  type AttemptLease,
  type ClaimedWorkItem,
  type WorkItem
} from "@agent-control-stack/work-items";
import {
  JM_AUDIENCE,
  JM_CAPABILITY_VERSION,
  JM_INVOCATION_DOMAIN,
  JM_TOOL_ARGUMENT_SCHEMAS,
  jmToolContract,
  type JmToolContract,
  type JmToolName
} from "./manifest.js";

/**
 * acs.jm.v1 — ACS-issued, per-call capabilities for the Jace-Mem MCP server.
 *
 * Same envelope, strict canonicalization, Ed25519 signature, <=30 s lifetime and
 * single-use nonce rules as acs.dc.v1 / acs.jc.v1, with a separate version,
 * audience, scope vocabulary, invocation domain and signing key so no other
 * contract's capability verifies here, plus one extra signed field: `subject`,
 * the exact Jace-Mem identity the call acts as. Jace-Mem accepts a capability
 * only when `subject` equals its launch identity, which is what stops one agent
 * from acting as another.
 *
 * Subject rule (this slice): `subject.agent` must equal the work item's attested
 * `requesterSubject`, and the subject is bound into the work item's action
 * parameters (so into the action hash). Runtime registration and the immutable
 * launcher subject arrive with JM-ACS-02.
 */

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const KEY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u;
const HASH = /^[a-f0-9]{64}$/u;

export interface JaceMemSubject {
  readonly principal: string;
  readonly agent: string;
  readonly project: string;
  readonly worktree: string;
  readonly invocation: string;
}

const SUBJECT_KEYS = ["agent", "invocation", "principal", "project", "worktree"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Jace-Mem's identity rules (jace-mem src/store.ts assertIdentity), applied before ACS signs a subject. */
export function validateJaceMemSubject(value: unknown): JaceMemSubject {
  if (!isPlainObject(value)) throw new ControlStackError("jace_mem_subject_invalid", "subject must be an object");
  const keys = Object.keys(value).sort();
  if (keys.length !== SUBJECT_KEYS.length || keys.some((key, index) => key !== SUBJECT_KEYS[index])) {
    throw new ControlStackError(
      "jace_mem_subject_invalid",
      "subject must have exactly principal, agent, project, worktree and invocation"
    );
  }
  for (const key of SUBJECT_KEYS) {
    const field = value[key];
    if (
      typeof field !== "string" ||
      field.length === 0 ||
      field !== field.trim() ||
      /[\p{Cc}\p{Cf}]/u.test(field) ||
      Buffer.byteLength(field, "utf8") > (key === "worktree" ? 4096 : 256)
    ) {
      throw new ControlStackError("jace_mem_subject_invalid", `subject.${key} is invalid`);
    }
  }
  return Object.freeze({
    principal: value.principal as string,
    agent: value.agent as string,
    project: value.project as string,
    worktree: value.worktree as string,
    invocation: value.invocation as string
  });
}

/** Hash ACS binds into the work item and issuance record (never the raw subject in audit rows). */
export function jaceMemSubjectHash(subject: JaceMemSubject): string {
  return createHash("sha256")
    .update(`acs:jace-mem-subject:v1\n${strictCanonicalJsonV1(subject)}`, "utf8")
    .digest("hex");
}

export interface JaceMemInvocation {
  readonly toolName: JmToolName;
  /** The exact delivered arguments (validated, never rewritten). */
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly invocationHash: string;
  readonly policy: JmToolContract;
}

/** sha256("acs:jace-mem-invocation:v1\n" + strictCanonicalJsonV1({toolName, arguments})), as Jace-Mem recomputes it. */
export function jaceMemInvocationHash(toolName: string, args: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`${JM_INVOCATION_DOMAIN}\n${strictCanonicalJsonV1({ toolName, arguments: args })}`, "utf8")
    .digest("hex");
}

/**
 * Validates the exact arguments the MCP client will deliver. No defaults,
 * coercion or rewriting: Jace-Mem compares the signed `normalizedArguments`
 * against what it receives, so any rewrite fails closed there.
 */
export function validateJaceMemInvocation(toolName: string, rawArguments: unknown): JaceMemInvocation {
  const policy = jmToolContract(toolName);
  if (!policy) throw new ControlStackError("jace_mem_tool_not_allowlisted", `unknown Jace-Mem tool: ${toolName}`);
  if (!isPlainObject(rawArguments)) {
    throw new ControlStackError("jace_mem_argument_invalid", "tool arguments must be a plain object");
  }
  if (Object.values(rawArguments).some((value) => value === undefined)) {
    throw new ControlStackError("jace_mem_argument_invalid", "tool arguments must not contain undefined values");
  }
  const parsed = JM_TOOL_ARGUMENT_SCHEMAS[policy.name].safeParse(rawArguments);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ControlStackError(
      "jace_mem_argument_invalid",
      `${toolName}: ${issue ? `${issue.path.join(".") || "(root)"} ${issue.message}` : "invalid arguments"}`
    );
  }
  let canonical: Record<string, unknown>;
  try {
    canonical = JSON.parse(strictCanonicalJsonV1(rawArguments)) as Record<string, unknown>;
  } catch {
    throw new ControlStackError("jace_mem_argument_invalid", "tool arguments are not strict JSON");
  }
  return Object.freeze({
    toolName: policy.name,
    arguments: Object.freeze(canonical),
    invocationHash: jaceMemInvocationHash(policy.name, canonical),
    policy
  });
}

/** Parameters of the single requested action a Jace-Mem work item carries (and the action hash covers). */
export function jaceMemActionParams(invocation: JaceMemInvocation, subject: JaceMemSubject, runtimeId: string) {
  return {
    tool: invocation.toolName,
    contract: JM_CAPABILITY_VERSION,
    invocationHash: invocation.invocationHash,
    runtimeId,
    requiredScopes: [...invocation.policy.scopes],
    requesterSubject: subject.agent,
    subject: { ...subject },
    subjectHash: jaceMemSubjectHash(subject),
    write: invocation.policy.actionKind !== "jm.memory.read",
    network: false
  };
}

// --- execution authorization ---------------------------------------------------

const AUTHORIZATION_BRAND: unique symbol = Symbol("JaceMemExecutionAuthorization");

export interface JaceMemExecutionAuthorization {
  readonly [AUTHORIZATION_BRAND]: true;
  readonly workItemId: string;
  readonly attemptId: string;
  readonly leaseId: string;
  readonly workerId: string;
  readonly planHash: string;
  readonly fencingEpoch: number;
  readonly actionHash: string;
  readonly invocation: JaceMemInvocation;
  readonly subject: JaceMemSubject;
  readonly requesterSubject: string;
  readonly approvalId?: string;
  readonly approvalActionHash?: string;
}

export interface AuthorizeJaceMemInput {
  readonly claimed: ClaimedWorkItem;
  readonly trustedWorkItem: WorkItem;
  readonly lease: AttemptLease;
  readonly workerId: string;
  readonly invocation: JaceMemInvocation;
  readonly subject: JaceMemSubject;
  /** For approval-gated tools: the action hash of the consumed approval bound to the lease. */
  readonly approvalActionHash?: string;
  readonly now?: Date;
}

/**
 * Re-derives everything a capability will claim from ACS's own trusted state:
 * running work item, active unexpired lease held by this worker at the claimed
 * fencing epoch, unchanged action hash, the exact invocation and subject bound
 * in the work item, subject.agent equal to the attested requester, and an
 * approval present exactly when the tool requires one.
 */
export function authorizeJaceMemExecution(input: AuthorizeJaceMemInput): JaceMemExecutionAuthorization {
  const now = input.now ?? new Date();
  const { claimed, trustedWorkItem, lease, workerId, invocation } = input;
  const fail = (code: string, message: string): never => {
    throw new ControlStackError(code, message);
  };
  const subject = validateJaceMemSubject(input.subject);
  if (trustedWorkItem.status !== "running") fail("jace_mem_work_item_not_executable", "work item is not running");
  if (claimed.id !== trustedWorkItem.id) fail("jace_mem_work_item_mismatch", "claimed work item mismatch");
  if (claimed.workerId !== workerId || lease.workerId !== workerId) {
    fail("jace_mem_lease_worker_mismatch", "lease is not held by this worker");
  }
  if (lease.workItemId !== trustedWorkItem.id) fail("jace_mem_lease_work_item_mismatch", "lease work item mismatch");
  if (claimed.attemptId === undefined || lease.attemptId !== claimed.attemptId) {
    fail("jace_mem_lease_attempt_mismatch", "lease attempt mismatch");
  }
  if (lease.status !== "active") fail("jace_mem_lease_inactive", `attempt lease is ${lease.status}`);
  const leaseExpiry = Date.parse(lease.expiresAt);
  if (!Number.isFinite(leaseExpiry) || leaseExpiry <= now.getTime()) fail("jace_mem_lease_expired", "lease expired");
  if (claimed.fencingEpoch === undefined || lease.fencingEpoch !== claimed.fencingEpoch) {
    fail("jace_mem_lease_fencing_mismatch", "lease fencing epoch mismatch");
  }
  if (claimed.planHash === undefined || lease.planHash !== claimed.planHash) {
    fail("jace_mem_plan_hash_mismatch", "lease plan hash mismatch");
  }
  const recomputedActionHash = executionActionHash(trustedWorkItem);
  if (recomputedActionHash !== claimed.actionHash) {
    fail("jace_mem_action_hash_changed", "work item action hash changed since claim");
  }
  const actions = trustedWorkItem.requestedActions ?? [];
  const params = (actions[0]?.params ?? {}) as Record<string, unknown>;
  if (
    actions.length !== 1 ||
    actions[0]?.kind !== invocation.policy.actionKind ||
    params.contract !== JM_CAPABILITY_VERSION ||
    params.tool !== invocation.toolName ||
    params.invocationHash !== invocation.invocationHash
  ) {
    fail("jace_mem_invocation_binding_mismatch", "invocation does not match the trusted work-item binding");
  }
  const requester = trustedWorkItem.requesterSubject;
  if (typeof requester !== "string" || requester.length === 0) {
    fail("jace_mem_requester_unknown", "work item has no attested requester");
  }
  if (params.subjectHash !== jaceMemSubjectHash(subject)) {
    fail("jace_mem_subject_binding_mismatch", "subject does not match the trusted work-item binding");
  }
  // The anti-impersonation rule: ACS signs a subject only for the agent it attested as the requester.
  if (subject.agent !== requester)
    fail("jace_mem_subject_agent_mismatch", "subject.agent is not the attested requester");
  if (invocation.toolName === "memory_search_shared" && invocation.arguments.targetAgent === subject.agent) {
    fail("jace_mem_share_target_invalid", "memory_search_shared must target a different agent");
  }
  if (invocation.policy.requiresApproval) {
    if (lease.approvalId === undefined)
      fail("jace_mem_approval_missing", `${invocation.toolName} requires a lease-bound approval`);
    if (input.approvalActionHash === undefined || !HASH.test(input.approvalActionHash)) {
      fail("jace_mem_approval_missing", `${invocation.toolName} requires the approved action hash`);
    }
  } else if (lease.approvalId !== undefined || input.approvalActionHash !== undefined) {
    fail("jace_mem_approval_unexpected", `${invocation.toolName} must not carry an approval`);
  }
  return Object.freeze({
    [AUTHORIZATION_BRAND]: true as const,
    workItemId: trustedWorkItem.id,
    attemptId: claimed.attemptId!,
    leaseId: claimed.leaseId,
    workerId,
    planHash: claimed.planHash!,
    fencingEpoch: claimed.fencingEpoch!,
    actionHash: recomputedActionHash,
    invocation,
    subject,
    requesterSubject: requester!,
    ...(lease.approvalId !== undefined
      ? { approvalId: lease.approvalId, approvalActionHash: input.approvalActionHash }
      : {})
  });
}

export function isJaceMemExecutionAuthorization(value: unknown): value is JaceMemExecutionAuthorization {
  return isPlainObject(value) && (value as Record<symbol, unknown>)[AUTHORIZATION_BRAND] === true;
}

// --- payload + signing ---------------------------------------------------------

export interface JaceMemCapabilityPayload {
  readonly version: typeof JM_CAPABILITY_VERSION;
  readonly issuer: "acs";
  readonly audience: typeof JM_AUDIENCE;
  readonly runtimeId: string;
  readonly workItemId: string;
  readonly attemptId: string;
  readonly leaseId: string;
  readonly leaseEpoch: number;
  readonly subject: JaceMemSubject;
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

export interface JaceMemCapability {
  readonly payload: JaceMemCapabilityPayload;
  readonly signature: string;
  readonly keyId: string;
}

export interface JaceMemSigningConfig {
  /** base64url PKCS#8 DER Ed25519 private key. Dedicated to acs.jm.v1. */
  readonly privateKey: string;
  readonly keyId: string;
  readonly runtimeId: string;
  /** Capability lifetime in ms, 1..30000 (default 29000). */
  readonly ttlMs?: number;
}

function signingKey(config: Pick<JaceMemSigningConfig, "keyId" | "privateKey">) {
  if (!KEY_ID_PATTERN.test(config.keyId))
    throw new ControlStackError("jace_mem_capability_invalid", "keyId is invalid");
  try {
    const key = createPrivateKey({ key: Buffer.from(config.privateKey, "base64url"), format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("not ed25519");
    return key;
  } catch {
    throw new ControlStackError("jace_mem_capability_invalid", "signing key is not a valid Ed25519 PKCS#8 key");
  }
}

export function validateJaceMemSigningConfig(config: JaceMemSigningConfig): void {
  signingKey(config);
  if (!ID_PATTERN.test(config.runtimeId))
    throw new ControlStackError("jace_mem_capability_invalid", "runtimeId is invalid");
  if (config.ttlMs !== undefined && (!Number.isInteger(config.ttlMs) || config.ttlMs <= 0 || config.ttlMs > 30_000)) {
    throw new ControlStackError("jace_mem_capability_invalid", "capability TTL must be between 1 and 30000ms");
  }
}

/** base64url SPKI DER public key for JACE_MEM_ACS_PUBLIC_KEY on the Jace-Mem side. */
export function jaceMemVerificationKey(config: Pick<JaceMemSigningConfig, "keyId" | "privateKey">): string {
  return createPublicKey(signingKey(config)).export({ format: "der", type: "spki" }).toString("base64url");
}

export function prepareJaceMemCapability(
  authorization: JaceMemExecutionAuthorization,
  config: JaceMemSigningConfig,
  now = new Date()
): JaceMemCapabilityPayload {
  if (!isJaceMemExecutionAuthorization(authorization)) {
    throw new ControlStackError("jace_mem_capability_invalid", "an ACS execution authorization is required");
  }
  validateJaceMemSigningConfig(config);
  const ttlMs = config.ttlMs ?? 29_000;
  const { invocation } = authorization;
  if (invocation.policy.requiresApproval !== (authorization.approvalId !== undefined)) {
    throw new ControlStackError("jace_mem_capability_invalid", "approval presence does not match tool policy");
  }
  const actionHash = authorization.approvalActionHash ?? authorization.actionHash;
  const requestHash = executionPlanApprovalRequestHash({
    workItemId: authorization.workItemId,
    planHash: authorization.planHash,
    actionHash
  });
  // Millisecond precision is what Jace-Mem's TIME pattern requires; whole seconds keep it deterministic.
  const issuedAt = new Date(Math.floor(now.getTime() / 1_000) * 1_000).toISOString();
  return Object.freeze({
    version: JM_CAPABILITY_VERSION,
    issuer: "acs",
    audience: JM_AUDIENCE,
    runtimeId: config.runtimeId,
    workItemId: authorization.workItemId,
    attemptId: authorization.attemptId,
    leaseId: authorization.leaseId,
    leaseEpoch: authorization.fencingEpoch,
    subject: { ...authorization.subject },
    toolName: invocation.toolName,
    normalizedArguments: invocation.arguments,
    invocationHash: invocation.invocationHash,
    actionHash,
    requestHash,
    planHash: authorization.planHash,
    scopes: [...invocation.policy.scopes].sort(),
    ...(authorization.approvalId !== undefined ? { approvalId: authorization.approvalId } : {}),
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + ttlMs).toISOString(),
    nonce: randomBytes(32).toString("base64url")
  });
}

/** Raw Ed25519 over UTF-8(strictCanonicalJsonV1(payload)), unpadded base64url. Call only after the issuance commits. */
export function signPreparedJaceMemCapability(
  payload: JaceMemCapabilityPayload,
  config: Pick<JaceMemSigningConfig, "keyId" | "privateKey">
): JaceMemCapability {
  const signature = sign(null, Buffer.from(strictCanonicalJsonV1(payload), "utf8"), signingKey(config)).toString(
    "base64url"
  );
  return Object.freeze({ payload, signature, keyId: config.keyId });
}

export function jaceMemCapabilityId(payload: JaceMemCapabilityPayload): string {
  return `${JM_CAPABILITY_VERSION}:${createHash("sha256").update(strictCanonicalJsonV1(payload), "utf8").digest("hex").slice(0, 32)}`;
}

/** sha256 of the raw nonce bytes — the same value Jace-Mem reserves in its replay store. */
export function jaceMemNonceHash(nonce: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(nonce))
    throw new ControlStackError("jace_mem_capability_invalid", "nonce is invalid");
  return createHash("sha256").update(Buffer.from(nonce, "base64url")).digest("hex");
}

/** Reads acs.jm.v1 signing config; absent config disables issuance (fail closed), partial config is an error. */
export function jaceMemSigningConfigFromEnv(env: NodeJS.ProcessEnv = process.env): JaceMemSigningConfig | undefined {
  const privateKey = env.ACS_JACE_MEM_CAPABILITY_PRIVATE_KEY;
  const keyId = env.ACS_JACE_MEM_CAPABILITY_KEY_ID;
  const runtimeId = env.ACS_JACE_MEM_RUNTIME_ID;
  if (!privateKey && !keyId && !runtimeId) return undefined;
  if (!privateKey || !keyId || !runtimeId) {
    throw new ControlStackError(
      "jace_mem_capability_config_incomplete",
      "ACS_JACE_MEM_CAPABILITY_PRIVATE_KEY, ACS_JACE_MEM_CAPABILITY_KEY_ID and ACS_JACE_MEM_RUNTIME_ID must be set together"
    );
  }
  // A dedicated key: reusing the acs.dc.v1 or acs.jc.v1 signing key would let one audience's key material
  // stand in for another's if a verifier were ever misconfigured.
  for (const other of [
    env.ACS_JACE_COMMANDER_CAPABILITY_PRIVATE_KEY,
    env.ACS_DESKTOP_COMMANDER_CAPABILITY_PRIVATE_KEY?.trim()
  ]) {
    if (other && other === privateKey) {
      throw new ControlStackError("jace_mem_capability_key_shared", "acs.jm.v1 requires its own signing key");
    }
  }
  const config = { privateKey, keyId, runtimeId };
  validateJaceMemSigningConfig(config);
  return config;
}
