import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TASK_CLASSES, type TaskClass } from "../harness/routing.js";

export const MIN_CORPUS_TASKS = 10;
export const MAX_CORPUS_TASKS = 20;

export const TASK_LIMITS = Object.freeze({
  fileBytes: 32_768,
  idCharacters: 64,
  inputCharacters: 2_000,
  contextItems: 8,
  contextItemCharacters: 400,
  criterionIdCharacters: 48,
  criterionDescriptionCharacters: 300,
  criterionExpectedCharacters: 300,
  referenceCharacters: 2_000,
  maxInputTokens: 20_000,
  maxOutputTokens: 10_000
});

export interface EvalCriterion {
  id: string;
  description: string;
  expected: string;
}

export interface EvalTaskContext {
  facts: string[];
  constraints: string[];
}

export interface EvalTaskReference {
  kind: "exact" | "example" | "rules";
  content: string;
}

export interface EvalTokenEstimate {
  inputTokens: number;
  outputTokens: number;
}

export interface EvalTask {
  id: string;
  taskClass: TaskClass;
  input: string;
  context: EvalTaskContext;
  rubric: EvalCriterion[];
  reference?: EvalTaskReference;
  tokenEstimate: EvalTokenEstimate;
}

export class EvalTaskValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalTaskValidationError";
  }
}

export function parseEvalTask(value: unknown, source = "task"): EvalTask {
  const task = exactRecord(
    value,
    source,
    ["id", "taskClass", "input", "context", "rubric", "tokenEstimate"],
    ["reference"]
  );

  const id = slug(task.id, `${source}.id`, TASK_LIMITS.idCharacters);
  const taskClass = parseTaskClass(task.taskClass, `${source}.taskClass`);
  const input = boundedText(task.input, `${source}.input`, TASK_LIMITS.inputCharacters);
  const context = parseContext(task.context, `${source}.context`);
  const rubric = parseRubric(task.rubric, `${source}.rubric`);
  const reference = task.reference === undefined ? undefined : parseReference(task.reference, `${source}.reference`);
  const tokenEstimate = parseTokenEstimate(task.tokenEstimate, `${source}.tokenEstimate`);

  return {
    id,
    taskClass,
    input,
    context,
    rubric,
    ...(reference === undefined ? {} : { reference }),
    tokenEstimate
  };
}

export function loadEvalTaskFile(path: string | URL): EvalTask {
  const filePath = resolvePath(path);
  if (extname(filePath) !== ".json") {
    fail(`${filePath}: task files must use the .json extension`);
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    fail(`${filePath}: cannot read task file: ${errorMessage(error)}`);
  }
  if (Buffer.byteLength(raw, "utf8") > TASK_LIMITS.fileBytes) {
    fail(`${filePath}: task file exceeds ${TASK_LIMITS.fileBytes} bytes`);
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    fail(`${filePath}: invalid JSON: ${errorMessage(error)}`);
  }

  const task = parseEvalTask(value, filePath);
  const expectedFileName = `${task.id}.json`;
  if (basename(filePath) !== expectedFileName) {
    fail(`${filePath}: filename must match stable task id (${expectedFileName})`);
  }
  return task;
}

export function loadEvalTaskCorpus(
  directory: string | URL = new URL("./tasks/", import.meta.url)
): readonly EvalTask[] {
  const directoryPath = resolvePath(directory);
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(directoryPath, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    fail(`${directoryPath}: cannot read task corpus: ${errorMessage(error)}`);
  }

  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name) !== ".json") {
      fail(`${join(directoryPath, entry.name)}: unexpected corpus entry; only regular .json files are allowed`);
    }
  }

  const files = entries.map((entry) => entry.name).sort();
  if (files.length < MIN_CORPUS_TASKS || files.length > MAX_CORPUS_TASKS) {
    fail(
      `${directoryPath}: expected ${MIN_CORPUS_TASKS}-${MAX_CORPUS_TASKS} tasks, found ${files.length}`
    );
  }

  const tasks = files.map((file) => loadEvalTaskFile(join(directoryPath, file)));
  unique(tasks.map((task) => task.id), `${directoryPath}: duplicate task id`);
  return Object.freeze(tasks);
}

function parseContext(value: unknown, path: string): EvalTaskContext {
  const context = exactRecord(value, path, ["facts", "constraints"]);
  return {
    facts: boundedTextArray(context.facts, `${path}.facts`, 1),
    constraints: boundedTextArray(context.constraints, `${path}.constraints`, 1)
  };
}

function parseRubric(value: unknown, path: string): EvalCriterion[] {
  if (!Array.isArray(value) || value.length < 3 || value.length > 7) {
    fail(`${path}: expected 3-7 binary criteria`);
  }
  const criteria = value.map((candidate, index) => {
    const criterionPath = `${path}[${index}]`;
    const criterion = exactRecord(candidate, criterionPath, ["id", "description", "expected"]);
    return {
      id: slug(criterion.id, `${criterionPath}.id`, TASK_LIMITS.criterionIdCharacters),
      description: boundedText(
        criterion.description,
        `${criterionPath}.description`,
        TASK_LIMITS.criterionDescriptionCharacters
      ),
      expected: boundedText(
        criterion.expected,
        `${criterionPath}.expected`,
        TASK_LIMITS.criterionExpectedCharacters
      )
    };
  });
  unique(criteria.map((criterion) => criterion.id), `${path}: duplicate criterion id`);
  return criteria;
}

function parseReference(value: unknown, path: string): EvalTaskReference {
  const reference = exactRecord(value, path, ["kind", "content"]);
  const kind = boundedText(reference.kind, `${path}.kind`, 16);
  if (kind !== "exact" && kind !== "example" && kind !== "rules") {
    fail(`${path}.kind: expected exact, example, or rules`);
  }
  return {
    kind,
    content: boundedText(reference.content, `${path}.content`, TASK_LIMITS.referenceCharacters)
  };
}

function parseTokenEstimate(value: unknown, path: string): EvalTokenEstimate {
  const estimate = exactRecord(value, path, ["inputTokens", "outputTokens"]);
  return {
    inputTokens: positiveInteger(estimate.inputTokens, `${path}.inputTokens`, TASK_LIMITS.maxInputTokens),
    outputTokens: positiveInteger(estimate.outputTokens, `${path}.outputTokens`, TASK_LIMITS.maxOutputTokens)
  };
}

function parseTaskClass(value: unknown, path: string): TaskClass {
  const candidate = boundedText(value, path, 64);
  if (!(TASK_CLASSES as readonly string[]).includes(candidate)) {
    fail(`${path}: unknown task class ${candidate}`);
  }
  return candidate as TaskClass;
}

function boundedTextArray(value: unknown, path: string, minimum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > TASK_LIMITS.contextItems) {
    fail(`${path}: expected ${minimum}-${TASK_LIMITS.contextItems} items`);
  }
  return value.map((item, index) =>
    boundedText(item, `${path}[${index}]`, TASK_LIMITS.contextItemCharacters)
  );
}

function exactRecord(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${path}: expected an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(`${path}.${key}: unknown field`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) fail(`${path}.${key}: missing required field`);
  }
  return record;
}

function boundedText(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > maximum) {
    fail(`${path}: expected non-empty trimmed text of at most ${maximum} characters`);
  }
  return value;
}

function slug(value: unknown, path: string, maximum: number): string {
  const candidate = boundedText(value, path, maximum);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate)) {
    fail(`${path}: expected a stable lowercase kebab-case id`);
  }
  return candidate;
}

function positiveInteger(value: unknown, path: string, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    fail(`${path}: expected an integer from 1 through ${maximum}`);
  }
  return value as number;
}

function unique(values: readonly string[], prefix: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) fail(`${prefix}: ${value}`);
    seen.add(value);
  }
}

function resolvePath(path: string | URL): string {
  return path instanceof URL ? fileURLToPath(path) : path;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(message: string): never {
  throw new EvalTaskValidationError(message);
}
