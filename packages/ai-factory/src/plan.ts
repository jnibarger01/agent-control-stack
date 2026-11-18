import { createHash } from "node:crypto";

/** F0 is proposal-only. Authentication, admission, leases and execution belong to ACS. */
export const FACTORY_INTENT_VERSION = "acs.ai-factory.intent.v1" as const;
export const FACTORY_PROPOSAL_VERSION = "acs.ai-factory.proposal.v1" as const;

export interface FactoryIntent {
  readonly schemaVersion: typeof FACTORY_INTENT_VERSION;
  readonly orderId: string;
  readonly objective: string;
  readonly repository: string;
  readonly baseSha: string;
  readonly acceptanceCriteria: readonly string[];
  readonly permittedPaths: readonly string[];
  readonly forbiddenPaths: readonly string[];
  readonly budget: Readonly<{ maxLanes: number; maxWallClockMs: number; maxSpendMicrousd: number }>;
  readonly delivery: Readonly<{ mode: "draft_pr" }>;
}

export interface FactoryProposal {
  readonly schemaVersion: typeof FACTORY_PROPOSAL_VERSION;
  readonly intentHash: string;
  readonly intent: FactoryIntent;
  readonly executionMode: "proposal_only";
  readonly authority: "none";
  readonly requestedEngine: "codex-swarm";
  readonly delivery: "draft_pr";
}

export class FactoryIntentError extends Error {
  readonly code = "invalid_factory_intent";
  constructor(readonly field: string, reason: string) {
    super("Invalid factory intent at " + field + ": " + reason);
    this.name = "FactoryIntentError";
  }
}

function object(input: unknown, field: string, fields: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new FactoryIntentError(field, "expected a plain object");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new FactoryIntentError(field, "expected a plain object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Object.keys(descriptors);
  if (Reflect.ownKeys(descriptors).length !== fields.length || keys.some((key) => !fields.includes(key))) {
    throw new FactoryIntentError(field, "unknown or missing field");
  }
  if (keys.some((key) => !Object.hasOwn(descriptors[key]!, "value"))) {
    throw new FactoryIntentError(field, "accessor field is forbidden");
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
}

function boundedText(input: unknown, field: string, min: number, max: number): string {
  if (typeof input !== "string" || input.length < min || input.length > max ||
      input !== input.trim() || Array.from(input).some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) {
    throw new FactoryIntentError(field, "invalid bounded text");
  }
  return input;
}

function safeInteger(input: unknown, field: string, min: number, max: number): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < min || input > max) {
    throw new FactoryIntentError(field, "expected bounded safe integer");
  }
  return input;
}

function list(
  input: unknown,
  field: string,
  min: number,
  max: number,
  parse: (value: unknown, field: string) => string
): string[] {
  if (!Array.isArray(input) || input.length < min || input.length > max) {
    throw new FactoryIntentError(field, "invalid list length");
  }
  for (const index of input.keys()) {
    if (!Object.hasOwn(input, index)) throw new FactoryIntentError(field, "sparse lists are forbidden");
  }
  const result = input.map((value: unknown, index: number) => parse(value, field + "[" + index + "]"));
  if (new Set(result).size !== result.length) throw new FactoryIntentError(field, "duplicate values");
  return result;
}

function path(input: unknown, field: string): string {
  const value = boundedText(input, field, 1, 512);
  // Lexical validation is not realpath containment or a replacement for host sandboxing.
  if (!/^[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)*$/u.test(value) ||
      value.split("/").some((s) => s === "." || s === ".." || s.toLowerCase() === ".git")) {
    throw new FactoryIntentError(field, "expected a relative literal POSIX path outside .git");
  }
  return value;
}

export function parseFactoryIntent(input: unknown): FactoryIntent {
  const a = object(input, "intent", [
    "schemaVersion", "orderId", "objective", "repository", "baseSha",
    "acceptanceCriteria", "permittedPaths", "forbiddenPaths", "budget", "delivery"
  ]);
  if (a.schemaVersion !== FACTORY_INTENT_VERSION) throw new FactoryIntentError("schemaVersion", "unsupported version");
  const orderId = boundedText(a.orderId, "orderId", 1, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(orderId)) throw new FactoryIntentError("orderId", "invalid identifier");
  const repository = boundedText(a.repository, "repository", 3, 201);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u.test(repository)) {
    throw new FactoryIntentError("repository", "expected GitHub owner/name");
  }
  const baseSha = boundedText(a.baseSha, "baseSha", 40, 40);
  if (!/^[a-f0-9]{40}$/u.test(baseSha)) throw new FactoryIntentError("baseSha", "expected lowercase full SHA");
  const b = object(a.budget, "budget", ["maxLanes", "maxWallClockMs", "maxSpendMicrousd"]);
  const delivery = object(a.delivery, "delivery", ["mode"]);
  if (delivery.mode !== "draft_pr") throw new FactoryIntentError("delivery.mode", "draft PR only");
  return {
    schemaVersion: FACTORY_INTENT_VERSION,
    orderId,
    objective: boundedText(a.objective, "objective", 8, 8_000),
    repository,
    baseSha,
    acceptanceCriteria: list(a.acceptanceCriteria, "acceptanceCriteria", 1, 20, (v, f) => boundedText(v, f, 6, 600)),
    permittedPaths: list(a.permittedPaths, "permittedPaths", 1, 64, path),
    forbiddenPaths: list(a.forbiddenPaths, "forbiddenPaths", 0, 64, path),
    budget: {
      maxLanes: safeInteger(b.maxLanes, "budget.maxLanes", 1, 8),
      maxWallClockMs: safeInteger(b.maxWallClockMs, "budget.maxWallClockMs", 1_000, 86_400_000),
      maxSpendMicrousd: safeInteger(b.maxSpendMicrousd, "budget.maxSpendMicrousd", 0, 1_000_000_000)
    },
    delivery: { mode: "draft_pr" }
  };
}

/** Hash is an equality token, not an HMAC, grant, permission or identity assertion. */
export function createFactoryProposal(input: unknown): FactoryProposal {
  const intent = parseFactoryIntent(input);
  const intentHash = createHash("sha256")
    .update("acs:ai-factory-intent:v1\n", "utf8")
    .update(JSON.stringify(intent), "utf8")
    .digest("hex");
  return {
    schemaVersion: FACTORY_PROPOSAL_VERSION,
    intentHash,
    intent,
    executionMode: "proposal_only",
    authority: "none",
    requestedEngine: "codex-swarm",
    delivery: "draft_pr"
  };
}

