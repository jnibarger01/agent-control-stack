import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TASK_CLASSES } from "../harness/routing.js";
import {
  MAX_CORPUS_TASKS,
  MIN_CORPUS_TASKS,
  TASK_LIMITS,
  EvalTaskValidationError,
  loadEvalTaskCorpus,
  parseEvalTask,
  type EvalTask
} from "./task-schema.js";

const validTask = (id = "valid-task"): EvalTask => ({
  id,
  taskClass: "classifier",
  input: "Classify this bounded request.",
  context: {
    facts: ["The request is read-only."],
    constraints: ["Return only the classification and reason."]
  },
  rubric: [
    { id: "label", description: "Returns a label.", expected: "The label is low." },
    { id: "reason", description: "Explains the label.", expected: "The reason cites read-only scope." },
    { id: "format", description: "Uses the requested format.", expected: "No extra fields are present." }
  ],
  reference: { kind: "exact", content: "low: read-only request" },
  tokenEstimate: { inputTokens: 120, outputTokens: 40 }
});

function temporaryCorpus(): string {
  const root = resolve("runs/artifacts");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, "task-schema-test-"));
}

describe("phase-5 task schema", () => {
  it("loads the real fixed corpus and proves its cross-file invariants", () => {
    const tasks = loadEvalTaskCorpus(new URL("./tasks/", import.meta.url));

    expect(tasks).toHaveLength(10);
    expect(tasks.length).toBeGreaterThanOrEqual(MIN_CORPUS_TASKS);
    expect(tasks.length).toBeLessThanOrEqual(MAX_CORPUS_TASKS);
    expect(new Set(tasks.map((task) => task.id)).size).toBe(tasks.length);
    expect(new Set(tasks.map((task) => task.taskClass))).toEqual(new Set(TASK_CLASSES));

    for (const task of tasks) {
      expect(task.rubric.length).toBeGreaterThanOrEqual(3);
      expect(task.rubric.length).toBeLessThanOrEqual(7);
      expect(new Set(task.rubric.map((criterion) => criterion.id)).size).toBe(task.rubric.length);
      expect(task.context.facts.length).toBeLessThanOrEqual(TASK_LIMITS.contextItems);
      expect(task.context.constraints.length).toBeLessThanOrEqual(TASK_LIMITS.contextItems);
      expect(task.tokenEstimate.inputTokens).toBeGreaterThan(0);
      expect(task.tokenEstimate.outputTokens).toBeGreaterThan(0);
    }
  });

  it("rejects unknown fields, unknown task classes, and non-binary rubric sizes", () => {
    expect(() => parseEvalTask({ ...validTask(), surprise: true })).toThrow(/unknown field/);
    expect(() => parseEvalTask({ ...validTask(), taskClass: "unknown" })).toThrow(/unknown task class/);
    expect(() => parseEvalTask({ ...validTask(), rubric: validTask().rubric.slice(0, 2) })).toThrow(
      /3-7 binary criteria/
    );
  });

  it("rejects duplicate criterion ids and unsafe token estimates", () => {
    const duplicate = validTask();
    duplicate.rubric[1] = { ...duplicate.rubric[1]!, id: duplicate.rubric[0]!.id };
    expect(() => parseEvalTask(duplicate)).toThrow(/duplicate criterion id/);
    expect(() =>
      parseEvalTask({ ...validTask(), tokenEstimate: { inputTokens: -1, outputTokens: 10 } })
    ).toThrow(/inputTokens/);
  });

  it("fails closed on malformed JSON and unexpected corpus entries", () => {
    const directory = temporaryCorpus();
    try {
      for (let index = 0; index < MIN_CORPUS_TASKS; index += 1) {
        const id = `task-${index}`;
        writeFileSync(join(directory, `${id}.json`), JSON.stringify(validTask(id)));
      }
      writeFileSync(join(directory, "notes.txt"), "not a task");
      expect(() => loadEvalTaskCorpus(directory)).toThrow(/only regular \.json files/);
      rmSync(join(directory, "notes.txt"));
      writeFileSync(join(directory, "task-0.json"), "{");
      expect(() => loadEvalTaskCorpus(directory)).toThrow(/invalid JSON/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("enforces corpus size, filename identity, and task-id uniqueness", () => {
    const directory = temporaryCorpus();
    try {
      writeFileSync(join(directory, "wrong-name.json"), JSON.stringify(validTask("right-name")));
      for (let index = 1; index < MIN_CORPUS_TASKS; index += 1) {
        const id = `task-${index}`;
        writeFileSync(join(directory, `${id}.json`), JSON.stringify(validTask(id)));
      }
      expect(() => loadEvalTaskCorpus(directory)).toThrow(/filename must match stable task id/);

      rmSync(join(directory, "wrong-name.json"));
      expect(() => loadEvalTaskCorpus(directory)).toThrow(/expected 10-20 tasks, found 9/);

      for (let index = 0; index < MIN_CORPUS_TASKS; index += 1) {
        const fileId = `unique-file-${index}`;
        writeFileSync(join(directory, `${fileId}.json`), JSON.stringify(validTask("duplicate-task")));
      }
      expect(() => loadEvalTaskCorpus(directory)).toThrow(EvalTaskValidationError);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
