export type Origin = "cli" | "telegram" | "imessage" | "dashboard" | "openclaw" | "hermes" | "api";
export type TaskType = "coding" | "research" | "memory_lookup" | "browser_scrape" | "deal_analysis" | "system_admin" | "unknown";
export type RiskLevel = "read_only" | "draft" | "write" | "destructive";
export type NetworkMode = "none" | "declared" | "unrestricted";

export interface TaskEnvelope {
  schema_version: "1.0";
  task_id: string;
  goal: string;
  origin: Origin;
  task_type: TaskType;
  allowed_tools: string[];
  workspace: string;
  risk_level: RiskLevel;
  approval_required: boolean;
  success_criteria: string[];
  timeout_seconds: number;
  trace_required: boolean;
  rollback_required: boolean;
  network_access: NetworkMode;
  human_notes: string;
}

export interface EnvelopeValidation {
  ok: boolean;
  reasons: string[];
  envelope: Readonly<TaskEnvelope> | null;
}

export interface RiskPolicyResult {
  effective_risk: RiskLevel;
  approval_required: boolean;
  rollback_required: boolean;
  network_violation: boolean;
  reasons: string[];
}

export interface RouteDecision {
  ok: boolean;
  task_id: string | null;
  target: string | null;
  queued_for_approval: boolean;
  effective_risk: RiskLevel | null;
  approval_required: boolean;
  rollback_required: boolean;
  failure_code: string | null;
  reasons: string[];
}

export interface GateResult {
  promoted: boolean;
  failures: string[];
  remediation: string[];
  failure_code: string | null;
}

export interface TraceEvent {
  run_id: string;
  seq: number;
  ts: string;
  type: string;
  payload: Record<string, unknown>;
  redacted: boolean;
  prev_hash: string;
  hash: string;
}

export const ORIGINS: readonly Origin[];
export const TASK_TYPES: readonly TaskType[];
export const RISK_LEVELS: readonly RiskLevel[];
export const NETWORK_MODES: readonly NetworkMode[];
export const RISK_RANK: Readonly<Record<RiskLevel, number>>;
export const ROUTES: Readonly<Record<TaskType, string>>;
export const EVENT_TYPES: readonly string[];
export const GENESIS_HASH: string;
export const REQUIRED_GATES: readonly string[];
export const FAILURE_CODES: readonly string[];

export function validateEnvelope(input: unknown): EnvelopeValidation;
export function makeEnvelope(partial: Partial<TaskEnvelope>): TaskEnvelope;
export function applyRiskPolicy(envelope: TaskEnvelope): RiskPolicyResult;
export function classifyToolRisk(tool: string): RiskLevel;
export function route(input: unknown): RouteDecision;
export function evaluateGate(evidence: unknown): GateResult;
export function normalizeFailureCode(code: unknown): string;
export function isFailureCode(code: unknown): boolean;
export function redactSecrets(text: unknown): { text: string; redacted: boolean };
export function canonical(value: unknown): string;
export function sha256(value: string): string;
export function createTrace(
  run_id: string,
  options?: { sink?: ((event: TraceEvent) => void) | null; clock?: () => string }
): {
  append(type: string, payload?: Record<string, unknown>): TraceEvent;
  seal(): TraceEvent;
  readonly events: TraceEvent[];
  readonly head: string;
  readonly sealed: boolean;
};
export function verifyChain(events: TraceEvent[]): { ok: boolean; index: number; reason: string | null };
export function detectReplayDivergence(
  original: TraceEvent[],
  replay: TraceEvent[]
): { diverged: boolean; index: number; original: string | null; replay: string | null };
