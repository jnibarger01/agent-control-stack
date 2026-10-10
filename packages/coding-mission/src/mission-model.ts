/**
 * Mission / work-unit model shared by every mission kind.
 *
 * The coding mission is one profile of this model, not a separate engine: its persisted states and operation
 * statuses are a subset of the sets below, and every transition still goes through the store's version guard.
 * Illegal transitions fail closed.
 */
import { ControlStackError } from "@agent-control-stack/shared";

export const MISSION_STATES = [
  "CREATED",
  "PLANNING",
  "READY",
  "RUNNING",
  "WAITING_FOR_DEPENDENCY",
  "WAITING_FOR_APPROVAL",
  "VERIFYING",
  "RECOVERING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  // Coding-profile phases. They keep their existing meaning and are driven by the coding controller.
  "RECONCILING",
  "VALIDATING",
  "PREPARING_CHANGE_SET",
  "PUBLISHING_PROPOSAL",
  "APPROVED",
  "EXECUTING",
  "DEGRADED"
] as const;
export type MissionState = (typeof MISSION_STATES)[number];

export const TERMINAL_MISSION_STATES: ReadonlySet<MissionState> = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

export const MISSION_KINDS = ["coding", "general"] as const;
export type MissionKind = (typeof MISSION_KINDS)[number];

/** Transitions for 'general' missions. CANCELLED is reachable from every non-terminal state. */
const GENERAL_MISSION_TRANSITIONS: Readonly<Record<string, readonly MissionState[]>> = {
  CREATED: ["PLANNING", "READY", "FAILED", "CANCELLED"],
  PLANNING: ["READY", "WAITING_FOR_APPROVAL", "FAILED", "CANCELLED"],
  READY: ["RUNNING", "WAITING_FOR_APPROVAL", "FAILED", "CANCELLED"],
  RUNNING: [
    "WAITING_FOR_DEPENDENCY",
    "WAITING_FOR_APPROVAL",
    "VERIFYING",
    "RECOVERING",
    "COMPLETED",
    "FAILED",
    "CANCELLED"
  ],
  WAITING_FOR_DEPENDENCY: ["RUNNING", "READY", "FAILED", "CANCELLED"],
  WAITING_FOR_APPROVAL: ["READY", "RUNNING", "FAILED", "CANCELLED"],
  VERIFYING: ["COMPLETED", "RECOVERING", "RUNNING", "FAILED", "CANCELLED"],
  RECOVERING: ["RUNNING", "READY", "WAITING_FOR_APPROVAL", "FAILED", "CANCELLED"]
};

export function missionTransitionAllowed(kind: MissionKind, from: MissionState, to: MissionState): boolean {
  if (TERMINAL_MISSION_STATES.has(from)) return false;
  if (to === "CANCELLED") return true;
  if (kind === "general") return GENERAL_MISSION_TRANSITIONS[from]?.includes(to) ?? false;
  // The coding controller owns the ordering of its own phases; the shared invariant is only that terminal states stick.
  return true;
}

export function assertMissionTransition(kind: MissionKind, from: MissionState, to: MissionState): void {
  if (!missionTransitionAllowed(kind, from, to)) {
    throw new ControlStackError("mission_transition_illegal", `${kind} mission cannot move from ${from} to ${to}`);
  }
}

export const WORK_UNIT_STATUSES = [
  "pending",
  "ready",
  "claimed",
  "running",
  "checkpointed",
  "verifying",
  "succeeded",
  "failed",
  "retryable",
  "cancelled",
  // Coding-profile outcomes: a conflicting or outcome-unknown operation. Neither is retried blindly.
  "conflict",
  "unknown"
] as const;
export type WorkUnitStatus = (typeof WORK_UNIT_STATUSES)[number];

export const TERMINAL_WORK_UNIT_STATUSES: ReadonlySet<WorkUnitStatus> = new Set(["succeeded", "cancelled"]);
/** Statuses in which a worker may be doing, or may already have done, external work. */
export const IN_FLIGHT_WORK_UNIT_STATUSES: readonly WorkUnitStatus[] = [
  "claimed",
  "running",
  "checkpointed",
  "verifying",
  "unknown"
];

const WORK_UNIT_TRANSITIONS: Readonly<Record<WorkUnitStatus, readonly WorkUnitStatus[]>> = {
  pending: ["ready", "running", "failed", "cancelled"],
  ready: ["claimed", "running", "failed", "cancelled"],
  claimed: ["running", "ready", "failed", "cancelled"],
  running: [
    "checkpointed",
    "verifying",
    "succeeded",
    "failed",
    "retryable",
    "cancelled",
    "conflict",
    "unknown",
    "pending"
  ],
  checkpointed: ["running", "verifying", "succeeded", "failed", "retryable", "cancelled"],
  verifying: ["succeeded", "failed", "retryable", "cancelled"],
  retryable: ["pending", "failed", "cancelled"],
  failed: ["pending", "cancelled"],
  unknown: ["succeeded", "pending", "failed", "cancelled"],
  conflict: ["failed", "cancelled"],
  succeeded: [],
  cancelled: []
};

export function workUnitTransitionAllowed(from: WorkUnitStatus, to: WorkUnitStatus): boolean {
  return WORK_UNIT_TRANSITIONS[from].includes(to);
}

export function assertWorkUnitTransition(from: WorkUnitStatus, to: WorkUnitStatus): void {
  if (!workUnitTransitionAllowed(from, to)) {
    throw new ControlStackError("work_unit_transition_illegal", `work unit cannot move from ${from} to ${to}`);
  }
}

export const WORK_UNIT_KINDS = [
  "planning",
  "coding",
  "shell",
  "tool",
  "desktop",
  "cua",
  "verification",
  "agent",
  "swarm",
  "recovery"
] as const;
export type WorkUnitKind = (typeof WORK_UNIT_KINDS)[number];

export const VERIFICATION_POLICIES = ["none", "lightweight", "independent", "multi_verifier", "release_gate"] as const;
export type VerificationPolicy = (typeof VERIFICATION_POLICIES)[number];

/** Normalized execution failure categories. Workers keep their native error beside one of these. */
export const FAILURE_CATEGORIES = [
  "policy_denied",
  "authority_expired",
  "lease_lost",
  "worker_unavailable",
  "tool_failure",
  "timeout",
  "invalid_output",
  "dependency_failure",
  "verification_failure",
  "environment_changed",
  "retry_budget_exhausted",
  "cancelled",
  "unknown"
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/** Categories a retry can never fix. Retrying them would only repeat a refused or already-final outcome. */
export const NON_RETRYABLE_FAILURES: ReadonlySet<FailureCategory> = new Set([
  "policy_denied",
  "authority_expired",
  "retry_budget_exhausted",
  "cancelled"
]);

// Discriminated, typed payloads. Each carries only the fields the executor class needs to be admitted and routed.
export type WorkUnitPayload =
  | { kind: "planning"; goal: string }
  | { kind: "coding"; instructions?: string; files?: string[] }
  | { kind: "shell"; argv: string[]; cwd?: string }
  | { kind: "tool"; toolName: string; argsHash?: string }
  | { kind: "desktop"; objective: string }
  | {
      kind: "cua";
      objective: string;
      allowedApplications?: string[];
      allowedOrigins?: string[];
      actions?: CuaAction[];
    }
  | { kind: "verification"; targetUnitId: string }
  | { kind: "agent"; role: string; prompt: string }
  | {
      kind: "swarm";
      strategy: "parallel_research" | "parallel_candidates" | "specialist_decomposition";
      fanOut: number;
    }
  | { kind: "recovery"; failedUnitId: string; category: FailureCategory };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown, max = 4096): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const isStringList = (value: unknown, max = 256): value is string[] =>
  Array.isArray(value) && value.length <= max && value.every((entry) => isString(entry));

export const CUA_ACTION_TYPES = ["observe", "click", "type", "scroll", "navigate"] as const;
export type CuaActionType = (typeof CUA_ACTION_TYPES)[number];

/** Browser actions a CUA work unit may already carry. No script, shell, or evaluate. */
export type CuaAction =
  | { type: "observe" }
  | { type: "click"; selector: string }
  | { type: "type"; selector: string; text: string }
  | { type: "scroll"; dx: number; dy: number }
  | { type: "navigate"; url: string };

const CUA_ACTION_FIELDS: Record<CuaActionType, readonly string[]> = {
  observe: ["type"],
  click: ["type", "selector"],
  type: ["type", "selector", "text"],
  scroll: ["type", "dx", "dy"],
  navigate: ["type", "url"]
};

function parseExactHttpOrigin(value: unknown): string | undefined {
  if (!isString(value, 256) || /[\s*\\]/u.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
    return undefined;
  }
  return value === url.origin ? url.origin : undefined;
}

function parseCuaAction(value: unknown): CuaAction | undefined {
  if (
    !isRecord(value) ||
    typeof value.type !== "string" ||
    !(CUA_ACTION_TYPES as readonly string[]).includes(value.type)
  ) {
    return undefined;
  }
  const type = value.type as CuaActionType;
  if (Object.keys(value).some((key) => !CUA_ACTION_FIELDS[type].includes(key))) return undefined;
  if (type === "observe") return { type };
  if (type === "click") return isString(value.selector, 512) ? { type, selector: value.selector } : undefined;
  if (type === "type") {
    return isString(value.selector, 512) && isString(value.text, 4096)
      ? { type, selector: value.selector, text: value.text }
      : undefined;
  }
  if (type === "scroll") {
    const bounded = (entry: unknown) =>
      typeof entry === "number" && Number.isInteger(entry) && Math.abs(entry) <= 1_000_000;
    return bounded(value.dx) && bounded(value.dy)
      ? { type, dx: value.dx as number, dy: value.dy as number }
      : undefined;
  }
  return isString(value.url, 2048) ? { type, url: value.url } : undefined;
}

/** Validate an untrusted payload for a unit kind. Unknown fields are rejected so a payload cannot smuggle authority. */
export function parseWorkUnitPayload(kind: WorkUnitKind, value: unknown): WorkUnitPayload {
  const invalid = (reason: string): never => {
    throw new ControlStackError("work_unit_payload_invalid", `${kind} payload ${reason}`);
  };
  if (!isRecord(value)) return invalid("must be an object");
  const allowed: Record<WorkUnitKind, readonly string[]> = {
    planning: ["goal"],
    coding: ["instructions", "files"],
    shell: ["argv", "cwd"],
    tool: ["toolName", "argsHash"],
    desktop: ["objective"],
    cua: ["objective", "allowedApplications", "allowedOrigins", "actions"],
    verification: ["targetUnitId"],
    agent: ["role", "prompt"],
    swarm: ["strategy", "fanOut"],
    recovery: ["failedUnitId", "category"]
  };
  for (const key of Object.keys(value)) {
    if (key !== "kind" && !allowed[kind].includes(key)) return invalid(`has unknown field ${key}`);
  }
  if (value.kind !== undefined && value.kind !== kind) return invalid("kind does not match the work unit kind");
  switch (kind) {
    case "planning":
      if (!isString(value.goal, 8192)) return invalid("requires goal");
      return { kind, goal: value.goal };
    case "coding":
      if (value.instructions !== undefined && !isString(value.instructions, 16384))
        return invalid("has bad instructions");
      if (value.files !== undefined && !isStringList(value.files)) return invalid("has bad files");
      return {
        kind,
        ...(value.instructions === undefined ? {} : { instructions: value.instructions as string }),
        ...(value.files === undefined ? {} : { files: value.files as string[] })
      };
    case "shell":
      if (!isStringList(value.argv, 128) || (value.argv as string[]).length === 0) return invalid("requires argv");
      if (value.cwd !== undefined && !isString(value.cwd)) return invalid("has bad cwd");
      return {
        kind,
        argv: value.argv as string[],
        ...(value.cwd === undefined ? {} : { cwd: value.cwd as string })
      };
    case "tool":
      if (!isString(value.toolName, 128)) return invalid("requires toolName");
      if (value.argsHash !== undefined && !isString(value.argsHash, 128)) return invalid("has bad argsHash");
      return {
        kind,
        toolName: value.toolName,
        ...(value.argsHash === undefined ? {} : { argsHash: value.argsHash as string })
      };
    case "desktop":
      if (!isString(value.objective, 8192)) return invalid("requires objective");
      return { kind, objective: value.objective };
    case "cua": {
      if (!isString(value.objective, 8192)) return invalid("requires objective");
      if (value.allowedApplications !== undefined && !isStringList(value.allowedApplications, 64)) {
        return invalid("has bad allowedApplications");
      }
      let allowedOrigins: string[] | undefined;
      if (value.allowedOrigins !== undefined) {
        if (!Array.isArray(value.allowedOrigins) || value.allowedOrigins.length > 64) {
          return invalid("has bad allowedOrigins");
        }
        allowedOrigins = [];
        for (const origin of value.allowedOrigins) {
          const parsed = parseExactHttpOrigin(origin);
          if (!parsed) return invalid("has bad allowedOrigins");
          allowedOrigins.push(parsed);
        }
      }
      let actions: CuaAction[] | undefined;
      if (value.actions !== undefined) {
        if (!Array.isArray(value.actions) || value.actions.length > 32) return invalid("has bad actions");
        actions = [];
        for (const action of value.actions) {
          const parsed = parseCuaAction(action);
          if (!parsed) return invalid("has bad actions");
          actions.push(parsed);
        }
      }
      return {
        kind,
        objective: value.objective,
        ...(value.allowedApplications === undefined
          ? {}
          : { allowedApplications: value.allowedApplications as string[] }),
        ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
        ...(actions === undefined ? {} : { actions })
      };
    }
    case "verification":
      if (!isString(value.targetUnitId, 128)) return invalid("requires targetUnitId");
      return { kind, targetUnitId: value.targetUnitId };
    case "agent":
      if (!isString(value.role, 128) || !isString(value.prompt, 16384)) return invalid("requires role and prompt");
      return { kind, role: value.role, prompt: value.prompt };
    case "swarm": {
      const strategies = ["parallel_research", "parallel_candidates", "specialist_decomposition"];
      if (typeof value.strategy !== "string" || !strategies.includes(value.strategy))
        return invalid("has bad strategy");
      if (!Number.isInteger(value.fanOut) || (value.fanOut as number) < 1 || (value.fanOut as number) > 64) {
        return invalid("has bad fanOut");
      }
      return { kind, strategy: value.strategy as never, fanOut: value.fanOut as number };
    }
    case "recovery":
      if (!isString(value.failedUnitId, 128)) return invalid("requires failedUnitId");
      if (!(FAILURE_CATEGORIES as readonly unknown[]).includes(value.category)) return invalid("has bad category");
      return { kind, failedUnitId: value.failedUnitId, category: value.category as FailureCategory };
  }
}

/** Generalized view of a persisted operation row. */
export interface WorkUnit {
  missionId: string;
  unitId: string;
  kind: WorkUnitKind;
  title: string;
  status: WorkUnitStatus;
  dependsOn: string[];
  attempt: number;
  depth: number;
  parentUnitId?: string;
  verificationPolicy: VerificationPolicy;
  payload?: WorkUnitPayload;
  workerId?: string;
  claimToken?: string;
  claimedAt?: string;
  route?: unknown;
  resultHash?: string;
  files: string[];
  failureCategory?: FailureCategory;
  cancelExternalState?: "none" | "uncertain";
}
