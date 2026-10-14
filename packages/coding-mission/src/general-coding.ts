import { isAbsolute, posix, resolve } from "node:path";
import { ControlStackError } from "@agent-control-stack/shared";
import { parseWorkUnitPayload } from "./mission-model.js";

/**
 * The execution contract of a coding unit in a `general` mission.
 *
 * A general-mission coding unit is one explicit, repository-scoped task. It does not inherit a coding mission's branch,
 * pull request or merge lifecycle; that belongs to `CodingMissionController`. Everything an executor may act on is named
 * here and re-checked at the execution boundary:
 *
 *   authority scope  contains  repository  contains  files (declared paths)  contains  the executor's reported output
 *
 * with the base revision pinned to an immutable commit that the executor attests it ran against.
 */
export interface GeneralCodingTask {
  /** Canonical absolute path of the repository checkout root. Must lie inside a scope resource of the unit's authority. */
  repository: string;
  /** Immutable 40-hex commit the task is based on. A branch name is never accepted. */
  baseSha: string;
  instructions: string;
  /** Repository-relative paths (files or directories) the task may change. Nothing outside them is acceptable output. */
  files: string[];
  /** The task's own runtime bound. It may not exceed the unit authority's `maxRuntimeMs`. */
  maxRuntimeMs: number;
  /** The most files the task may report as changed. */
  maxFiles: number;
}

function invalid(reason: string): never {
  throw new ControlStackError("general_coding_task_invalid", `general coding task ${reason}`);
}

/** A repository-relative path in normal form: no absolute prefix, no `.` or `..` segment, no doubled or trailing slash. */
export function isNormalRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    path !== "." &&
    path !== ".." &&
    !path.startsWith("../") &&
    posix.normalize(path) === path &&
    !path.endsWith("/")
  );
}

/**
 * The strict form of a `coding` work-unit payload. The generic payload parser leaves the contract fields optional so
 * legacy coding payloads keep working; a governed general-mission coding unit must carry all of them.
 */
export function parseGeneralCodingTask(payload: unknown): GeneralCodingTask {
  if (!payload || typeof payload !== "object" || (payload as { kind?: unknown }).kind !== "coding") {
    return invalid("requires a coding payload");
  }
  let parsed: ReturnType<typeof parseWorkUnitPayload>;
  try {
    parsed = parseWorkUnitPayload("coding", payload);
  } catch {
    return invalid("has an invalid payload");
  }
  if (parsed.kind !== "coding") return invalid("requires a coding payload");
  const { repository, baseSha, instructions, files, maxRuntimeMs, maxFiles } = parsed;
  if (repository === undefined) return invalid("requires repository");
  if (!isAbsolute(repository) || resolve(repository) !== repository) {
    return invalid("repository must be a canonical absolute path");
  }
  if (baseSha === undefined) return invalid("requires baseSha");
  if (instructions === undefined || instructions.trim() === "") return invalid("requires instructions");
  if (files === undefined || files.length === 0) return invalid("requires files");
  if (!files.every(isNormalRelativePath)) return invalid("files must be normal repository-relative paths");
  if (maxRuntimeMs === undefined) return invalid("requires maxRuntimeMs");
  if (maxFiles === undefined) return invalid("requires maxFiles");
  return { repository, baseSha, instructions, files: [...files], maxRuntimeMs, maxFiles };
}
