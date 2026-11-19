import { createHash } from "node:crypto";
import { FactoryIntentError, boundedText, parseRelativePath, type FactoryIntent } from "./plan.js";

/**
 * F3: a planner may *suggest* a decomposition; ACS validates it here before any work unit exists.
 *
 * Pure. Validates exact shape, dependency closure, acyclicity, depth, per-layer fan-out against the
 * mission's parallelism budget, and path scope against the admitted intent (forbidden paths win on
 * any overlap). Produces an immutable digest that chains to the previous revision's digest.
 */
export const FACTORY_PLAN_VERSION = "acs.ai-factory.plan.v1" as const;
export const MAX_PLAN_UNITS = 64;
export const MAX_PLAN_DEPTH = 8;
export const MAX_PLAN_REVISION = 1_000;

export interface FactoryPlanUnit {
  readonly unitId: string;
  readonly title: string;
  readonly dependsOn: readonly string[];
  readonly paths: readonly string[];
}

export interface FactoryPlan {
  readonly schemaVersion: typeof FACTORY_PLAN_VERSION;
  readonly missionId: string;
  readonly revision: number;
  /** Null only for revision 1. Otherwise the digest of revision - 1: a stale planner cannot fork lineage. */
  readonly previousPlanDigest: string | null;
  readonly units: readonly FactoryPlanUnit[];
}

export interface ValidatedFactoryPlan {
  readonly plan: FactoryPlan;
  readonly planDigest: string;
  /** Units grouped by dependency layer, each sorted; layer i only depends on layers < i. */
  readonly layers: readonly (readonly string[])[];
  readonly depth: number;
  readonly maxFanOut: number;
}

export class FactoryPlanError extends Error {
  readonly code = "invalid_factory_plan";
  constructor(readonly field: string, reason: string) {
    super("Invalid factory plan at " + field + ": " + reason);
    this.name = "FactoryPlanError";
  }
}

const UNIT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

function exact(input: unknown, field: string, fields: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new FactoryPlanError(field, "expected a plain object");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new FactoryPlanError(field, "expected a plain object");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Object.keys(descriptors);
  if (Reflect.ownKeys(descriptors).length !== fields.length || keys.some((key) => !fields.includes(key))) {
    throw new FactoryPlanError(field, "unknown or missing field");
  }
  if (keys.some((key) => !Object.hasOwn(descriptors[key]!, "value"))) {
    throw new FactoryPlanError(field, "accessor field is forbidden");
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
}

function array(input: unknown, field: string, min: number, max: number): unknown[] {
  if (!Array.isArray(input) || input.length < min || input.length > max) {
    throw new FactoryPlanError(field, "invalid list length");
  }
  for (const index of input.keys()) {
    if (!Object.hasOwn(input, index)) throw new FactoryPlanError(field, "sparse lists are forbidden");
  }
  return input;
}

function wrap<T>(field: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof FactoryIntentError) throw new FactoryPlanError(field, error.message);
    throw error;
  }
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root + "/");
}

/** True when the two subtrees overlap in either direction. */
function overlaps(a: string, b: string): boolean {
  return within(a, b) || within(b, a);
}

export function parseFactoryPlan(
  input: unknown,
  context: { readonly missionId: string; readonly intent: FactoryIntent; readonly maxParallel: number }
): ValidatedFactoryPlan {
  if (!Number.isSafeInteger(context.maxParallel) || context.maxParallel < 1) {
    throw new FactoryPlanError("maxParallel", "mission parallelism must be a positive integer");
  }
  const a = exact(input, "plan", ["schemaVersion", "missionId", "revision", "previousPlanDigest", "units"]);
  if (a.schemaVersion !== FACTORY_PLAN_VERSION) throw new FactoryPlanError("schemaVersion", "unsupported version");
  if (a.missionId !== context.missionId) throw new FactoryPlanError("missionId", "plan is for another mission");
  const revision = a.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1 || revision > MAX_PLAN_REVISION) {
    throw new FactoryPlanError("revision", "expected 1.." + MAX_PLAN_REVISION);
  }
  const previous = a.previousPlanDigest;
  if (revision === 1 ? previous !== null : typeof previous !== "string" || !DIGEST.test(previous)) {
    throw new FactoryPlanError("previousPlanDigest", revision === 1 ? "must be null for revision 1" : "expected digest");
  }
  const rawUnits = array(a.units, "units", 1, MAX_PLAN_UNITS);
  const units: FactoryPlanUnit[] = rawUnits.map((raw, index) => {
    const field = "units[" + index + "]";
    const u = exact(raw, field, ["unitId", "title", "dependsOn", "paths"]);
    if (typeof u.unitId !== "string" || !UNIT_ID.test(u.unitId)) throw new FactoryPlanError(field + ".unitId", "invalid id");
    const title = wrap(field + ".title", () => boundedText(u.title, field + ".title", 3, 200));
    const dependsOn = array(u.dependsOn, field + ".dependsOn", 0, 16).map((dependency, i) => {
      if (typeof dependency !== "string" || !UNIT_ID.test(dependency)) {
        throw new FactoryPlanError(field + ".dependsOn[" + i + "]", "invalid id");
      }
      return dependency;
    });
    if (new Set(dependsOn).size !== dependsOn.length) throw new FactoryPlanError(field + ".dependsOn", "duplicate values");
    const paths = array(u.paths, field + ".paths", 1, 32).map((value, i) =>
      wrap(field + ".paths[" + i + "]", () => parseRelativePath(value, field + ".paths[" + i + "]"))
    );
    if (new Set(paths).size !== paths.length) throw new FactoryPlanError(field + ".paths", "duplicate values");
    for (const path of paths) {
      if (!context.intent.permittedPaths.some((root) => within(path, root))) {
        throw new FactoryPlanError(field + ".paths", "path is outside the admitted permitted paths");
      }
      // Forbidden wins on any overlap: a unit scoped to a parent of a forbidden subtree would reach it.
      if (context.intent.forbiddenPaths.some((forbidden) => overlaps(path, forbidden))) {
        throw new FactoryPlanError(field + ".paths", "path overlaps a forbidden path");
      }
    }
    return { unitId: u.unitId, title, dependsOn, paths };
  });

  const ids = new Set<string>();
  for (const unit of units) {
    if (ids.has(unit.unitId)) throw new FactoryPlanError("units", "duplicate unit id " + unit.unitId);
    ids.add(unit.unitId);
  }
  for (const unit of units) {
    for (const dependency of unit.dependsOn) {
      if (dependency === unit.unitId) throw new FactoryPlanError("units", "unit " + unit.unitId + " depends on itself");
      if (!ids.has(dependency)) throw new FactoryPlanError("units", "unknown dependency " + dependency);
    }
  }

  // Kahn layering: detects cycles and yields depth and per-layer fan-out in one pass.
  const remaining = new Map(units.map((unit) => [unit.unitId, new Set(unit.dependsOn)]));
  const layers: string[][] = [];
  const done = new Set<string>();
  while (remaining.size > 0) {
    const layer = [...remaining].filter(([, deps]) => [...deps].every((dep) => done.has(dep))).map(([id]) => id).sort();
    if (layer.length === 0) throw new FactoryPlanError("units", "dependencies contain a cycle");
    for (const id of layer) {
      remaining.delete(id);
      done.add(id);
    }
    layers.push(layer);
  }
  if (layers.length > MAX_PLAN_DEPTH) throw new FactoryPlanError("units", "dependency depth exceeds " + MAX_PLAN_DEPTH);
  const maxFanOut = Math.max(...layers.map((layer) => layer.length));
  if (maxFanOut > context.maxParallel) {
    throw new FactoryPlanError("units", "a layer of " + maxFanOut + " units exceeds mission parallelism " + context.maxParallel);
  }

  const plan: FactoryPlan = {
    schemaVersion: FACTORY_PLAN_VERSION,
    missionId: context.missionId,
    revision,
    previousPlanDigest: previous as string | null,
    units
  };
  return { plan, planDigest: factoryPlanDigest(plan), layers, depth: layers.length, maxFanOut };
}

/** Order-independent over units, dependencies and paths; any semantic change alters the digest. */
export function factoryPlanDigest(plan: FactoryPlan): string {
  const canonical = [...plan.units]
    .sort((x, y) => (x.unitId < y.unitId ? -1 : x.unitId > y.unitId ? 1 : 0))
    .map((unit) => [unit.unitId, unit.title, [...unit.dependsOn].sort(), [...unit.paths].sort()]);
  return createHash("sha256")
    .update("acs:ai-factory-plan:v1\n", "utf8")
    .update(JSON.stringify([plan.missionId, plan.revision, plan.previousPlanDigest, canonical]), "utf8")
    .digest("hex");
}
