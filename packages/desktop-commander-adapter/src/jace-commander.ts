import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { ControlStackError, strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import {
  executionActionHash,
  executionPlanApprovalRequestHash,
  type AttemptLease,
  type ClaimedWorkItem,
  type WorkItem
} from "@agent-control-stack/work-items";
import {
  JC_TOOL_ARGUMENT_SCHEMAS,
  jcToolContract,
  jcToolNames,
  type JcActionKind,
  type JcScope
} from "@agent-control-stack/jc-tool-manifest";
import type { z } from "zod";
import { containPath, type ContainmentConfig } from "./containment.js";

/**
 * acs.jc.v1 — ACS-issued capabilities for the Jace Commander MCP server
 * (jnibarger01/desktop-commander src/jace-commander, docs/jace-commander.md).
 *
 * Same envelope, strict canonicalization, Ed25519 signature, <=30 s TTL and
 * single-use nonce rules as acs.dc.v1 (docs/protocol/acs-jc-v1-capability-contract.md),
 * but a separate version, audience, scope vocabulary and invocation domain so
 * neither contract's capabilities verify under the other.
 *
 * Approval-bound tools are exactly the manifest entries with
 * `requiresApproval` (privileged_exec, the fs.write tools, start_process /
 * kill_process and git add/commit/fetch/push). ACS signs them only for a
 * consumed, human-granted approval bound to the exact invocation hash; the
 * approver is shown a bounded, redacted summary of the validated arguments
 * (jaceCommanderApprovalSummary).
 */

export const JACE_COMMANDER_CAPABILITY_VERSION = "acs.jc.v1" as const;
export const JACE_COMMANDER_AUDIENCE = "jace-commander" as const;
export const JACE_COMMANDER_INVOCATION_DOMAIN = "acs:jace-commander-invocation:v1";
export const JACE_COMMANDER_PRIVILEGED_TOOL = "privileged_exec" as const;
/** Policy action kind for privileged_exec; policy-gate always requires human approval for it. */
export const PRIVILEGED_EXEC_ACTION_KIND = "privileged.exec" as const;

// Scope, action-kind, argument-schema and policy data now live in the single
// canonical @agent-control-stack/jc-tool-manifest package (imported above).
// These type aliases and the policy lookup below keep this module's existing
// exported names and shapes unchanged for callers.
export type JaceCommanderScope = JcScope;
export type JaceCommanderActionKind = JcActionKind;

export interface JaceCommanderToolPolicy {
  readonly name: string;
  readonly scopes: readonly JaceCommanderScope[];
  readonly requiresApproval: boolean;
  readonly actionKind: JaceCommanderActionKind;
  readonly risk: "low" | "medium" | "critical";
  /** Arguments ACS must contain to its Jace Commander roots before signing. */
  readonly pathArguments: readonly string[];
}

const ARGUMENT_SCHEMAS: Readonly<Record<string, z.ZodType>> = JC_TOOL_ARGUMENT_SCHEMAS;

export function jaceCommanderToolPolicy(toolName: string): JaceCommanderToolPolicy | undefined {
  const entry = jcToolContract(toolName);
  if (!entry) return undefined;
  return Object.freeze({
    name: entry.name,
    scopes: Object.freeze([...entry.scopes]),
    requiresApproval: entry.requiresApproval,
    actionKind: entry.actionKind,
    risk: entry.risk,
    pathArguments: entry.pathArguments
  });
}

/**
 * ACS-side containment for path-bearing Jace Commander tools. Checks every
 * manifest-declared path argument against the ACS roots; never rewrites the
 * arguments (the capability binds the caller's exact strings, and Jace
 * Commander contains them again at execution time).
 */
export function containJaceCommanderInvocation(
  invocation: JaceCommanderInvocation,
  containment: ContainmentConfig
): void {
  for (const name of invocation.policy.pathArguments) {
    const value = invocation.arguments[name];
    const paths = Array.isArray(value) ? value : [value];
    for (const requested of paths) {
      try {
        containPath(containment, requested as string);
      } catch (error) {
        const code = error instanceof ControlStackError ? error.code : "desktop_commander_path_invalid";
        throw new ControlStackError(
          code.replace(/^desktop_commander_/u, "jace_commander_"),
          error instanceof Error ? error.message : "path is not allowed"
        );
      }
    }
  }
}

export function jaceCommanderToolNames(): string[] {
  return jcToolNames();
}

export interface JaceCommanderInvocation {
  readonly toolName: string;
  /** The exact delivered arguments (validated, never rewritten). */
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly invocationHash: string;
  readonly policy: JaceCommanderToolPolicy;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function jaceCommanderInvocationHash(toolName: string, args: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`${JACE_COMMANDER_INVOCATION_DOMAIN}\n${strictCanonicalJsonV1({ toolName, arguments: args })}`, "utf8")
    .digest("hex");
}

/**
 * Validates the exact delivered arguments. No defaults, coercion or path
 * rewriting: the verifier compares the signed `normalizedArguments` against
 * what the MCP client actually delivers, so any rewrite would fail closed.
 */
export function validateJaceCommanderInvocation(toolName: string, rawArguments: unknown): JaceCommanderInvocation {
  const toolPolicy = jaceCommanderToolPolicy(toolName);
  const schema = ARGUMENT_SCHEMAS[toolName];
  if (!toolPolicy || !schema) {
    throw new ControlStackError("jace_commander_tool_not_allowlisted", `unknown Jace Commander tool: ${toolName}`);
  }
  if (!isPlainObject(rawArguments)) {
    throw new ControlStackError("jace_commander_argument_invalid", "tool arguments must be a plain object");
  }
  const args = Object.fromEntries(Object.entries(rawArguments).filter(([, value]) => value !== undefined));
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ControlStackError(
      "jace_commander_argument_invalid",
      `${toolName}: ${issue ? `${issue.path.join(".") || "(root)"} ${issue.message}` : "invalid arguments"}`
    );
  }
  let canonicalArgs: Record<string, unknown>;
  try {
    // Round-trip through strict canonical JSON: rejects non-JSON values and
    // freezes a detached copy of exactly what will be signed.
    canonicalArgs = JSON.parse(strictCanonicalJsonV1(args)) as Record<string, unknown>;
  } catch {
    throw new ControlStackError("jace_commander_argument_invalid", "tool arguments are not strict JSON");
  }
  return Object.freeze({
    toolName,
    arguments: Object.freeze(canonicalArgs),
    invocationHash: jaceCommanderInvocationHash(toolName, canonicalArgs),
    policy: toolPolicy
  });
}

// --- approval summaries --------------------------------------------------------

/** Bounds for approver-facing previews (characters, list lengths). */
export const JACE_COMMANDER_SUMMARY_LIMITS = Object.freeze({
  preview: 200,
  listEntries: 20,
  entryChars: 256,
  textChars: 1500
});

// Secret-looking substrings are replaced in every free-text preview. Same
// shapes as the Mission Control display redaction (apps/control-ui
// redaction.ts) plus generic key=value / "key": "value" secrets; bounded
// quantifiers only.
const PREVIEW_REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/gu, "[redacted]"],
  [/Bearer\s+[A-Za-z0-9._~+/-]{1,4096}=*/giu, "Bearer [redacted]"],
  [/\bsk-[A-Za-z0-9_-]{12,}/gu, "[redacted]"],
  [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/gu, "[redacted]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/gu, "[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/gu, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu, "[redacted]"],
  [/(\b[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s/:@]{1,256}:)[^\s/@]{1,256}@/gu, "$1[redacted]@"],
  [
    /((?:^|[^A-Za-z0-9])[A-Za-z0-9_.-]{0,64}(?:secret|token|passw(?:or)?d|api[-_]?key|private[-_]?key|credential|authorization|cookie)[A-Za-z0-9_.-]{0,64}["']?\s{0,8}[:=]\s{0,8}["']?)[^\s"',;&]{1,4096}/giu,
    "$1[redacted]"
  ]
];

// Key-shaped run: 32+ token characters mixing upper case, lower case and digits
// (API keys, random secrets). Lower-case hex (git shas, sha256) and UUIDs do not
// match; "/" is excluded so absolute paths are never mistaken for keys.
const KEY_SHAPED_RUN = /[A-Za-z0-9+_=-]{32,4096}/gu;
function looksKeyShaped(run: string): boolean {
  return /[A-Z]/u.test(run) && /[a-z]/u.test(run) && /[0-9]/u.test(run);
}

/** Replace secret-looking substrings in an approver-facing preview. */
export function redactJaceCommanderPreview(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PREVIEW_REDACTIONS) out = out.replace(pattern, replacement);
  return out.replace(KEY_SHAPED_RUN, (run) => (looksKeyShaped(run) ? "[redacted]" : run));
}

// An argv entry naming a secret-bearing option whose value is the NEXT entry
// (`--password X`, `--token X`, `-H` + `Authorization: …` is covered by the text
// rules), or a bare `Bearer` / `Authorization:` token followed by its value.
const SECRET_OPTION_ENTRY =
  /^(?:-{1,2}[A-Za-z0-9_.-]{0,64}(?:secret|token|passw(?:or)?d|pass|pwd|api[-_]?key|private[-_]?key|credential|auth(?:orization)?|bearer|cookie)[A-Za-z0-9_.-]{0,64}|bearer|basic|(?:proxy-)?authorization:?|cookie:?|[A-Za-z0-9_.-]{0,64}(?:secret|token|passw(?:or)?d|api[-_]?key)[A-Za-z0-9_.-]{0,64}[:=])$/iu;

/**
 * Argv-aware redaction for approver-facing previews and evidence: each entry
 * gets the text redaction, and the entry after a secret-bearing option is
 * replaced wholesale. Runs over the FULL argv before any bounding, so an
 * option at the truncation edge still hides its value.
 */
export function redactJaceCommanderArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  let hideNext = false;
  for (const entry of argv) {
    if (hideNext) {
      out.push("[redacted]");
      // `Authorization:` `Bearer` `<token>`: a hidden scheme word hides the next entry too.
      hideNext = /^(?:bearer|basic)$/iu.test(entry);
      continue;
    }
    out.push(redactJaceCommanderPreview(entry));
    hideNext = SECRET_OPTION_ENTRY.test(entry);
  }
  return out;
}

function preview(text: string, limit: number = JACE_COMMANDER_SUMMARY_LIMITS.preview): string {
  const redacted = redactJaceCommanderPreview(text);
  return redacted.length > limit ? `${redacted.slice(0, limit)}…` : redacted;
}

/** Bounded, redacted list (paths, argv entries). Every value is redacted; nothing raw is echoed. */
function boundedList(values: readonly string[]): { values: string[]; total: number } {
  const { listEntries, entryChars } = JACE_COMMANDER_SUMMARY_LIMITS;
  return {
    values: values.slice(0, listEntries).map((value) => preview(value, entryChars)),
    total: values.length
  };
}

/** Argv: argv-aware redaction over the full vector first, then bounding. */
function boundedArgv(argv: readonly string[]): { values: string[]; total: number } {
  return boundedList(redactJaceCommanderArgv(argv));
}

/** A single path-like field: bounded and redacted like any other free string. */
function pathText(value: unknown): string | undefined {
  const text = str(value);
  return text === undefined ? undefined : preview(text, JACE_COMMANDER_SUMMARY_LIMITS.entryChars);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

type SummaryArgs = Readonly<Record<string, unknown>>;
type SummaryBuilder = (args: SummaryArgs) => Record<string, unknown>;

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const strs = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/**
 * One summary builder per approval-gated tool, over its VALIDATED arguments
 * (validateJaceCommanderInvocation already ran the strict schema). Values are
 * bounded; free text (file content, edit text, argv, commit messages) is
 * redacted. A drift test asserts every manifest tool with requiresApproval
 * has a builder here, and jaceCommanderApprovalSummary fails closed if not.
 */
export const JACE_COMMANDER_APPROVAL_SUMMARY_BUILDERS: Readonly<Record<string, SummaryBuilder>> = Object.freeze({
  privileged_exec: (args) => {
    // Same bounded, argv-aware redacted path as start_process: the approver sees
    // the command shape, never a secret passed on the command line. The exact
    // argv stays bound through the invocation hash.
    const argv = boundedArgv(strs(args.argv));
    return {
      runAs: "root",
      argv: argv.values,
      ...(argv.total > argv.values.length ? { argvTotal: argv.total } : {}),
      cwd: pathText(args.cwd) ?? "/",
      timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : 60_000,
      stdinBytes: str(args.stdin) === undefined ? 0 : Buffer.byteLength(str(args.stdin)!, "utf8")
    };
  },
  write_file: (args) => {
    const content = str(args.content) ?? "";
    return {
      path: pathText(args.path),
      bytes: Buffer.byteLength(content, "utf8"),
      sha256: sha256Hex(content),
      preview: preview(content),
      overwrite: args.overwrite === true
    };
  },
  edit_block: (args) => ({
    path: pathText(args.path),
    oldBytes: Buffer.byteLength(str(args.old) ?? "", "utf8"),
    newBytes: Buffer.byteLength(str(args.new) ?? "", "utf8"),
    oldPreview: preview(str(args.old) ?? ""),
    newPreview: preview(str(args.new) ?? "")
  }),
  move_file: (args) => ({ from: pathText(args.from), to: pathText(args.to) }),
  create_directory: (args) => ({ path: pathText(args.path), recursive: args.recursive === true }),
  start_process: (args) => {
    const argv = boundedArgv(strs(args.argv));
    return {
      argv: argv.values,
      ...(argv.total > argv.values.length ? { argvTotal: argv.total } : {}),
      cwd: pathText(args.cwd),
      timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : "default"
    };
  },
  kill_process: (args) => ({
    ...(str(args.sessionId) !== undefined ? { sessionId: str(args.sessionId) } : {}),
    ...(typeof args.pid === "number" ? { pid: args.pid } : {}),
    // ACS never sees the target's argv: sessions live in the Jace Commander
    // process. Said explicitly so the approver does not assume it was checked.
    argv: "unknown to ACS (the session was started inside Jace Commander)"
  }),
  git_add: (args) => {
    const paths = boundedList(strs(args.paths));
    return {
      repo: pathText(args.repo),
      paths: paths.values,
      ...(paths.total > paths.values.length ? { pathsTotal: paths.total } : {})
    };
  },
  git_commit: (args) => ({ repo: pathText(args.repo), message: preview(str(args.message) ?? "", 500) }),
  // remote / branch / expectedHead are schema-restricted (remote name, ref name,
  // 40-hex sha): they cannot carry a URL, credential or free text.
  git_fetch: (args) => ({ repo: pathText(args.repo), remote: str(args.remote) ?? "default" }),
  git_push: (args) => ({
    repo: pathText(args.repo),
    remote: str(args.remote) ?? "default",
    branch: str(args.branch) ?? "current",
    expectedHead: str(args.expectedHead)
  })
});

/**
 * Approval summary shown to the approver (the 409 approval challenge, the
 * work item's action params, title and intent). Always carries the tool and
 * the invocation hash the capability is bound to. Never contains stdin or
 * unbounded/unredacted file content.
 */
export function jaceCommanderApprovalSummary(invocation: JaceCommanderInvocation): Record<string, unknown> {
  const builder = Object.prototype.hasOwnProperty.call(JACE_COMMANDER_APPROVAL_SUMMARY_BUILDERS, invocation.toolName)
    ? JACE_COMMANDER_APPROVAL_SUMMARY_BUILDERS[invocation.toolName]
    : undefined;
  if (!builder) {
    if (invocation.policy.requiresApproval) {
      // Fail closed: never ask a human to approve something we cannot describe.
      throw new ControlStackError(
        "jace_commander_approval_summary_missing",
        `no approval summary for approval-gated tool ${invocation.toolName}`
      );
    }
    return { tool: invocation.toolName, invocationHash: invocation.invocationHash };
  }
  return { tool: invocation.toolName, ...builder(invocation.arguments), invocationHash: invocation.invocationHash };
}

/** One-line rendering of the approval summary (bounded), for titles and intents. */
export function jaceCommanderApprovalSummaryText(invocation: JaceCommanderInvocation): string {
  const summary = jaceCommanderApprovalSummary(invocation);
  const parts: string[] = [];
  for (const [key, value] of Object.entries(summary)) {
    if (key === "tool" || key === "invocationHash" || value === undefined) continue;
    parts.push(`${key}=${JSON.stringify(value)}`);
  }
  // Defense in depth: every field was already redacted by its builder; the
  // rendered line gets the text rules once more.
  const text = redactJaceCommanderPreview(`${invocation.toolName} ${parts.join(" ")}`.trim());
  const { textChars } = JACE_COMMANDER_SUMMARY_LIMITS;
  return text.length > textChars ? `${text.slice(0, textChars)}…` : text;
}

/** Work-item title for a Jace Commander capability request (<= 200 chars). */
export function jaceCommanderWorkItemTitle(invocation: JaceCommanderInvocation): string {
  if (invocation.toolName === JACE_COMMANDER_PRIVILEGED_TOOL) {
    // Built from the redacted, bounded summary argv, never the raw argv.
    const summary = jaceCommanderApprovalSummary(invocation);
    const argv = Array.isArray(summary.argv) ? (summary.argv as string[]) : [];
    const more = typeof summary.argvTotal === "number" ? ` … (${summary.argvTotal} args)` : "";
    const text = redactJaceCommanderPreview(`${argv.join(" ")}${more}`);
    return `ROOT: ${text.length > 180 ? `${text.slice(0, 179)}…` : text}`;
  }
  if (!invocation.policy.requiresApproval) return `Jace Commander capability: ${invocation.toolName}`;
  const text = `Jace Commander ${jaceCommanderApprovalSummaryText(invocation)}`;
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/** Work-item intent: who asked for which tool, plus the approval summary for gated tools. */
export function jaceCommanderWorkItemIntent(invocation: JaceCommanderInvocation, requesterSubject: string): string {
  const base = `ACS-issued acs.jc.v1 capability for Jace Commander tool ${invocation.toolName} requested by ${requesterSubject}`;
  return invocation.policy.requiresApproval
    ? `${base}. Approve exactly: ${jaceCommanderApprovalSummaryText(invocation)}`
    : base;
}

// --- execution authorization --------------------------------------------------

const AUTHORIZATION_BRAND = Symbol("acs.jace-commander.execution-authorization");

export interface JaceCommanderExecutionAuthorization {
  readonly [AUTHORIZATION_BRAND]: true;
  readonly workItemId: string;
  readonly attemptId: string;
  readonly leaseId: string;
  readonly workerId: string;
  readonly planHash: string;
  readonly inputHash: string;
  readonly fencingEpoch: number;
  readonly actionHash: string;
  readonly invocation: JaceCommanderInvocation;
  readonly approvalId?: string;
  readonly approvalActionHash?: string;
}

export interface AuthorizeJaceCommanderInput {
  claimed: ClaimedWorkItem;
  trustedWorkItem: Pick<WorkItem, "id" | "status" | "requester" | "intent" | "target" | "requestedActions" | "risk">;
  lease: AttemptLease;
  workerId: string;
  invocation: JaceCommanderInvocation;
  now?: Date;
}

/** Re-checks work-item, lease, fencing, action and invocation binding immediately before issuance. */
export function authorizeJaceCommanderExecution(
  input: AuthorizeJaceCommanderInput
): JaceCommanderExecutionAuthorization {
  const now = input.now ?? new Date();
  const { claimed, trustedWorkItem, lease, workerId, invocation } = input;
  const fail = (code: string, message: string): never => {
    throw new ControlStackError(code, message);
  };
  if (trustedWorkItem.status !== "running") fail("jace_commander_work_item_not_executable", "work item is not running");
  if (claimed.id !== trustedWorkItem.id) fail("jace_commander_work_item_mismatch", "claimed work item mismatch");
  if (claimed.workerId !== workerId || lease.workerId !== workerId) {
    fail("jace_commander_lease_worker_mismatch", "lease is not held by this worker");
  }
  if (lease.workItemId !== trustedWorkItem.id)
    fail("jace_commander_lease_work_item_mismatch", "lease work item mismatch");
  if (claimed.attemptId === undefined || lease.attemptId !== claimed.attemptId) {
    fail("jace_commander_lease_attempt_mismatch", "lease attempt mismatch");
  }
  if (lease.status !== "active") fail("jace_commander_lease_inactive", `attempt lease is ${lease.status}`);
  const leaseExpiry = Date.parse(lease.expiresAt);
  if (!Number.isFinite(leaseExpiry) || leaseExpiry <= now.getTime())
    fail("jace_commander_lease_expired", "lease expired");
  if (claimed.fencingEpoch === undefined || lease.fencingEpoch !== claimed.fencingEpoch) {
    fail("jace_commander_lease_fencing_mismatch", "lease fencing epoch mismatch");
  }
  if (claimed.planHash === undefined || claimed.inputHash === undefined || lease.planHash !== claimed.planHash) {
    fail("jace_commander_plan_hash_mismatch", "lease plan hash mismatch");
  }
  const recomputedActionHash = executionActionHash(trustedWorkItem);
  if (recomputedActionHash !== claimed.actionHash) {
    fail("jace_commander_action_hash_changed", "work item action hash changed since claim");
  }
  const actions = trustedWorkItem.requestedActions ?? [];
  const params = (actions[0]?.params ?? {}) as Record<string, unknown>;
  if (
    actions.length !== 1 ||
    actions[0]?.kind !== invocation.policy.actionKind ||
    params.tool !== invocation.toolName ||
    params.invocationHash !== invocation.invocationHash
  ) {
    fail("jace_commander_invocation_binding_mismatch", "invocation does not match the trusted work-item binding");
  }
  if (invocation.policy.requiresApproval && lease.approvalId === undefined) {
    fail("jace_commander_approval_missing", `${invocation.toolName} requires a lease-bound approval`);
  }
  if (!invocation.policy.requiresApproval && lease.approvalId !== undefined) {
    fail("jace_commander_approval_unexpected", `${invocation.toolName} must not carry an approval`);
  }
  return Object.freeze({
    [AUTHORIZATION_BRAND]: true as const,
    workItemId: trustedWorkItem.id,
    attemptId: claimed.attemptId!,
    leaseId: claimed.leaseId,
    workerId,
    planHash: claimed.planHash!,
    inputHash: claimed.inputHash!,
    fencingEpoch: claimed.fencingEpoch!,
    actionHash: recomputedActionHash,
    invocation,
    ...(lease.approvalId !== undefined ? { approvalId: lease.approvalId } : {})
  });
}

// --- payload + signing ---------------------------------------------------------

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
  readonly scopes: readonly string[];
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
  /** Base64url PKCS#8 DER Ed25519. Must differ from the acs.dc.v1 key. */
  readonly privateKey: string;
  readonly ttlMs?: number;
}

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const KEY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u;

export function prepareJaceCommanderCapability(
  authorization: JaceCommanderExecutionAuthorization,
  config: JaceCommanderSigningConfig,
  now = new Date()
): JaceCommanderCapabilityPayload {
  if (!ID_PATTERN.test(config.runtimeId) || !KEY_ID_PATTERN.test(config.keyId)) {
    throw new ControlStackError("jace_commander_capability_invalid", "runtimeId or keyId is invalid");
  }
  // One second inside the 30 s protocol ceiling (see acs.dc.v1 prepare rationale).
  const ttlMs = config.ttlMs ?? 29_000;
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > 30_000) {
    throw new ControlStackError("jace_commander_capability_invalid", "capability TTL must be between 1 and 30000ms");
  }
  const { invocation } = authorization;
  if (invocation.policy.requiresApproval !== (authorization.approvalId !== undefined)) {
    throw new ControlStackError("jace_commander_capability_invalid", "approval presence does not match tool policy");
  }
  const actionHash =
    authorization.approvalId !== undefined && authorization.approvalActionHash !== undefined
      ? authorization.approvalActionHash
      : authorization.actionHash;
  const requestHash = executionPlanApprovalRequestHash({
    workItemId: authorization.workItemId,
    planHash: authorization.planHash,
    actionHash
  });
  const issuedAt = new Date(Math.floor(now.getTime() / 1_000) * 1_000).toISOString();
  return Object.freeze({
    version: JACE_COMMANDER_CAPABILITY_VERSION,
    issuer: "acs",
    audience: JACE_COMMANDER_AUDIENCE,
    runtimeId: config.runtimeId,
    workItemId: authorization.workItemId,
    attemptId: authorization.attemptId,
    leaseId: authorization.leaseId,
    leaseEpoch: authorization.fencingEpoch,
    toolName: invocation.toolName,
    normalizedArguments: invocation.arguments,
    invocationHash: invocation.invocationHash,
    actionHash,
    requestHash,
    planHash: authorization.planHash,
    scopes: [...invocation.policy.scopes],
    ...(authorization.approvalId !== undefined ? { approvalId: authorization.approvalId } : {}),
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + ttlMs).toISOString(),
    nonce: randomBytes(32).toString("base64url")
  });
}

function signingKey(config: Pick<JaceCommanderSigningConfig, "keyId" | "privateKey">) {
  if (!KEY_ID_PATTERN.test(config.keyId)) {
    throw new ControlStackError("jace_commander_capability_invalid", "keyId is invalid");
  }
  try {
    const key = createPrivateKey({ key: Buffer.from(config.privateKey, "base64url"), format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("not ed25519");
    return key;
  } catch {
    throw new ControlStackError("jace_commander_capability_invalid", "signing key is not a valid Ed25519 PKCS#8 key");
  }
}

export function validateJaceCommanderSigningConfig(
  config: Pick<JaceCommanderSigningConfig, "keyId" | "privateKey">
): void {
  void signingKey(config);
}

/** Signs only after the caller's durable issuance record commits. */
export function signPreparedJaceCommanderCapability(
  payload: JaceCommanderCapabilityPayload,
  config: Pick<JaceCommanderSigningConfig, "keyId" | "privateKey">
): JaceCommanderCapability {
  const signature = sign(null, Buffer.from(strictCanonicalJsonV1(payload), "utf8"), signingKey(config));
  return Object.freeze({ payload, signature: signature.toString("base64url"), keyId: config.keyId });
}

export function jaceCommanderNonceHash(nonce: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(nonce)) {
    throw new ControlStackError("jace_commander_capability_invalid", "nonce is invalid");
  }
  return createHash("sha256").update(Buffer.from(nonce, "base64url")).digest("hex");
}

/** Reads acs.jc.v1 signing config from env; absent config disables the route (fail closed). */
export function jaceCommanderSigningConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): JaceCommanderSigningConfig | undefined {
  const privateKey = env.ACS_JACE_COMMANDER_CAPABILITY_PRIVATE_KEY;
  const keyId = env.ACS_JACE_COMMANDER_CAPABILITY_KEY_ID;
  const runtimeId = env.ACS_JACE_COMMANDER_RUNTIME_ID;
  if (!privateKey && !keyId && !runtimeId) return undefined;
  if (!privateKey || !keyId || !runtimeId) {
    throw new ControlStackError(
      "jace_commander_capability_config_incomplete",
      "ACS_JACE_COMMANDER_CAPABILITY_PRIVATE_KEY, ACS_JACE_COMMANDER_CAPABILITY_KEY_ID and ACS_JACE_COMMANDER_RUNTIME_ID must be set together"
    );
  }
  const config = { privateKey, keyId, runtimeId };
  validateJaceCommanderSigningConfig(config);
  if (!ID_PATTERN.test(runtimeId))
    throw new ControlStackError("jace_commander_capability_invalid", "runtimeId is invalid");
  return config;
}
