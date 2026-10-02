import type { DecisionState } from "@agent-control-stack/mission-state";
import { z } from "zod";
import { buildDecisionReceipt, type DecisionReceipt } from "./receipts.js";
import {
  decisionAnswerSchema,
  decisionQuestionSchema,
  type DecisionAnswer,
  type DecisionQuestion,
  type DecisionType
} from "./schemas.js";
import { confidenceThreshold, relevanceKeep, type ConfidenceThresholds } from "./thresholds.js";

export class DecisionParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionParseError";
  }
}

export class DecisionAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionAuthorityError";
  }
}

/** Transport or model failure. Callers escalate. This is not a selection. */
export class DecisionModelUnavailable extends Error {
  readonly code = "model_unavailable" as const;

  constructor(message = "decision model unavailable") {
    super(message);
    this.name = "DecisionModelUnavailable";
  }
}

const ANSWER_KEYS = new Set(["id", "choice", "value", "score", "semanticRisk", "confidence", "sideEffectClass"]);

export type NimbleDecisionModel = {
  readonly id: "nimble";
  readonly version: string;
  answer(input: {
    readonly questions: readonly DecisionQuestion[];
    readonly state: DecisionState;
  }): Promise<unknown> | unknown;
};

export type ParsedDecision =
  | {
      readonly id: string;
      readonly type: "route";
      readonly choice: string;
      readonly confidence: number | null;
    }
  | {
      readonly id: string;
      readonly type: "next_operation";
      readonly choice: string;
      readonly confidence: number | null;
    }
  | {
      readonly id: string;
      readonly type: "done";
      readonly value: boolean;
      readonly confidence: number | null;
    }
  | {
      readonly id: string;
      readonly type: "relevance";
      readonly evidenceId: string;
      readonly score: number;
      readonly keep: boolean;
      readonly confidence: number | null;
    }
  | {
      readonly id: string;
      readonly type: "risk";
      readonly sideEffectClass: string;
      readonly semanticRisk: number;
      readonly confidence: number | null;
    };

export type DecidedAnswer = {
  readonly status: "accepted" | "below_threshold";
  readonly parsed: ParsedDecision;
  readonly receipt: DecisionReceipt;
  readonly threshold: number;
};

export type DecidedBatch = {
  readonly model: "nimble";
  readonly modelVersion: string;
  readonly answers: readonly DecidedAnswer[];
};

function uniqueIds(ids: readonly string[], label: string): void {
  if (new Set(ids).size !== ids.length) {
    throw new DecisionParseError(`duplicate ${label}`);
  }
}

function readQuestions(input: unknown): DecisionQuestion[] {
  const questions = z.array(decisionQuestionSchema).min(1).parse(input);
  uniqueIds(
    questions.map((question) => question.id),
    "question id"
  );
  for (const question of questions) {
    if (question.type === "route" || question.type === "next_operation") {
      uniqueIds(question.options, `${question.type} option`);
    }
  }
  return questions;
}

const unitInterval = z.number().min(0).max(1);

function assertAnswerObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DecisionParseError("answer must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ANSWER_KEYS.has(key)) {
      throw new DecisionParseError(`answer field rejected: ${key}`);
    }
  }
  return record;
}

function bareConfidence(value: unknown): number | null {
  if (value === undefined) return null;
  return unitInterval.parse(value);
}

function parseTiny(question: DecisionQuestion, raw: string | boolean | number): ParsedDecision {
  if (question.type === "route" && typeof raw === "string") {
    if (!question.options.includes(raw)) throw new DecisionParseError("choice outside options");
    return { id: question.id, type: "route", choice: raw, confidence: null };
  }
  if (question.type === "next_operation" && typeof raw === "string") {
    if (!question.options.includes(raw)) throw new DecisionParseError("choice outside options");
    return { id: question.id, type: "next_operation", choice: raw, confidence: null };
  }
  if (question.type === "done" && (raw === true || raw === false || raw === "true" || raw === "false")) {
    return { id: question.id, type: "done", value: raw === true || raw === "true", confidence: null };
  }
  if (question.type === "relevance" && typeof raw === "number") {
    const score = unitInterval.parse(raw);
    return {
      id: question.id,
      type: "relevance",
      evidenceId: question.evidenceId,
      score,
      keep: relevanceKeep(score),
      confidence: null
    };
  }
  if (question.type === "risk" && typeof raw === "number") {
    const semanticRisk = unitInterval.parse(raw);
    return {
      id: question.id,
      type: "risk",
      sideEffectClass: question.sideEffectClass,
      semanticRisk,
      confidence: null
    };
  }
  throw new DecisionParseError("choice outside options");
}

function parseFields(question: DecisionQuestion, answer: DecisionAnswer): ParsedDecision {
  const confidence = bareConfidence(answer.confidence);
  if (question.type === "route" || question.type === "next_operation") {
    if (answer.choice === undefined) throw new DecisionParseError("choice required");
    if (!question.options.includes(answer.choice)) throw new DecisionParseError("choice outside options");
    if (answer.value !== undefined || answer.score !== undefined || answer.semanticRisk !== undefined) {
      throw new DecisionParseError(`answer field rejected for ${question.type}`);
    }
    return question.type === "route"
      ? { id: question.id, type: "route", choice: answer.choice, confidence }
      : { id: question.id, type: "next_operation", choice: answer.choice, confidence };
  }
  if (question.type === "done") {
    if (answer.value === undefined) throw new DecisionParseError("done value required");
    if (answer.choice !== undefined || answer.score !== undefined || answer.semanticRisk !== undefined) {
      throw new DecisionParseError("answer field rejected for done");
    }
    return { id: question.id, type: "done", value: answer.value, confidence };
  }
  if (question.type === "relevance") {
    if (answer.score === undefined) throw new DecisionParseError("relevance score required");
    return {
      id: question.id,
      type: "relevance",
      evidenceId: question.evidenceId,
      score: answer.score,
      keep: relevanceKeep(answer.score),
      confidence
    };
  }
  if (answer.semanticRisk === undefined) throw new DecisionParseError("semantic risk required");
  if (answer.sideEffectClass !== undefined && answer.sideEffectClass !== question.sideEffectClass) {
    throw new DecisionParseError("side effect class is assigned by code");
  }
  return {
    id: question.id,
    type: "risk",
    sideEffectClass: question.sideEffectClass,
    semanticRisk: answer.semanticRisk,
    confidence
  };
}

function answersFromResponse(questions: readonly DecisionQuestion[], response: unknown): unknown[] {
  if (Array.isArray(response)) return response;
  if (typeof response === "string" || typeof response === "boolean" || typeof response === "number") {
    if (questions.length !== 1) throw new DecisionParseError("bare answer requires one question");
    return [response];
  }
  if (response === null || typeof response !== "object") {
    throw new DecisionParseError("answer must be an object");
  }
  const record = response as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "answers") throw new DecisionParseError(`answer field rejected: ${key}`);
  }
  if (!Array.isArray(record.answers)) throw new DecisionParseError("answers required");
  return record.answers;
}

export function parseDecisionBatch(questionsInput: unknown, response: unknown): ParsedDecision[] {
  const questions = readQuestions(questionsInput);
  const rawAnswers = answersFromResponse(questions, response);
  for (const raw of rawAnswers) {
    if (typeof raw === "string" || typeof raw === "boolean" || typeof raw === "number") continue;
    assertAnswerObject(raw);
  }
  if (rawAnswers.length !== questions.length) {
    throw new DecisionParseError("answer count must match questions");
  }
  const questionsById = new Map(questions.map((question) => [question.id, question]));
  const parsed = rawAnswers.map((raw, index) => {
    if (typeof raw === "string" || typeof raw === "boolean" || typeof raw === "number") {
      const question = questions[index];
      if (question === undefined) throw new DecisionParseError("missing answer");
      return parseTiny(question, raw);
    }
    const record = assertAnswerObject(raw);
    const answer = decisionAnswerSchema.parse(record);
    const question = questionsById.get(answer.id);
    if (question === undefined) throw new DecisionParseError(`missing answer for ${answer.id}`);
    return parseFields(question, answer);
  });
  const byId = new Map(parsed.map((answer) => [answer.id, answer]));
  if (byId.size !== parsed.length) throw new DecisionParseError("duplicate answer id");
  return questions.map((question) => {
    const answer = byId.get(question.id);
    if (answer === undefined) throw new DecisionParseError("missing answer");
    return answer;
  });
}

function selectedId(parsed: ParsedDecision): string | null {
  if (parsed.type === "route" || parsed.type === "next_operation") return parsed.choice;
  if (parsed.type === "done") return parsed.value ? "true" : "false";
  if (parsed.type === "relevance") return parsed.evidenceId;
  return parsed.sideEffectClass;
}

function payload(parsed: ParsedDecision): Readonly<Record<string, unknown>> {
  if (parsed.type === "relevance") return { score: parsed.score, keep: parsed.keep };
  if (parsed.type === "risk") return { semanticRisk: parsed.semanticRisk, sideEffectClass: parsed.sideEffectClass };
  if (parsed.type === "done") return { value: parsed.value };
  return { choice: parsed.choice };
}

function questionById(questions: readonly DecisionQuestion[], id: string): DecisionQuestion {
  const question = questions.find((entry) => entry.id === id);
  if (question === undefined) throw new DecisionParseError("missing answer");
  return question;
}

export function decideParsed(input: {
  readonly questions: readonly DecisionQuestion[];
  readonly parsed: readonly ParsedDecision[];
  readonly state: DecisionState;
  readonly modelVersion: string;
  readonly createdAt: string;
  readonly thresholds?: Partial<ConfidenceThresholds>;
}): DecidedAnswer[] {
  return input.parsed.map((parsed) => {
    const question = questionById(input.questions, parsed.id);
    const threshold = confidenceThreshold(parsed.type, input.thresholds);
    const confidence = parsed.confidence ?? 0;
    const receipt = buildDecisionReceipt({
      missionId: input.state.missionId,
      question,
      selectedId: selectedId(parsed),
      confidence,
      threshold,
      state: input.state,
      modelVersion: input.modelVersion,
      createdAt: input.createdAt,
      payload: payload(parsed)
    });
    const status = parsed.confidence === null || parsed.confidence < threshold ? "below_threshold" : "accepted";
    return { status, parsed, receipt, threshold };
  });
}

export async function decide(input: {
  readonly model: NimbleDecisionModel;
  readonly questions: readonly DecisionQuestion[];
  readonly state: DecisionState;
  readonly createdAt: string;
  readonly thresholds?: Partial<ConfidenceThresholds>;
}): Promise<DecidedBatch> {
  if (input.model.id !== "nimble") {
    throw new DecisionAuthorityError("decision authority must be nimble");
  }
  const questions = readQuestions(input.questions);
  const response = await input.model.answer({ questions, state: input.state });
  const parsed = parseDecisionBatch(questions, response);
  return {
    model: "nimble",
    modelVersion: input.model.version,
    answers: decideParsed({
      questions,
      parsed,
      state: input.state,
      modelVersion: input.model.version,
      createdAt: input.createdAt,
      thresholds: input.thresholds
    })
  };
}

export function isDecisionType(value: string): value is DecisionType {
  return value === "route" || value === "next_operation" || value === "relevance" || value === "done" || value === "risk";
}
