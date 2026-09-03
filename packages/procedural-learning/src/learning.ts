import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { redactValue } from "@agent-control-stack/shared";
import {
  FIRST_CLASS_TARGETS,
  candidateStates,
  evaluateGates,
  generalizeText,
  jaccard,
  scoreExperience,
  skillContentSchema,
  slugifySkillName,
  stableLearningId,
  taskExperienceInputSchema,
  tokenize,
  type CandidateState,
  type GateResult,
  type ParsedTaskExperience,
  type RefinementOutcome,
  type ScoreBreakdown,
  type SkillContent,
  type TaskExperienceInput
} from "./schema.js";

export { FIRST_CLASS_TARGETS, type TaskExperienceInput } from "./schema.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS learning_experiences (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  UNIQUE(task_id, payload_hash)
);
CREATE TABLE IF NOT EXISTS learning_candidates (
  id TEXT PRIMARY KEY,
  experience_id TEXT NOT NULL UNIQUE,
  skill_name TEXT NOT NULL,
  state TEXT NOT NULL,
  score REAL NOT NULL,
  score_breakdown_json TEXT NOT NULL,
  gate_results_json TEXT NOT NULL,
  reject_reasons_json TEXT NOT NULL,
  draft_json TEXT,
  related_skill_id TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS learning_skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  current_version INTEGER NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS learning_skill_versions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(skill_id, version)
);
CREATE TABLE IF NOT EXISTS learning_skill_usages (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  skill_version INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  disposition TEXT NOT NULL,
  outcome TEXT,
  validation_passed INTEGER,
  shortened_investigation INTEGER,
  required_correction INTEGER,
  repository TEXT,
  refinement TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(skill_id, task_id, attempt_id, disposition)
);
CREATE TABLE IF NOT EXISTS learning_skill_metrics (
  skill_id TEXT PRIMARY KEY,
  uses INTEGER NOT NULL,
  successful_uses INTEGER NOT NULL,
  failed_uses INTEGER NOT NULL,
  repositories_json TEXT NOT NULL,
  last_success TEXT,
  last_failure TEXT,
  investigation_reduction_sum REAL NOT NULL,
  investigation_reduction_n INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS learning_targets (
  name TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  skill_id TEXT,
  updated_at TEXT NOT NULL
);
`;

export interface ExperienceRecord {
  id: string;
  taskId: string;
  capturedAt: string;
  input: ParsedTaskExperience;
}

export interface CandidateRecord {
  id: string;
  experienceId: string;
  state: CandidateState;
  score: number;
  scoreBreakdown: ScoreBreakdown;
  gateResults: GateResult[];
  rejectReasons: string[];
  relatedSkillId?: string;
}

export interface SkillProvenance {
  source: "verified_task" | "manual_ingest";
  taskId?: string;
  attemptId?: string;
  repository?: string;
  commitOrDiffId?: string;
  agent?: string;
  timestamp: string;
  problemSummary?: string;
  rootCause?: string;
  validationCommands?: string[];
  validationResults?: string[];
  promotionDecision?: CandidateState;
  previousVersion?: number;
  sourcePath?: string;
}

export interface PromotedSkill {
  id: string;
  name: string;
  version: number;
  status: "active" | "quarantined" | "deprecated";
  confidence: number;
  content: SkillContent;
  provenance: SkillProvenance;
}

export interface RecordExperienceOptions {
  pauseAfter?: CandidateState;
}

export interface RecordExperienceResult {
  experience: ExperienceRecord;
  candidate: CandidateRecord;
  skill?: PromotedSkill;
}

export interface RetrieveQuery {
  problemSummary: string;
  errorMessages?: string[];
  technologies?: string[];
  taskType?: string;
  repository?: string;
}

export interface RetrievedSkill {
  name: string;
  version: number;
  confidence: number;
  rankScore: number;
  content: SkillContent;
  authorization: "guidance_only";
}

export interface EngineeringBrief {
  skills: RetrievedSkill[];
  authorization: "guidance_only";
  approvedActions: [];
  deniedPrivileges: string[];
  policyNote: string;
}

export interface UsageInput {
  skillName: string;
  taskId: string;
  attemptId: string;
  disposition: "retrieved" | "selected" | "ignored" | "applied";
  outcome?: "success" | "failure" | "unknown";
  validationPassed?: boolean;
  shortenedInvestigation?: boolean;
  requiredCorrection?: boolean;
  repository?: string;
}

interface SkillRow {
  id: string;
  name: string;
  status: string;
  current_version: number;
  confidence: number;
}

/**
 * Authoritative evidence for a claimed task experience, looked up from the
 * control plane's own persisted records - never accepted as the caller's
 * self-report. When configured, recordTaskExperience uses this to override
 * TaskExperienceInput.completed/validation.passed before scoring: a
 * fabricated experience claiming a passing validation that never actually
 * ran, or for a work item/attempt that doesn't exist, cannot promote a
 * skill just because the input payload says so.
 */
export type TaskExperienceEvidenceVerifier = (input: { taskId: string; attemptId: string }) =>
  | { completed: boolean; validationPassed: boolean }
  | undefined;

export class ProceduralLearning {
  private readonly db: DatabaseSync;
  private readonly verifyEvidence: TaskExperienceEvidenceVerifier | undefined;

  constructor(dbPath: string, options: { verifyEvidence?: TaskExperienceEvidenceVerifier } = {}) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA_SQL);
    this.seedTargets();
    this.verifyEvidence = options.verifyEvidence;
  }

  close(): void {
    this.db.close();
  }

  recordTaskExperience(input: TaskExperienceInput, options: RecordExperienceOptions = {}): RecordExperienceResult {
    const parsed = taskExperienceInputSchema.parse(input);
    const secrets = [...parsed.explicitSecrets];
    const sanitized = sanitizeExperience(parsed, secrets);
    if (this.verifyEvidence) {
      // Authoritative evidence overrides the self-reported claim in both
      // directions: a caller cannot promote by claiming success the store
      // never recorded, and cannot be short-changed by a caller under-
      // reporting a real success either - but when no evidence exists at
      // all for this taskId/attemptId, fail closed rather than trust the
      // input.
      const evidence = this.verifyEvidence({ taskId: sanitized.taskId, attemptId: sanitized.attemptId });
      sanitized.completed = evidence?.completed ?? false;
      sanitized.validation = { ...sanitized.validation, passed: evidence?.validationPassed ?? false };
    }
    const payloadHash = experienceHash(sanitized);
    const experienceId = stableLearningId("exp", { taskId: sanitized.taskId, payloadHash });
    this.withImmediateTransaction(() => {
      this.upsertExperience(experienceId, sanitized, payloadHash);
      const existing = this.getCandidateByExperience(experienceId);
      if (!existing) {
        const score = scoreExperience(sanitized);
        const gates = evaluateGates(sanitized, score);
        const rejectReasons = gates.filter((gate) => !gate.passed).map((gate) => gate.detail);
        const eligible = rejectReasons.length === 0;
        this.insertCandidate({
          id: `cand_${experienceId.slice(4)}`,
          experienceId,
          skillName: slugifySkillName(sanitized.proposedSkillName),
          state: eligible ? "ELIGIBLE" : "REJECTED",
          score: score.promotion_score,
          scoreBreakdown: score,
          gateResults: gates,
          rejectReasons
        });
      }
    });
    return this.advancePromotion(experienceId, options.pauseAfter, secrets);
  }

  reconcilePromotion(experienceId: string): RecordExperienceResult {
    return this.advancePromotion(experienceId);
  }

  getExperience(experienceId: string): ExperienceRecord | undefined {
    const row = this.db
      .prepare(`SELECT id, task_id, payload_json, captured_at FROM learning_experiences WHERE id = ?`)
      .get(experienceId) as
      | { id: string; task_id: string; payload_json: string; captured_at: string }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      taskId: row.task_id,
      capturedAt: row.captured_at,
      input: JSON.parse(row.payload_json) as ParsedTaskExperience
    };
  }

  retrieveSkills(query: RetrieveQuery): RetrievedSkill[] {
    const ranked = this.rankSkills(query).filter((entry) => entry.skill.status === "active");
    return ranked.slice(0, 3).map((entry) => ({
      name: entry.skill.name,
      version: entry.skill.current_version,
      confidence: entry.skill.confidence,
      rankScore: entry.score,
      content: this.versionContent(entry.skill.id, entry.skill.current_version),
      authorization: "guidance_only"
    }));
  }

  prepareEngineeringWork(query: RetrieveQuery & { requestedPrivileges?: string[] }): EngineeringBrief {
    const skills = this.retrieveSkills(query);
    for (const skill of skills) {
      this.recordSkillUsage({
        skillName: skill.name,
        taskId: `retrieve:${stableLearningId("q", query)}`,
        attemptId: "retrieve",
        disposition: "retrieved"
      });
    }
    return {
      skills,
      authorization: "guidance_only",
      approvedActions: [],
      deniedPrivileges: query.requestedPrivileges ?? [],
      policyNote:
        "Retrieved skills are guidance only. A retrieved skill does not authorize merges, production deploys, credential changes, destructive database operations, or approval-policy bypasses."
    };
  }

  assertGuidanceCannotAuthorize(input: { skillName: string; action: string }): never {
    throw new Error(`skill ${input.skillName} is guidance_only and cannot authorize ${input.action}`);
  }

  recordSkillUsage(input: UsageInput): { usageId: string; refinement: RefinementOutcome } {
    const skill = this.requireSkill(input.skillName);
    const usageId = stableLearningId("use", {
      skillId: skill.id,
      taskId: input.taskId,
      attemptId: input.attemptId,
      disposition: input.disposition
    });
    let refinement: RefinementOutcome = "NO_CHANGE";
    this.withImmediateTransaction(() => {
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO learning_skill_usages (
             id, skill_id, skill_version, task_id, attempt_id, disposition, outcome,
             validation_passed, shortened_investigation, required_correction, repository, refinement, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          usageId,
          skill.id,
          skill.current_version,
          input.taskId,
          input.attemptId,
          input.disposition,
          input.outcome ?? null,
          toFlag(input.validationPassed),
          toFlag(input.shortenedInvestigation),
          toFlag(input.requiredCorrection),
          input.repository ?? null,
          "NO_CHANGE",
          nowIso()
        ) as { changes: number };
      if (inserted.changes === 0) {
        const existing = this.db
          .prepare(`SELECT refinement FROM learning_skill_usages WHERE id = ?`)
          .get(usageId) as { refinement: RefinementOutcome };
        refinement = existing.refinement;
        return;
      }
      if (input.disposition !== "applied") {
        refinement = "NO_CHANGE";
        return;
      }
      this.ensureMetrics(skill.id);
      const metrics = asRecord<MetricRow>(
        this.db.prepare(`SELECT * FROM learning_skill_metrics WHERE skill_id = ?`).get(skill.id)
      );
      const repositories = new Set(JSON.parse(metrics.repositories_json) as string[]);
      if (input.repository) repositories.add(input.repository);
      const success = input.outcome === "success";
      const failure = input.outcome === "failure";
      const uses = metrics.uses + 1;
      const successful = metrics.successful_uses + (success ? 1 : 0);
      const failed = metrics.failed_uses + (failure ? 1 : 0);
      const reductionSum = metrics.investigation_reduction_sum + (input.shortenedInvestigation ? 1 : 0);
      const reductionN = metrics.investigation_reduction_n + 1;
      this.db
        .prepare(
          `UPDATE learning_skill_metrics
              SET uses = ?, successful_uses = ?, failed_uses = ?, repositories_json = ?,
                  last_success = ?, last_failure = ?, investigation_reduction_sum = ?, investigation_reduction_n = ?
            WHERE skill_id = ?`
        )
        .run(
          uses,
          successful,
          failed,
          JSON.stringify([...repositories].sort()),
          success ? nowIso() : metrics.last_success,
          failure ? nowIso() : metrics.last_failure,
          reductionSum,
          reductionN,
          skill.id
        );
      let confidence = skill.confidence;
      let status = skill.status;
      if (success && !input.requiredCorrection) {
        confidence = Math.min(0.95, Number((confidence + 0.05).toFixed(3)));
        refinement = "CONFIDENCE_INCREASE";
      } else if (success && input.requiredCorrection) {
        refinement = "SKILL_UPDATE";
      } else if (failure) {
        confidence = Math.max(0.05, Number((confidence - 0.15).toFixed(3)));
        const rate = successful / uses;
        if (failed >= 3 && rate < 0.34) {
          status = "quarantined";
          refinement = "QUARANTINE";
        } else {
          refinement = "NO_CHANGE";
        }
      }
      this.db
        .prepare(`UPDATE learning_skills SET confidence = ?, status = ?, updated_at = ? WHERE id = ?`)
        .run(confidence, status, nowIso(), skill.id);
      this.db.prepare(`UPDATE learning_skill_usages SET refinement = ? WHERE id = ?`).run(refinement, usageId);
    });
    return { usageId, refinement };
  }

  evaluateSkillOutcome(input: {
    skillName: string;
    taskId: string;
    attemptId: string;
    used: boolean;
    engineSucceeded: boolean;
    validationPassed?: boolean;
    repository?: string;
    shortenedInvestigation?: boolean;
    requiredCorrection?: boolean;
  }): { refinement: import("./schema.js").RefinementOutcome; recorded: boolean } {
    if (!input.used) {
      return { refinement: "NO_CHANGE", recorded: false };
    }
    if (input.validationPassed !== true) {
      if (input.validationPassed === false) {
        const recorded = this.recordSkillUsage({
          skillName: input.skillName,
          taskId: input.taskId,
          attemptId: input.attemptId,
          disposition: "applied",
          outcome: "failure",
          validationPassed: false,
          shortenedInvestigation: false,
          requiredCorrection: true,
          repository: input.repository
        });
        return { refinement: recorded.refinement, recorded: true };
      }
      return { refinement: "NO_CHANGE", recorded: false };
    }
    if (!input.engineSucceeded) {
      return { refinement: "NO_CHANGE", recorded: false };
    }
    const recorded = this.recordSkillUsage({
      skillName: input.skillName,
      taskId: input.taskId,
      attemptId: input.attemptId,
      disposition: "applied",
      outcome: "success",
      validationPassed: true,
      shortenedInvestigation: input.shortenedInvestigation ?? true,
      requiredCorrection: input.requiredCorrection ?? false,
      repository: input.repository
    });
    return { refinement: recorded.refinement, recorded: true };
  }

  listSkills(): Array<{ name: string; status: string; version: number; confidence: number }> {
    return (
      this.db.prepare(`SELECT name, status, current_version, confidence FROM learning_skills ORDER BY name`).all() as Array<{
        name: string;
        status: string;
        current_version: number;
        confidence: number;
      }>
    ).map((row) => ({
      name: row.name,
      status: row.status,
      version: row.current_version,
      confidence: row.confidence
    }));
  }

  showSkill(name: string): {
    status: string;
    current: PromotedSkill;
    history: PromotedSkill[];
    metrics: {
      uses: number;
      successful_uses: number;
      failed_uses: number;
      success_rate: number;
      repositories_used: string[];
      last_success: string | null;
      last_failure: string | null;
      average_investigation_reduction: number;
    };
  } {
    const skill = this.requireSkill(name);
    const history = this.skillHistory(name);
    const current = history.at(-1);
    if (!current) throw new Error(`skill ${name} has no versions`);
    this.ensureMetrics(skill.id);
    const metrics = asRecord<MetricRow>(
      this.db.prepare(`SELECT * FROM learning_skill_metrics WHERE skill_id = ?`).get(skill.id)
    );
    const uses = metrics.uses;
    return {
      status: skill.status,
      current: { ...current, status: skill.status as PromotedSkill["status"] },
      history,
      metrics: {
        uses,
        successful_uses: metrics.successful_uses,
        failed_uses: metrics.failed_uses,
        success_rate: uses === 0 ? 0 : metrics.successful_uses / uses,
        repositories_used: JSON.parse(metrics.repositories_json) as string[],
        last_success: metrics.last_success,
        last_failure: metrics.last_failure,
        average_investigation_reduction:
          metrics.investigation_reduction_n === 0
            ? 0
            : metrics.investigation_reduction_sum / metrics.investigation_reduction_n
      }
    };
  }

  skillHistory(name: string): PromotedSkill[] {
    const skill = this.requireSkill(name);
    const rows = this.db
      .prepare(
        `SELECT version, content_json, provenance_json FROM learning_skill_versions WHERE skill_id = ? ORDER BY version`
      )
      .all(skill.id) as Array<{ version: number; content_json: string; provenance_json: string }>;
    return rows.map((row) => ({
      id: skill.id,
      name: skill.name,
      version: row.version,
      status: skill.status as PromotedSkill["status"],
      confidence: skill.confidence,
      content: JSON.parse(row.content_json) as SkillContent,
      provenance: JSON.parse(row.provenance_json) as SkillProvenance
    }));
  }

  listCandidates(): CandidateRecord[] {
    const rows = asRecord<CandidateRow[]>(
      this.db
        .prepare(
          `SELECT id, experience_id, state, score, score_breakdown_json, gate_results_json, reject_reasons_json, related_skill_id
             FROM learning_candidates ORDER BY updated_at DESC`
        )
        .all()
    );
    return rows.map(mapCandidate);
  }

  listUsages(name: string): UsageInput[] {
    const skill = this.requireSkill(name);
    return (
      this.db
        .prepare(
          `SELECT task_id, attempt_id, disposition, outcome, validation_passed, shortened_investigation, required_correction, repository
             FROM learning_skill_usages WHERE skill_id = ? ORDER BY created_at`
        )
        .all(skill.id) as Array<{
        task_id: string;
        attempt_id: string;
        disposition: UsageInput["disposition"];
        outcome: UsageInput["outcome"] | null;
        validation_passed: number | null;
        shortened_investigation: number | null;
        required_correction: number | null;
        repository: string | null;
      }>
    ).map((row) => ({
      skillName: name,
      taskId: row.task_id,
      attemptId: row.attempt_id,
      disposition: row.disposition,
      outcome: row.outcome ?? undefined,
      validationPassed: row.validation_passed == null ? undefined : Boolean(row.validation_passed),
      shortenedInvestigation: row.shortened_investigation == null ? undefined : Boolean(row.shortened_investigation),
      requiredCorrection: row.required_correction == null ? undefined : Boolean(row.required_correction),
      repository: row.repository ?? undefined
    }));
  }

  quarantineSkill(name: string, _reason = "operator"): void {
    const skill = this.requireSkill(name);
    this.db.prepare(`UPDATE learning_skills SET status = 'quarantined', updated_at = ? WHERE id = ?`).run(nowIso(), skill.id);
  }

  getTarget(name: string): { name: string; status: string } | undefined {
    const row = this.db.prepare(`SELECT name, status FROM learning_targets WHERE name = ?`).get(name) as
      | { name: string; status: string }
      | undefined;
    return row;
  }

  ingestFirstClassTargets(input: {
    existingSkills: Array<{ name: string; path: string; repository?: string }>;
  }): { ingested: string[]; unseeded: string[] } {
    const ingested: string[] = [];
    for (const skill of input.existingSkills) {
      const body = readFileSync(skill.path, "utf8");
      const sanitized = String(redactValue(generalizeText(body)));
      const name = slugifySkillName(skill.name);
      const content = skillContentSchema.parse({
        name,
        description: extractDescription(sanitized, name),
        problem_signals: [name.replaceAll("-", " "), "existing manual skill"],
        when_to_use: [`Use when the task matches ${name}.`],
        when_not_to_use: ["Do not invent missing steps that were not in the ingested source."],
        prerequisites: ["Read the original skill text before applying it."],
        diagnostic_sequence: ["Load the ingested skill and inspect current repository state."],
        repair_sequence: ["Follow the ingested procedure; verify live evidence before changing anything."],
        validation: ["Run the acceptance checks documented in the ingested skill when present."],
        rollback: ["Leave the system unchanged if live evidence contradicts the ingested procedure."],
        failure_modes: ["Applying an ingested skill without verifying current state."],
        evidence_source: skill.path,
        confidence: 0.7,
        version: 1
      });
      this.withImmediateTransaction(() => {
        const skillId = `skl_${name}`;
        this.db
          .prepare(
            `INSERT OR IGNORE INTO learning_skills (id, name, status, current_version, confidence, created_at, updated_at)
             VALUES (?, ?, 'active', 1, 0.7, ?, ?)`
          )
          .run(skillId, name, nowIso(), nowIso());
        this.db
          .prepare(
            `INSERT OR IGNORE INTO learning_skill_versions (id, skill_id, version, content_json, provenance_json, created_at)
             VALUES (?, ?, 1, ?, ?, ?)`
          )
          .run(
            `skv_${name}_v1`,
            skillId,
            JSON.stringify(content),
            JSON.stringify({
              source: "manual_ingest",
              repository: skill.repository,
              timestamp: nowIso(),
              sourcePath: skill.path,
              promotionDecision: "PROMOTED"
            } satisfies SkillProvenance),
            nowIso()
          );
        this.ensureMetrics(skillId);
        this.db
          .prepare(`INSERT INTO learning_targets (name, status, skill_id, updated_at) VALUES (?, 'ingested', ?, ?)
                    ON CONFLICT(name) DO UPDATE SET status = 'ingested', skill_id = excluded.skill_id, updated_at = excluded.updated_at`)
          .run(name, skillId, nowIso());
      });
      ingested.push(name);
    }
    const unseeded = FIRST_CLASS_TARGETS.filter((name) => !ingested.includes(name));
    return { ingested, unseeded };
  }

  findRelatedSkills(input: { name: string; signals: string[]; technologies: string[] }): Array<{ name: string; overlap: number }> {
    return this.listSkills()
      .map((skill) => {
        const shown = this.showSkill(skill.name);
        const overlap = Math.max(
          jaccard(tokenize(input.name), tokenize(skill.name)),
          jaccard(input.signals, shown.current.content.problem_signals),
          jaccard(input.technologies, tokenize(shown.current.content.problem_signals.join(" ")))
        );
        return { name: skill.name, overlap };
      })
      .filter((entry) => entry.overlap >= 0.34)
      .sort((left, right) => right.overlap - left.overlap);
  }

  private advancePromotion(
    experienceId: string,
    pauseAfter?: CandidateState,
    secrets: string[] = []
  ): RecordExperienceResult {
    let result: RecordExperienceResult | undefined;
    this.withImmediateTransaction(() => {
      const experience = this.getExperience(experienceId);
      if (!experience) throw new Error(`unknown experience ${experienceId}`);
      const candidate = this.getCandidateByExperience(experienceId);
      if (!candidate) throw new Error(`unknown candidate for ${experienceId}`);
      if (candidate.state === "REJECTED" || candidate.state === "PROMOTED") {
        result = {
          experience,
          candidate,
          skill: candidate.state === "PROMOTED" ? this.skillByName(experience.input.proposedSkillName) : undefined
        };
        return;
      }
      if (candidate.state === "ELIGIBLE" || candidate.state === "CAPTURED") {
        this.setCandidateState(candidate.id, "EXTRACTING", extractSkillContent(experience.input, 1));
      }
      const extracting = this.getCandidateByExperience(experienceId);
      if (!extracting) throw new Error("candidate disappeared");
      if (pauseAfter === "EXTRACTING") {
        result = { experience, candidate: extracting };
        return;
      }
      if (extracting.state === "EXTRACTING") {
        const draft = this.candidateDraft(extracting.id);
        skillContentSchema.parse(draft);
        this.assertNoSecrets(draft, secrets);
        this.setCandidateState(extracting.id, "VALIDATING", draft);
      }
      const validating = this.getCandidateByExperience(experienceId);
      if (!validating) throw new Error("candidate disappeared");
      const draft = this.candidateDraft(validating.id);
      const related = this.findRelatedSkills({
        name: experience.input.proposedSkillName,
        signals: experience.input.problemSignals,
        technologies: experience.input.technologies
      });
      const existingName = related[0]?.name ?? (this.skillExists(experience.input.proposedSkillName) ? slugifySkillName(experience.input.proposedSkillName) : undefined);
      const promoted = existingName
        ? this.publishSkillUpdate(existingName, experience, draft)
        : this.publishNewSkill(experience, draft);
      this.db
        .prepare(`UPDATE learning_candidates SET state = 'PROMOTED', related_skill_id = ?, updated_at = ? WHERE id = ?`)
        .run(promoted.id, nowIso(), validating.id);
      result = { experience, candidate: { ...validating, state: "PROMOTED", relatedSkillId: promoted.id }, skill: promoted };
    });
    if (!result) throw new Error("promotion produced no result");
    return result;
  }

  private publishNewSkill(experience: ExperienceRecord, draft: SkillContent): PromotedSkill {
    const name = slugifySkillName(experience.input.proposedSkillName);
    const skillId = `skl_${name}`;
    const content = { ...draft, name, version: 1, confidence: 0.55, evidence_source: experience.id };
    const provenance: SkillProvenance = provenanceFrom(experience, 1);
    this.db
      .prepare(
        `INSERT INTO learning_skills (id, name, status, current_version, confidence, created_at, updated_at)
         VALUES (?, ?, 'active', 1, ?, ?, ?)`
      )
      .run(skillId, name, content.confidence, nowIso(), nowIso());
    this.db
      .prepare(
        `INSERT INTO learning_skill_versions (id, skill_id, version, content_json, provenance_json, created_at)
         VALUES (?, ?, 1, ?, ?, ?)`
      )
      .run(`skv_${name}_v1`, skillId, JSON.stringify(content), JSON.stringify(provenance), nowIso());
    this.ensureMetrics(skillId);
    this.db
      .prepare(
        `INSERT INTO learning_targets (name, status, skill_id, updated_at) VALUES (?, 'promoted', ?, ?)
         ON CONFLICT(name) DO UPDATE SET status = 'promoted', skill_id = excluded.skill_id, updated_at = excluded.updated_at`
      )
      .run(name, skillId, nowIso());
    return { id: skillId, name, version: 1, status: "active", confidence: content.confidence, content, provenance };
  }

  private publishSkillUpdate(name: string, experience: ExperienceRecord, draft: SkillContent): PromotedSkill {
    const skill = this.requireSkill(name);
    const nextVersion = skill.current_version + 1;
    const previous = this.versionContent(skill.id, skill.current_version);
    const merged = mergeSkillContent(previous, draft, nextVersion, experience.id);
    const provenance = { ...provenanceFrom(experience, nextVersion), previousVersion: skill.current_version };
    this.db
      .prepare(
        `INSERT INTO learning_skill_versions (id, skill_id, version, content_json, provenance_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(`skv_${skill.name}_v${nextVersion}`, skill.id, nextVersion, JSON.stringify(merged), JSON.stringify(provenance), nowIso());
    this.db
      .prepare(`UPDATE learning_skills SET current_version = ?, updated_at = ? WHERE id = ?`)
      .run(nextVersion, nowIso(), skill.id);
    return { id: skill.id, name: skill.name, version: nextVersion, status: skill.status as PromotedSkill["status"], confidence: skill.confidence, content: merged, provenance };
  }

  private rankSkills(query: RetrieveQuery): Array<{ skill: SkillRow; score: number }> {
    const problemTokens = tokenize(`${query.problemSummary} ${(query.errorMessages ?? []).join(" ")}`);
    const techTokens = new Set((query.technologies ?? []).map((item) => item.toLowerCase()));
    const rows = asRecord<SkillRow[]>(
      this.db.prepare(`SELECT id, name, status, current_version, confidence FROM learning_skills`).all()
    );
    return rows
      .map((skill) => {
        const content = this.versionContent(skill.id, skill.current_version);
        const signalTokens = tokenize(content.problem_signals.join(" "));
        const errorScore = jaccard(tokenize((query.errorMessages ?? []).join(" ")), signalTokens);
        const problemScore = jaccard(problemTokens, signalTokens);
        const techScore = jaccard(techTokens, tokenize(content.problem_signals.join(" ") + " " + skill.name));
        const nameScore = jaccard(problemTokens, tokenize(skill.name));
        const typeHaystack = `${content.when_to_use.join(" ")} ${content.problem_signals.join(" ")} ${skill.name}`;
        const typeScore = query.taskType && typeHaystack.includes(query.taskType) ? 1 : 0;
        const metrics = this.db.prepare(`SELECT * FROM learning_skill_metrics WHERE skill_id = ?`).get(skill.id) as
          | MetricRow
          | undefined;
        const successRate = !metrics || metrics.uses === 0 ? skill.confidence : metrics.successful_uses / metrics.uses;
        const sameRepo =
          query.repository && metrics && (JSON.parse(metrics.repositories_json) as string[]).includes(query.repository)
            ? 1
            : 0;
        const recency = metrics?.last_success ? 1 : 0.3;
        const score =
          problemScore * 0.25 +
          nameScore * 0.15 +
          errorScore * 0.2 +
          techScore * 0.15 +
          typeScore * 0.1 +
          successRate * 0.1 +
          skill.confidence * 0.05 +
          recency * 0.03 +
          sameRepo * 0.02;
        return { skill, score };
      })
      .filter((entry) => entry.score >= 0.18)
      .sort((left, right) => right.score - left.score);
  }

  private seedTargets(): void {
    const now = nowIso();
    for (const name of FIRST_CLASS_TARGETS) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO learning_targets (name, status, skill_id, updated_at) VALUES (?, 'unseeded', NULL, ?)`
        )
        .run(name, now);
    }
  }

  private upsertExperience(id: string, parsed: ParsedTaskExperience, payloadHash: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO learning_experiences (id, task_id, payload_json, payload_hash, captured_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, parsed.taskId, JSON.stringify(parsed), payloadHash, nowIso());
  }

  private insertCandidate(input: {
    id: string;
    experienceId: string;
    skillName: string;
    state: CandidateState;
    score: number;
    scoreBreakdown: ScoreBreakdown;
    gateResults: GateResult[];
    rejectReasons: string[];
  }): void {
    this.db
      .prepare(
        `INSERT INTO learning_candidates (
           id, experience_id, skill_name, state, score, score_breakdown_json, gate_results_json, reject_reasons_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.experienceId,
        input.skillName,
        input.state,
        input.score,
        JSON.stringify(input.scoreBreakdown),
        JSON.stringify(input.gateResults),
        JSON.stringify(input.rejectReasons),
        nowIso()
      );
  }

  private getCandidateByExperience(experienceId: string): CandidateRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, experience_id, state, score, score_breakdown_json, gate_results_json, reject_reasons_json, related_skill_id
           FROM learning_candidates WHERE experience_id = ?`
      )
      .get(experienceId) as CandidateRow | undefined;
    return row ? mapCandidate(row) : undefined;
  }

  private setCandidateState(id: string, state: CandidateState, draft?: SkillContent): void {
    if (!candidateStates.includes(state)) throw new Error(`invalid state ${state}`);
    this.db
      .prepare(`UPDATE learning_candidates SET state = ?, draft_json = COALESCE(?, draft_json), updated_at = ? WHERE id = ?`)
      .run(state, draft ? JSON.stringify(draft) : null, nowIso(), id);
  }

  private candidateDraft(id: string): SkillContent {
    const row = this.db.prepare(`SELECT draft_json FROM learning_candidates WHERE id = ?`).get(id) as { draft_json: string | null };
    if (!row.draft_json) throw new Error(`candidate ${id} has no draft`);
    return JSON.parse(row.draft_json) as SkillContent;
  }

  private requireSkill(name: string): SkillRow {
    const row = this.db
      .prepare(`SELECT id, name, status, current_version, confidence FROM learning_skills WHERE name = ?`)
      .get(slugifySkillName(name)) as SkillRow | undefined;
    if (!row) throw new Error(`unknown skill ${name}`);
    return row;
  }

  private skillExists(name: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM learning_skills WHERE name = ?`).get(slugifySkillName(name));
    return Boolean(row);
  }

  private skillByName(name: string): PromotedSkill | undefined {
    if (!this.skillExists(name)) return undefined;
    return this.showSkill(name).current;
  }

  private versionContent(skillId: string, version: number): SkillContent {
    const row = this.db
      .prepare(`SELECT content_json FROM learning_skill_versions WHERE skill_id = ? AND version = ?`)
      .get(skillId, version) as { content_json: string };
    return JSON.parse(row.content_json) as SkillContent;
  }

  private ensureMetrics(skillId: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO learning_skill_metrics (
           skill_id, uses, successful_uses, failed_uses, repositories_json, last_success, last_failure,
           investigation_reduction_sum, investigation_reduction_n
         ) VALUES (?, 0, 0, 0, '[]', NULL, NULL, 0, 0)`
      )
      .run(skillId);
  }

  private assertNoSecrets(content: SkillContent, explicitSecrets: string[]): void {
    const serialized = JSON.stringify(content);
    const secrets = Array.isArray(explicitSecrets) ? explicitSecrets.filter((secret) => secret.length > 3) : [];
    for (const secret of secrets) {
      if (serialized.includes(secret)) {
        throw new Error("generated skill still contains a sensitive value");
      }
    }
  }

  private withImmediateTransaction(work: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already closed
      }
      throw error;
    }
  }
}

interface CandidateRow {
  id: string;
  experience_id: string;
  state: CandidateState;
  score: number;
  score_breakdown_json: string;
  gate_results_json: string;
  reject_reasons_json: string;
  related_skill_id: string | null;
}

interface MetricRow {
  skill_id: string;
  uses: number;
  successful_uses: number;
  failed_uses: number;
  repositories_json: string;
  last_success: string | null;
  last_failure: string | null;
  investigation_reduction_sum: number;
  investigation_reduction_n: number;
}

function mapCandidate(row: CandidateRow): CandidateRecord {
  return {
    id: row.id,
    experienceId: row.experience_id,
    state: row.state,
    score: row.score,
    scoreBreakdown: JSON.parse(row.score_breakdown_json) as ScoreBreakdown,
    gateResults: JSON.parse(row.gate_results_json) as GateResult[],
    rejectReasons: JSON.parse(row.reject_reasons_json) as string[],
    relatedSkillId: row.related_skill_id ?? undefined
  };
}

function sanitizeExperience(input: ParsedTaskExperience, secrets: string[] = []): ParsedTaskExperience {
  const redacted = redactValue({ ...input, explicitSecrets: [] }, secrets) as ParsedTaskExperience;
  return {
    ...redacted,
    problemSummary: generalizeText(redacted.problemSummary),
    rootCause: generalizeText(redacted.rootCause),
    problemSignals: redacted.problemSignals.map(generalizeText),
    errorMessages: redacted.errorMessages.map(generalizeText),
    procedure: {
      diagnostic: redacted.procedure.diagnostic.map(generalizeText),
      repair: redacted.procedure.repair.map(generalizeText),
      validation: redacted.procedure.validation.map(generalizeText),
      rollback: redacted.procedure.rollback.map(generalizeText),
      failureModes: redacted.procedure.failureModes.map(generalizeText)
    }
  };
}

function experienceHash(input: ParsedTaskExperience): string {
  return stableLearningId("h", {
    taskId: input.taskId,
    rootCause: input.rootCause,
    procedure: input.procedure,
    validation: input.validation
  }).slice(2);
}

function extractSkillContent(input: ParsedTaskExperience, version: number): SkillContent {
  return skillContentSchema.parse({
    name: slugifySkillName(input.proposedSkillName),
    description: generalizeText(input.problemSummary),
    problem_signals: input.problemSignals,
    when_to_use: [
      ...input.problemSignals.map((signal) => `Task exhibits: ${signal}`),
      `task type ${input.taskType}`
    ],
    when_not_to_use: [
      "Do not apply when live evidence contradicts the documented root cause.",
      "Do not treat the procedure as authorization for privileged actions."
    ],
    prerequisites: [
      "Inspect current repository state, dependency versions, and environment before applying the procedure."
    ],
    diagnostic_sequence: input.procedure.diagnostic,
    repair_sequence: input.procedure.repair,
    validation: input.procedure.validation,
    rollback: input.procedure.rollback,
    failure_modes: input.procedure.failureModes,
    evidence_source: input.taskId,
    confidence: 0.55,
    version
  });
}

function mergeSkillContent(previous: SkillContent, incoming: SkillContent, version: number, evidenceSource: string): SkillContent {
  const unique = (items: string[]): string[] => [...new Set(items.map((item) => item.trim()).filter(Boolean))];
  return skillContentSchema.parse({
    ...previous,
    problem_signals: unique([...previous.problem_signals, ...incoming.problem_signals]),
    when_to_use: unique([...previous.when_to_use, ...incoming.when_to_use]),
    diagnostic_sequence: unique([...previous.diagnostic_sequence, ...incoming.diagnostic_sequence]),
    repair_sequence: unique([...previous.repair_sequence, ...incoming.repair_sequence]),
    validation: unique([...previous.validation, ...incoming.validation]),
    rollback: unique([...previous.rollback, ...incoming.rollback]),
    failure_modes: unique([...previous.failure_modes, ...incoming.failure_modes]),
    evidence_source: evidenceSource,
    version,
    confidence: previous.confidence
  });
}

function provenanceFrom(experience: ExperienceRecord, version: number): SkillProvenance {
  return {
    source: "verified_task",
    taskId: experience.input.taskId,
    attemptId: experience.input.attemptId,
    repository: experience.input.repository,
    commitOrDiffId: experience.input.commitOrDiffId,
    agent: experience.input.agent,
    timestamp: experience.capturedAt,
    problemSummary: experience.input.problemSummary,
    rootCause: experience.input.rootCause,
    validationCommands: experience.input.validation.commands,
    validationResults: experience.input.validation.results,
    promotionDecision: "PROMOTED",
    previousVersion: version === 1 ? undefined : version - 1
  };
}

function extractDescription(body: string, fallback: string): string {
  const match = body.match(/^description:\s*(.+)$/m);
  return (match?.[1] ?? fallback).trim();
}

function nowIso(): string {
  return new Date().toISOString();
}

function toFlag(value: boolean | undefined): number | null {
  if (value === undefined) return null;
  return value ? 1 : 0;
}

function asRecord<T>(value: unknown): T {
  return value as T;
}
