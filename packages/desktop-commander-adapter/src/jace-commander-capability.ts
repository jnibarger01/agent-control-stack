import { createHash, createHmac, createPrivateKey, randomBytes, sign } from "node:crypto";
import { posix } from "node:path";
import { ControlStackError, strictCanonicalJsonV1 } from "@agent-control-stack/shared";

/**
 * acs.jc.v1 — ACS-issued capability for the Jace Commander MCP server.
 *
 * Same envelope, strict canonical signing bytes, Ed25519 signature, TTL and
 * nonce rules as acs.dc.v1 (docs/protocol/acs-jc-v1-capability-contract.md),
 * but a separate version/audience, scope vocabulary and invocation-hash
 * domain. The verifier lives in desktop-commander `src/jace-commander/contract.ts`;
 * the tool table below must stay byte-identical to its JC_TOOL_POLICIES.
 */
export const JACE_COMMANDER_CAPABILITY_VERSION = "acs.jc.v1" as const;
export const JACE_COMMANDER_AUDIENCE = "jace-commander" as const;
export const JACE_COMMANDER_INVOCATION_DOMAIN = "acs:jace-commander-invocation:v1";
export const JACE_COMMANDER_SCOPES = Object.freeze([
  "fs.read",
  "integration.read",
  "integration.write",
  "process.privileged"
] as const);
export type JaceCommanderScope = (typeof JACE_COMMANDER_SCOPES)[number];

/** Policy action kinds the issuer creates; never offered to the composer. */
export const JACE_COMMANDER_ACTION_KINDS = Object.freeze(["jc.read", "jc.write", "jc.privileged_exec"] as const);
export type JaceCommanderActionKind = (typeof JACE_COMMANDER_ACTION_KINDS)[number];

export interface JaceCommanderToolPolicy {
  readonly name: string;
  readonly scopes: readonly JaceCommanderScope[];
  readonly requiresApproval: boolean;
  readonly actionKind: JaceCommanderActionKind;
  readonly risk: "low" | "medium" | "critical";
}

const toolPolicy = (
  name: string,
  scope: JaceCommanderScope,
  requiresApproval: boolean,
  actionKind: JaceCommanderActionKind,
  risk: JaceCommanderToolPolicy["risk"]
): JaceCommanderToolPolicy =>
  Object.freeze({ name, scopes: Object.freeze([scope]), requiresApproval, actionKind, risk });

const TOOL_POLICIES: Readonly<Record<string, JaceCommanderToolPolicy>> = Object.freeze({
  jc_status: toolPolicy("jc_status", "integration.read", false, "jc.read", "low"),
  acs_read: toolPolicy("acs_read", "integration.read", false, "jc.read", "low"),
  swarm_read: toolPolicy("swarm_read", "integration.read", false, "jc.read", "low"),
  visualizer_read: toolPolicy("visualizer_read", "integration.read", false, "jc.read", "low"),
  // Submitting a mission is itself a request for ACS policy/approval.
  acs_submit_mission: toolPolicy("acs_submit_mission", "integration.write", false, "jc.write", "medium"),
  mission_router_list: toolPolicy("mission_router_list", "fs.read", false, "jc.read", "low"),
  looptrace_verify: toolPolicy("looptrace_verify", "fs.read", false, "jc.read", "low"),
  // Root execution: ALWAYS a fresh human approval per exact invocation.
  privileged_exec: toolPolicy("privileged_exec", "process.privileged", true, "jc.privileged_exec", "critical")
});

export function jaceCommanderToolPolicy(toolName: string): JaceCommanderToolPolicy | undefined {
  return Object.hasOwn(TOOL_POLICIES, toolName) ? TOOL_POLICIES[toolName] : undefined;
}

export function jaceCommanderToolNames(): string[] {
  return Object.keys(TOOL_POLICIES);
}

function argumentInvalid(message: string): never {
  throw new ControlStackError("jace_commander_argument_invalid", message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const MAX_ARGUMENT_BYTES = 128 * 1024;
const PRIVILEGED_MAX_ARGV = 256;
const PRIVILEGED_MAX_ARG_CHARS = 8192;
const PRIVILEGED_MAX_STDIN_CHARS = 64 * 1024;
const PRIVILEGED_MAX_TIMEOUT_MS = 600_000;

const ACS_VIEWS = ["health", "work-items", "work-item"];
const SWARM_VIEWS = ["health", "mission-control", "runs", "status", "task"];
const VISUALIZER_VIEWS = ["system-status", "runtimes", "executions", "approvals", "alerts", "agents"];

function allowKeys(args: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = []): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) argumentInvalid(`unknown argument: ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(args, key)) argumentInvalid(`missing argument: ${key}`);
  }
}

function optionalString(args: Record<string, unknown>, key: string, max = 1024): void {
  if (Object.hasOwn(args, key) && (typeof args[key] !== "string" || (args[key] as string).length > max)) {
    argumentInvalid(`${key} must be a string of at most ${max} characters`);
  }
}

function enumValue(args: Record<string, unknown>, key: string, values: readonly string[]): void {
  if (typeof args[key] !== "string" || !values.includes(args[key] as string)) {
    argumentInvalid(`${key} must be one of ${values.join(", ")}`);
  }
}

/**
 * privileged_exec shape. Mirrors the root helper's validatePrivilegedArguments
 * exactly and performs NO normalization: the capability binds the exact
 * delivered object, so rewriting it here would launder the human approval.
 */
function validatePrivilegedArguments(args: Record<string, unknown>): void {
  allowKeys(args, ["argv", "cwd", "timeoutMs", "stdin"], ["argv"]);
  const { argv, cwd, timeoutMs, stdin } = args;
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > PRIVILEGED_MAX_ARGV) {
    argumentInvalid(`argv must have 1..${PRIVILEGED_MAX_ARGV} entries`);
  }
  for (const entry of argv) {
    if (typeof entry !== "string" || entry.length > PRIVILEGED_MAX_ARG_CHARS || entry.includes("\0")) {
      argumentInvalid("argv entries must be strings without NUL");
    }
  }
  const executable = argv[0] as string;
  if (!posix.isAbsolute(executable) || posix.normalize(executable) !== executable) {
    argumentInvalid("argv[0] must be a normalized absolute path");
  }
  if (cwd !== undefined && (typeof cwd !== "string" || !posix.isAbsolute(cwd) || cwd.includes("\0"))) {
    argumentInvalid("cwd must be an absolute path");
  }
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > PRIVILEGED_MAX_TIMEOUT_MS)
  ) {
    argumentInvalid(`timeoutMs must be an integer in [1, ${PRIVILEGED_MAX_TIMEOUT_MS}]`);
  }
  if (stdin !== undefined && (typeof stdin !== "string" || stdin.length > PRIVILEGED_MAX_STDIN_CHARS)) {
    argumentInvalid("stdin must be a string <= 64 KiB");
  }
}

function validateToolArguments(toolName: string, args: Record<string, unknown>): void {
  switch (toolName) {
    case "jc_status":
    case "mission_router_list":
      allowKeys(args, []);
      return;
    case "acs_read":
      allowKeys(args, ["view", "id", "status"], ["view"]);
      enumValue(args, "view", ACS_VIEWS);
      optionalString(args, "id", 128);
      optionalString(args, "status", 64);
      return;
    case "swarm_read":
      allowKeys(args, ["view", "taskId"], ["view"]);
      enumValue(args, "view", SWARM_VIEWS);
      optionalString(args, "taskId", 128);
      return;
    case "visualizer_read":
      allowKeys(args, ["view"], ["view"]);
      enumValue(args, "view", VISUALIZER_VIEWS);
      return;
    case "looptrace_verify":
      allowKeys(args, ["path"], ["path"]);
      if (typeof args.path !== "string" || !posix.isAbsolute(args.path) || args.path.includes("\0")) {
        argumentInvalid("path must be an absolute path");
      }
      return;
    case "acs_submit_mission":
      allowKeys(
        args,
        ["title", "intent", "target", "requestedActions", "risk", "correlationId"],
        ["title", "intent", "target"]
      );
      optionalString(args, "title", 512);
      optionalString(args, "intent", 16_384);
      optionalString(args, "correlationId", 256);
      if (!isPlainObject(args.target)) argumentInvalid("target must be an object");
      if (Object.hasOwn(args, "requestedActions") && !Array.isArray(args.requestedActions)) {
        argumentInvalid("requestedActions must be an array");
      }
      if (Object.hasOwn(args, "risk")) enumValue(args, "risk", ["low", "medium", "high", "critical"]);
      return;
    case "privileged_exec":
      validatePrivilegedArguments(args);
      return;
    default:
      throw new ControlStackError("jace_commander_tool_not_allowlisted", "tool is not an acs.jc.v1 tool");
  }
}

export interface JaceCommanderInvocation {
  readonly toolName: string;
  readonly policy: JaceCommanderToolPolicy;
  /** Exactly the delivered arguments; never rewritten. */
  readonly normalizedArguments: Readonly<Record<string, unknown>>;
  readonly invocationHash: string;
}

/**
 * Validates the exact current tool call. The returned `normalizedArguments`
 * is a strict-canonical round trip of the input (a structural copy, not a
 * rewrite), so the capability binds precisely what the verifier will see.
 */
export function normalizeJaceCommanderInvocation(toolName: string, rawArguments: unknown): JaceCommanderInvocation {
  const policy = jaceCommanderToolPolicy(toolName);
  if (!policy) throw new ControlStackError("jace_commander_tool_not_allowlisted", "tool is not an acs.jc.v1 tool");
  if (!isPlainObject(rawArguments)) argumentInvalid("arguments must be an object");
  let canonical: string;
  try {
    canonical = strictCanonicalJsonV1(rawArguments);
  } catch {
    argumentInvalid("arguments must be strict canonical JSON values");
  }
  if (Buffer.byteLength(canonical, "utf8") > MAX_ARGUMENT_BYTES) argumentInvalid("arguments are too large");
  const copy = JSON.parse(canonical) as Record<string, unknown>;
  validateToolArguments(toolName, copy);
  const normalizedArguments = deepFreeze(copy);
  return Object.freeze({
    toolName,
    policy,
    normalizedArguments,
    invocationHash: jaceCommanderInvocationHash(toolName, normalizedArguments)
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

/** sha256("acs:jace-commander-invocation:v1\n" + strictCanonicalJsonV1({toolName, arguments})). */
export function jaceCommanderInvocationHash(toolName: string, normalizedArguments: Record<string, unknown>): string {
  const canonical = strictCanonicalJsonV1({ toolName, arguments: normalizedArguments });
  return createHash("sha256").update(`${JACE_COMMANDER_INVOCATION_DOMAIN}\n${canonical}`, "utf8").digest("hex");
}

/**
 * What a human approver sees for privileged_exec. The argv/cwd/timeout are
 * shown verbatim (they ARE the decision); stdin is shown only as a digest
 * and length because it may carry secrets. The invocation hash covers all of it.
 */
export function jaceCommanderApprovalDetail(invocation: JaceCommanderInvocation): Record<string, unknown> {
  const args = invocation.normalizedArguments;
  if (invocation.toolName !== "privileged_exec") {
    return { tool: invocation.toolName, argumentKeys: Object.keys(args).sort() };
  }
  const stdin = typeof args.stdin === "string" ? args.stdin : undefined;
  return {
    tool: invocation.toolName,
    argv: [...(args.argv as string[])],
    ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
    ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
    ...(stdin !== undefined
      ? { stdinBytes: Buffer.byteLength(stdin, "utf8"), stdinSha256: createHash("sha256").update(stdin).digest("hex") }
      : {})
  };
}

export interface JaceCommanderCapabilityPayload {
  readonly version: typeof JACE_COMMANDER_CAPABILITY_VERSION;
  readonly issuer: "acs";
  readonly audience: typeof JACE_COMMANDER_AUDIENCE;
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
  readonly scopes: readonly JaceCommanderScope[];
  readonly approvalId?: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
}

export interface JaceCommanderCapability {
  readonly payload: JaceCommanderCapabilityPayload;
  readonly signature: string;
  readonly keyId: string;
}

export interface JaceCommanderSigningConfig {
  readonly runtimeId: string;
  readonly keyId: string;
  /** Base64url PKCS#8 DER Ed25519. Separate from the acs.dc.v1 key; ACS memory only. */
  readonly privateKey: string;
  readonly ttlMs?: number;
}

export interface JaceCommanderIssuanceAuthority {
  readonly workItemId: string;
  readonly attemptId: string;
  readonly leaseId: string;
  readonly leaseEpoch: number;
  readonly planHash: string;
  /** Approval-bound action hash for privileged_exec, claim action hash otherwise. */
  readonly actionHash: string;
  readonly requestHash: string;
  readonly approvalId?: string;
}

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const KEY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

function capabilityInvalid(message: string): never {
  throw new ControlStackError("jace_commander_capability_invalid", message);
}

/** Builds the exact acs.jc.v1 payload. Signing happens only after durable issuance commits. */
export function prepareJaceCommanderCapability(
  invocation: JaceCommanderInvocation,
  authority: JaceCommanderIssuanceAuthority,
  config: JaceCommanderSigningConfig,
  now = new Date()
): JaceCommanderCapabilityPayload {
  if (!ID_PATTERN.test(config.runtimeId)) capabilityInvalid("runtimeId is invalid");
  if (!KEY_ID_PATTERN.test(config.keyId)) capabilityInvalid("keyId is invalid");
  for (const [label, value] of [
    ["workItemId", authority.workItemId],
    ["attemptId", authority.attemptId],
    ["leaseId", authority.leaseId]
  ] as const) {
    if (!ID_PATTERN.test(value)) capabilityInvalid(`${label} is invalid`);
  }
  for (const [label, value] of [
    ["planHash", authority.planHash],
    ["actionHash", authority.actionHash],
    ["requestHash", authority.requestHash]
  ] as const) {
    if (!HASH_PATTERN.test(value)) capabilityInvalid(`${label} is invalid`);
  }
  if (!Number.isSafeInteger(authority.leaseEpoch) || authority.leaseEpoch < 0)
    capabilityInvalid("leaseEpoch is invalid");
  // Same one-second margin as acs.dc.v1: julianday() rounding on the durable
  // row must never push an exact 30 s window over the database CHECK.
  const ttlMs = config.ttlMs ?? 29_000;
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > 30_000) capabilityInvalid("TTL must be between 1 and 30000ms");
  const { policy } = invocation;
  if (policy.requiresApproval && (!authority.approvalId || !ID_PATTERN.test(authority.approvalId))) {
    throw new ControlStackError("jace_commander_approval_missing", "required approval is absent from authorization");
  }
  if (!policy.requiresApproval && authority.approvalId !== undefined) {
    capabilityInvalid("unexpected approval for non-approval tool");
  }
  if (jaceCommanderInvocationHash(invocation.toolName, invocation.normalizedArguments) !== invocation.invocationHash) {
    capabilityInvalid("invocation hash drift");
  }
  const issuedAt = new Date(Math.floor(now.getTime() / 1_000) * 1_000).toISOString();
  const expiresAt = new Date(Date.parse(issuedAt) + ttlMs).toISOString();
  return Object.freeze({
    version: JACE_COMMANDER_CAPABILITY_VERSION,
    issuer: "acs",
    audience: JACE_COMMANDER_AUDIENCE,
    runtimeId: config.runtimeId,
    workItemId: authority.workItemId,
    attemptId: authority.attemptId,
    leaseId: authority.leaseId,
    leaseEpoch: authority.leaseEpoch,
    toolName: invocation.toolName,
    normalizedArguments: invocation.normalizedArguments,
    invocationHash: invocation.invocationHash,
    actionHash: authority.actionHash,
    requestHash: authority.requestHash,
    planHash: authority.planHash,
    scopes: [...policy.scopes],
    ...(authority.approvalId !== undefined ? { approvalId: authority.approvalId } : {}),
    issuedAt,
    expiresAt,
    nonce: randomBytes(32).toString("base64url")
  });
}

function jaceCommanderPrivateKey(config: Pick<JaceCommanderSigningConfig, "keyId" | "privateKey">) {
  if (!KEY_ID_PATTERN.test(config.keyId)) capabilityInvalid("keyId is invalid");
  try {
    const privateKey = createPrivateKey({
      key: Buffer.from(config.privateKey, "base64url"),
      format: "der",
      type: "pkcs8"
    });
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("not ed25519");
    return privateKey;
  } catch {
    capabilityInvalid("signing key is not a valid Ed25519 PKCS#8 key");
  }
}

/** Validate signing material before any authoritative lifecycle mutation. */
export function validateJaceCommanderSigningConfig(config: JaceCommanderSigningConfig): void {
  if (!ID_PATTERN.test(config.runtimeId)) capabilityInvalid("runtimeId is invalid");
  void jaceCommanderPrivateKey(config);
}

export function signJaceCommanderCapability(
  payload: JaceCommanderCapabilityPayload,
  config: Pick<JaceCommanderSigningConfig, "keyId" | "privateKey">
): JaceCommanderCapability {
  const signature = sign(null, Buffer.from(strictCanonicalJsonV1(payload), "utf8"), jaceCommanderPrivateKey(config));
  return Object.freeze({ payload, signature: signature.toString("base64url"), keyId: config.keyId });
}

/**
 * Work-item binding hash. Keyed with a secret derived from the signing key
 * so a caller with plain `acs:write` cannot pre-create a look-alike work
 * item that the issuer would later adopt as its approval target.
 */
export function jaceCommanderBindingHash(
  config: Pick<JaceCommanderSigningConfig, "privateKey">,
  binding: Record<string, unknown>
): string {
  const key = createHash("sha256").update("acs:jace-commander-binding-key:v1\n").update(config.privateKey).digest();
  return createHmac("sha256", key).update(strictCanonicalJsonV1(binding), "utf8").digest("hex");
}

/** Raw nonces are never persisted; only this digest is. */
export function jaceCommanderCapabilityNonceHash(nonce: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(nonce)) capabilityInvalid("nonce is invalid");
  return createHash("sha256").update(Buffer.from(nonce, "base64url")).digest("hex");
}
