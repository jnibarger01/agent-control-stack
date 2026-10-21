import { ZodError } from "zod";
import { PR_READINESS_FLOOR, RESERVED_CRITERION_KINDS, criterionSchema, type Criterion } from "./domain.js";

export class CriteriaError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "CriteriaError";
  }
}

/** The default objective: "get this pull request production-ready", expressed as typed, machine-evaluable criteria. */
export function templatePrProductionReady(): Criterion[] {
  return [
    { id: "pr_open", kind: "pr_open", required: true },
    { id: "merge_gate", kind: "merge_gate_eligible", required: true, policy: "assessment" },
    { id: "verification_surface", kind: "verification_surface_untouched", required: true }
  ];
}

/**
 * Strict parse. Unknown or reserved kinds, unknown fields, duplicate ids and a missing readiness floor are all refused,
 * so a custom criteria file such as one that only checks "the pull request is open" can never yield a PASS.
 */
export function parseCriteria(raw: readonly unknown[]): Criterion[] {
  const parsed: Criterion[] = [];
  for (const entry of raw) {
    const kind = (entry as { kind?: unknown } | null)?.kind;
    if (typeof kind === "string" && RESERVED_CRITERION_KINDS.includes(kind)) {
      throw new CriteriaError(
        "criterion_kind_reserved",
        `criterion kind ${kind} is reserved and not accepted in this release`
      );
    }
    try {
      parsed.push(criterionSchema.parse(entry));
    } catch (error) {
      if (error instanceof ZodError) {
        const where = error.issues
          .slice(0, 3)
          .map((issue) => issue.path.join(".") || "criterion")
          .join(", ");
        throw new CriteriaError("criterion_invalid", `invalid criterion (${where})`);
      }
      throw error;
    }
  }
  const ids = parsed.map((criterion) => criterion.id);
  if (new Set(ids).size !== ids.length)
    throw new CriteriaError("criterion_duplicate_id", "criterion ids must be unique");
  assertReadinessFloor(parsed);
  return parsed;
}

export function hasReadinessFloor(criteria: ReadonlyArray<{ kind: string; required: boolean }>): boolean {
  return PR_READINESS_FLOOR.every((floor) =>
    criteria.some((criterion) => criterion.kind === floor.kind && criterion.required)
  );
}

export function assertReadinessFloor(criteria: ReadonlyArray<{ kind: string; required: boolean }>): void {
  if (!hasReadinessFloor(criteria)) {
    throw new CriteriaError(
      "readiness_floor_missing",
      `readiness floor: criteria must include required ${PR_READINESS_FLOOR.map((floor) => floor.kind).join(" and ")}`
    );
  }
}
