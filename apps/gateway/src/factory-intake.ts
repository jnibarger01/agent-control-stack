import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  FactoryIntentError,
  FactoryPlanError,
  createFactoryProposal,
  factoryMissionPlan,
  factoryMissionSummary,
  isFactoryMissionId,
  parseFactoryPlan,
  previewFactoryIntake,
  type FactoryPlan,
  type FactoryIntakePolicy,
  type FactoryRepositoryReader,
  type RepositoryResolution
} from "@agent-control-stack/ai-factory";
import type { CodingMissionRecord, CodingMissionStore } from "@agent-control-stack/coding-mission";
import { factoryPublicationEffect, projectFactoryMission, type FactoryMissionView } from "@agent-control-stack/ai-factory-runtime";
import type { WorkItemStore } from "@agent-control-stack/work-items";
import { ControlStackError } from "@agent-control-stack/shared";
import { SlidingWindowRateLimiter } from "./rate-limit.js";

/**
 * F1: authenticated, preview-only AI Factory intake.
 *
 * Off unless explicitly enabled. A preview reads the repository host read-only, records an audit
 * event, and returns a principal-bound hash. It never creates a mission, lease, approval or grant.
 */
export const FACTORY_INTAKE_EVENTS = {
  previewed: "ai_factory.intake.previewed",
  refused: "ai_factory.intake.refused",
  rateLimited: "ai_factory.intake.rate_limited",
  admitted: "ai_factory.admission.recorded",
  admissionRefused: "ai_factory.admission.refused",
  planRecorded: "ai_factory.plan.recorded",
  planRefused: "ai_factory.plan.refused",
  planAccepted: "ai_factory.plan.accepted"
} as const;

/** Mission store surface F2 needs. The mission record is the admission; there is no second job store. */
export type FactoryMissionStore = Pick<
  CodingMissionStore,
  | "create"
  | "get"
  | "budget"
  | "operations"
  | "addWorkUnits"
  | "verificationRequirement"
  | "setVerificationRequirement"
  | "workUnits"
  | "effect"
  | "listRecent"
>;

/** Intake bodies are small: the largest legal intent is well under this bound. */
export const FACTORY_INTAKE_BODY_LIMIT_BYTES = 64 * 1024;
const DEFAULT_PREVIEWS_PER_MINUTE = 10;
const GITHUB_TIMEOUT_MS = 10_000;

export interface FactoryIntakeConfig {
  enabled: boolean;
  policy: FactoryIntakePolicy;
  reader: FactoryRepositoryReader;
  /** Per-principal preview budget per minute. */
  previewsPerMinute?: number;
  /** Test seam: ACS clock used for admission time and budget checks. */
  now?: () => Date;
}

const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u;

function boundedInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d{1,13}$/u.test(raw)) throw new Error(name + " must be a non-negative integer");
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(name + " must be a safe integer");
  return value;
}

/**
 * Reads the intake configuration from the environment. Disabled unless ACS_FACTORY_INTAKE_ENABLED=1.
 * An enabled gateway with no repository allowlist refuses every preview (fail closed).
 */
export function factoryIntakeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FactoryIntakeConfig {
  const repositories = (env.ACS_FACTORY_REPOSITORIES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  for (const repository of repositories) {
    if (!REPOSITORY_PATTERN.test(repository)) throw new Error("ACS_FACTORY_REPOSITORIES entries must be owner/name");
  }
  return {
    enabled: env.ACS_FACTORY_INTAKE_ENABLED === "1",
    policy: {
      version: env.ACS_FACTORY_POLICY_VERSION || "acs.ai-factory.intake-policy.v1",
      repositories,
      maxLanes: boundedInteger(env.ACS_FACTORY_MAX_LANES, 2, "ACS_FACTORY_MAX_LANES"),
      maxWallClockMs: boundedInteger(env.ACS_FACTORY_MAX_WALL_CLOCK_MS, 3_600_000, "ACS_FACTORY_MAX_WALL_CLOCK_MS"),
      maxSpendMicrousd: boundedInteger(env.ACS_FACTORY_MAX_SPEND_MICROUSD, 0, "ACS_FACTORY_MAX_SPEND_MICROUSD")
    },
    reader: createGitHubFactoryRepositoryReader({ tokenSource: () => env.ACS_FACTORY_GITHUB_TOKEN || undefined })
  };
}

export interface GitHubFactoryReaderOptions {
  /** Read-only token. Optional for public repositories. Never logged or returned. */
  tokenSource: () => string | undefined;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Read-only GitHub resolver. Uses only GET. Redirects are never followed: a renamed or transferred
 * repository answers 301, which is reported as identity drift instead of silently resolving elsewhere.
 */
export function createGitHubFactoryRepositoryReader(options: GitHubFactoryReaderOptions): FactoryRepositoryReader {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/+$/u, "");
  const timeoutMs = options.timeoutMs ?? GITHUB_TIMEOUT_MS;

  async function get(path: string): Promise<{ status: number; body: unknown }> {
    const token = options.tokenSource();
    const response = await fetchImpl(apiBase + path, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: "Bearer " + token } : {})
      }
    });
    let body: unknown = undefined;
    if (response.status >= 200 && response.status < 300) body = await response.json();
    return { status: response.status, body };
  }

  return {
    async resolve(repository: string, commitSha: string): Promise<RepositoryResolution> {
      if (!REPOSITORY_PATTERN.test(repository) || !/^[a-f0-9]{40}$/u.test(commitSha)) {
        return { status: "unavailable" };
      }
      const [owner, name] = repository.split("/") as [string, string];
      const base = "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(name);
      try {
        const repo = await get(base);
        if (repo.status >= 300 && repo.status < 400) return { status: "identity_drift" };
        if (repo.status === 404) return { status: "repository_not_found" };
        if (repo.status !== 200 || !repo.body || typeof repo.body !== "object") return { status: "unavailable" };
        const meta = repo.body as { id?: unknown; full_name?: unknown; archived?: unknown };
        if (typeof meta.id !== "number" || typeof meta.full_name !== "string") return { status: "unavailable" };
        const commit = await get(base + "/commits/" + commitSha);
        if (commit.status >= 300 && commit.status < 400) return { status: "identity_drift" };
        // 404: unknown commit; 422: not a commit; 409: empty repository.
        if (commit.status === 404 || commit.status === 422 || commit.status === 409) return { status: "commit_not_found" };
        if (commit.status !== 200 || !commit.body || typeof commit.body !== "object") return { status: "unavailable" };
        const sha = (commit.body as { sha?: unknown }).sha;
        if (typeof sha !== "string") return { status: "unavailable" };
        return {
          status: "resolved",
          repositoryId: meta.id,
          fullName: meta.full_name,
          commitSha: sha,
          archived: meta.archived === true
        };
      } catch {
        return { status: "unavailable" };
      }
    }
  };
}

export function registerFactoryIntakeRoutes(deps: {
  app: FastifyInstance;
  store: Pick<WorkItemStore, "recordSystemEvent" | "recordSystemEventOnce" | "readEvents">;
  config: FactoryIntakeConfig;
  /** Resolved lazily so a gateway without coding missions still serves previews. */
  missions?: () => FactoryMissionStore | undefined;
  /** Resolves an authenticated actor with read scope, or sends 401. */
  requireReader?(request: FastifyRequest, reply: FastifyReply): string | undefined;
  /** Prometheus counters. Labels are bounded enums (route, outcome code), never ids or free text. */
  metrics?: { increment(name: string, labels?: Record<string, string>): void };
  now?: () => Date;
  /** Resolves the authenticated ACS actor or sends 401/403. The body never names the actor. */
  requireActor(request: FastifyRequest, reply: FastifyReply): string | undefined;
  sendError(reply: FastifyReply, error: unknown): unknown;
}): void {
  const { app, store, config } = deps;
  if (deps.metrics) {
    const metrics = deps.metrics;
    app.addHook("onResponse", async (request, reply) => {
      const route = request.routeOptions?.url;
      if (typeof route === "string" && route.startsWith("/api/factory/")) {
        metrics.increment("acs_factory_requests_total", { route, status: String(reply.statusCode) });
      }
    });
  }
  const limiter = new SlidingWindowRateLimiter({
    windowMs: 60_000,
    maxRequests: config.previewsPerMinute ?? DEFAULT_PREVIEWS_PER_MINUTE,
    maxBuckets: 10_000
  });

  app.post(
    "/api/factory/preview",
    { bodyLimit: FACTORY_INTAKE_BODY_LIMIT_BYTES },
    async (request, reply) => {
      try {
        const principal = deps.requireActor(request, reply);
        if (!principal) return;
        if (!config.enabled) {
          return reply
            .code(503)
            .send({ code: "factory_intake_disabled", error: "AI Factory intake is not enabled on this gateway" });
        }
        const decision = limiter.check(principal);
        if (!decision.allowed) {
          store.recordSystemEvent({
            name: FACTORY_INTAKE_EVENTS.rateLimited,
            body: { principal, retryAfterSeconds: decision.retryAfterSeconds },
            attributes: { "factory.principal": principal }
          });
          reply.header("retry-after", String(decision.retryAfterSeconds));
          return reply.code(429).send({ code: "factory_intake_rate_limited", error: "too many factory previews" });
        }
        const preview = await previewFactoryIntake({
          principal,
          body: request.body,
          policy: config.policy,
          reader: config.reader
        });
        if (preview.outcome === "refused") {
          // The objective and criteria are untrusted free text and are deliberately not audited.
          store.recordSystemEvent({
            name: FACTORY_INTAKE_EVENTS.refused,
            body: {
              principal,
              reason: preview.reason,
              ...(preview.field ? { field: preview.field } : {}),
              policyVersion: config.policy.version
            },
            attributes: { "factory.principal": principal, "factory.reason": preview.reason }
          });
          return reply.code(422).send({ preview });
        }
        store.recordSystemEvent({
          name: FACTORY_INTAKE_EVENTS.previewed,
          body: {
            principal,
            orderId: preview.orderId,
            intentHash: preview.intentHash,
            previewHash: preview.previewHash,
            repositoryId: preview.repository.id,
            repository: preview.repository.fullName,
            baseSha: preview.baseSha,
            policyVersion: preview.policyVersion,
            constraints: preview.constraints
          },
          attributes: { "factory.principal": principal, "factory.preview_hash": preview.previewHash }
        });
        return reply.code(200).send({ preview });
      } catch (error) {
        return deps.sendError(reply, error);
      }
    }
  );

  /**
   * F2 admission. The client sends the intent plus the preview hash it reviewed. ACS re-resolves the
   * repository and recomputes the preview: if anything moved (ref, policy, budget ceiling), the hash
   * differs and admission is refused as stale. Admission creates one PLANNING coding mission and
   * dispatches nothing.
   */
  app.post(
    "/api/factory/admit",
    { bodyLimit: FACTORY_INTAKE_BODY_LIMIT_BYTES },
    async (request, reply) => {
      try {
        const principal = deps.requireActor(request, reply);
        if (!principal) return;
        if (!config.enabled) {
          return reply
            .code(503)
            .send({ code: "factory_intake_disabled", error: "AI Factory intake is not enabled on this gateway" });
        }
        const missions = deps.missions?.();
        if (!missions) {
          return reply
            .code(503)
            .send({ code: "factory_admission_unconfigured", error: "mission storage is not configured" });
        }
        const decision = limiter.check(principal);
        if (!decision.allowed) {
          store.recordSystemEvent({
            name: FACTORY_INTAKE_EVENTS.rateLimited,
            body: { principal, retryAfterSeconds: decision.retryAfterSeconds, stage: "admission" },
            attributes: { "factory.principal": principal }
          });
          reply.header("retry-after", String(decision.retryAfterSeconds));
          return reply.code(429).send({ code: "factory_intake_rate_limited", error: "too many factory requests" });
        }
        const body = admissionBody(request.body);
        if (!body) return reply.code(400).send({ code: "invalid_request", error: "expected { intent, expectedPreviewHash }" });
        const refuseAdmission = (status: number, reason: string, extra: Record<string, unknown> = {}) => {
          store.recordSystemEvent({
            name: FACTORY_INTAKE_EVENTS.admissionRefused,
            body: { principal, reason, policyVersion: config.policy.version, ...extra },
            attributes: { "factory.principal": principal, "factory.reason": reason }
          });
          return reply.code(status).send({ code: reason, ...extra });
        };
        const preview = await previewFactoryIntake({
          principal,
          body: body.intent,
          policy: config.policy,
          reader: config.reader
        });
        if (preview.outcome === "refused") return refuseAdmission(422, "factory_preview_refused", { preview });
        if (preview.previewHash !== body.expectedPreviewHash) {
          // Do not echo the current hash: the caller must preview again and review what changed.
          return refuseAdmission(409, "factory_preview_stale");
        }
        const plan = factoryMissionPlan(preview);
        const replayed = missions.get(plan.missionId) !== undefined;
        let record: CodingMissionRecord;
        try {
          record = missions.create({
            missionId: plan.missionId,
            repository: plan.repository,
            baseRef: plan.baseRef,
            baseSha: plan.baseSha,
            summary: plan.summary,
            branch: "acs/mission/" + plan.missionId,
            deploymentRequired: false,
            deploymentAction: "none",
            deploymentImpact: "Draft pull request only. No merge, push to the base branch, or deployment.",
            now: (deps.now?.() ?? config.now?.() ?? new Date()).toISOString(),
            budget: { ...plan.budget },
            initiatorId: plan.initiatorId
          });
        } catch (error) {
          if (error instanceof ControlStackError && error.code === "coding_mission_identity_conflict") {
            return refuseAdmission(409, "factory_order_conflict", { orderId: preview.orderId });
          }
          throw error;
        }
        // The id is principal-derived, so another principal can never land here; check anyway.
        if (record.initiatorId !== principal) return refuseAdmission(409, "factory_order_conflict");
        // Mission insert and its own audit event are one transaction. This binding is recorded once per
        // mission; if a crash lands between the two, the next replay records it (no invisible authority).
        const audit = store.recordSystemEventOnce({
          name: FACTORY_INTAKE_EVENTS.admitted,
          uniqueAttribute: "factory.mission_id",
          body: {
            principal,
            missionId: record.missionId,
            orderId: preview.orderId,
            intentHash: preview.intentHash,
            previewHash: preview.previewHash,
            repositoryId: preview.repository.id,
            repository: preview.repository.fullName,
            baseSha: preview.baseSha,
            policyVersion: preview.policyVersion,
            constraints: preview.constraints
          },
          attributes: { "factory.mission_id": record.missionId, "factory.principal": principal }
        });
        return reply.code(replayed ? 200 : 201).send({
          admission: {
            missionId: record.missionId,
            state: record.state,
            replayed,
            orderId: preview.orderId,
            intentHash: preview.intentHash,
            previewHash: preview.previewHash,
            auditEventId: audit.event.id,
            dispatched: false
          }
        });
      } catch (error) {
        return deps.sendError(reply, error);
      }
    }
  );

  /** Owner-scoped read. Another principal's mission is indistinguishable from a missing one (no IDOR oracle). */
  app.get<{ Params: { id: string } }>("/api/factory/missions/:id", async (request, reply) => {
    try {
      const reader = deps.requireReader ? deps.requireReader(request, reply) : deps.requireActor(request, reply);
      if (!reader) return;
      const missions = deps.missions?.();
      const id = request.params.id;
      const record = missions && isFactoryMissionId(id) ? missions.get(id) : undefined;
      if (!record || record.initiatorId !== reader) {
        return reply.code(404).send({ code: "factory_mission_not_found", error: "factory mission not found" });
      }
      return {
        mission: {
          missionId: record.missionId,
          state: record.state,
          repository: record.repository,
          baseSha: record.baseSha,
          summary: record.summary,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt
        }
      };
    } catch (error) {
      return deps.sendError(reply, error);
    }
  });

  /**
   * Resolve an owned factory mission for a mutating plan call: authenticated principal, enabled intake,
   * configured storage, factory id, and initiator match. Anything else is a uniform 404 (no IDOR oracle).
   */
  const ownedMission = (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const principal = deps.requireActor(request, reply);
    if (!principal) return undefined;
    if (!config.enabled) {
      reply.code(503).send({ code: "factory_intake_disabled", error: "AI Factory intake is not enabled on this gateway" });
      return undefined;
    }
    const missions = deps.missions?.();
    if (!missions) {
      reply.code(503).send({ code: "factory_admission_unconfigured", error: "mission storage is not configured" });
      return undefined;
    }
    const id = request.params.id;
    const record = isFactoryMissionId(id) ? missions.get(id) : undefined;
    if (!record || record.initiatorId !== principal) {
      reply.code(404).send({ code: "factory_mission_not_found", error: "factory mission not found" });
      return undefined;
    }
    return { principal, missions, record };
  };

  const refusePlan = (reply: FastifyReply, principal: string, missionId: string, status: number, reason: string, extra: Record<string, unknown> = {}) => {
    store.recordSystemEvent({
      name: FACTORY_INTAKE_EVENTS.planRefused,
      body: { principal, missionId, reason, ...extra },
      attributes: { "factory.mission_id": missionId, "factory.reason": reason }
    });
    return reply.code(status).send({ code: reason, ...extra });
  };

  /**
   * F3: record a planner-suggested plan revision. ACS validates the DAG against the admitted intent
   * (the caller re-sends it; its hash must equal the one bound into the mission at admission) and
   * against the mission's own parallelism budget. Revisions form a hash-linked lineage; a revision
   * built on a stale parent is refused. Nothing is materialized or dispatched here.
   */
  app.post<{ Params: { id: string } }>(
    "/api/factory/missions/:id/plans",
    { bodyLimit: FACTORY_INTAKE_BODY_LIMIT_BYTES },
    async (request, reply) => {
      try {
        const owned = ownedMission(request, reply);
        if (!owned) return;
        const { principal, missions, record } = owned;
        const body = exactBody(request.body, ["intent", "plan"]);
        if (!body) return reply.code(400).send({ code: "invalid_request", error: "expected { intent, plan }" });
        if (record.state !== "PLANNING") return refusePlan(reply, principal, record.missionId, 409, "factory_plan_frozen");
        if (missions.operations(record.missionId).length > 0) {
          return refusePlan(reply, principal, record.missionId, 409, "factory_plan_frozen");
        }
        let proposal: ReturnType<typeof createFactoryProposal>;
        try {
          proposal = createFactoryProposal(body.intent);
        } catch (error) {
          if (error instanceof FactoryIntentError) {
            return refusePlan(reply, principal, record.missionId, 422, "factory_intent_invalid", { field: error.field });
          }
          throw error;
        }
        if (factoryMissionSummary({ orderId: proposal.intent.orderId, intentHash: proposal.intentHash }) !== record.summary) {
          return refusePlan(reply, principal, record.missionId, 409, "factory_intent_mismatch");
        }
        const maxParallel = missions.budget(record.missionId)?.limits.parallel_work_units;
        if (maxParallel === undefined) {
          return refusePlan(reply, principal, record.missionId, 409, "factory_budget_missing");
        }
        let validated: ReturnType<typeof parseFactoryPlan>;
        try {
          validated = parseFactoryPlan(body.plan, { missionId: record.missionId, intent: proposal.intent, maxParallel });
        } catch (error) {
          if (error instanceof FactoryPlanError) {
            return refusePlan(reply, principal, record.missionId, 422, "factory_plan_invalid", {
              field: error.field,
              detail: error.message
            });
          }
          throw error;
        }
        const latest = latestPlan(store, record.missionId);
        const expectedRevision = (latest?.revision ?? 0) + 1;
        const expectedParent = latest?.planDigest ?? null;
        if (validated.plan.revision !== expectedRevision || validated.plan.previousPlanDigest !== expectedParent) {
          // A replay of an already-recorded revision with the identical digest is idempotent.
          if (latest && latest.revision === validated.plan.revision && latest.planDigest === validated.planDigest) {
            return reply.code(200).send({ plan: planView(latest), replayed: true });
          }
          return refusePlan(reply, principal, record.missionId, 409, "factory_plan_stale", {
            expectedRevision
          });
        }
        const recorded = store.recordSystemEventOnce({
          name: FACTORY_INTAKE_EVENTS.planRecorded,
          uniqueAttribute: "factory.plan_revision_key",
          body: {
            principal,
            missionId: record.missionId,
            revision: validated.plan.revision,
            previousPlanDigest: validated.plan.previousPlanDigest,
            planDigest: validated.planDigest,
            depth: validated.depth,
            maxFanOut: validated.maxFanOut,
            plan: validated.plan
          },
          attributes: {
            "factory.plan_revision_key": record.missionId + "#r" + validated.plan.revision,
            "factory.mission_id": record.missionId,
            "factory.plan_digest": validated.planDigest
          }
        });
        if (!recorded.recorded) {
          // Lost a race for this revision number: same digest is a replay, anything else is stale.
          const winner = recorded.event.body as { planDigest?: unknown };
          if (winner.planDigest !== validated.planDigest) {
            return refusePlan(reply, principal, record.missionId, 409, "factory_plan_stale", { expectedRevision: expectedRevision + 1 });
          }
        }
        return reply.code(recorded.recorded ? 201 : 200).send({
          plan: {
            missionId: record.missionId,
            revision: validated.plan.revision,
            planDigest: validated.planDigest,
            previousPlanDigest: validated.plan.previousPlanDigest,
            layers: validated.layers,
            depth: validated.depth,
            maxFanOut: validated.maxFanOut,
            accepted: false
          },
          replayed: !recorded.recorded
        });
      } catch (error) {
        return deps.sendError(reply, error);
      }
    }
  );

  /**
   * F3: accept the latest plan revision by digest and materialize it as ACS work units. The insert,
   * dependency check and mission budget check are one store transaction. Units require independent
   * verification, so no unit can be claimed until a verifier requirement exists (fail closed until F7).
   */
  app.post<{ Params: { id: string } }>("/api/factory/missions/:id/plans/accept", async (request, reply) => {
    try {
      const owned = ownedMission(request, reply);
      if (!owned) return;
      const { principal, missions, record } = owned;
      const body = exactBody(request.body, ["planDigest", "intent"]);
      const planDigest = body?.planDigest;
      if (typeof planDigest !== "string" || !/^[a-f0-9]{64}$/u.test(planDigest)) {
        return reply.code(400).send({ code: "invalid_request", error: "expected { planDigest, intent }" });
      }
      let proposal: ReturnType<typeof createFactoryProposal>;
      try {
        proposal = createFactoryProposal(body!.intent);
      } catch (error) {
        if (error instanceof FactoryIntentError) {
          return refusePlan(reply, principal, record.missionId, 422, "factory_intent_invalid", { field: error.field });
        }
        throw error;
      }
      if (factoryMissionSummary({ orderId: proposal.intent.orderId, intentHash: proposal.intentHash }) !== record.summary) {
        return refusePlan(reply, principal, record.missionId, 409, "factory_intent_mismatch");
      }
      const latest = latestPlan(store, record.missionId);
      if (!latest || latest.planDigest !== planDigest) {
        return refusePlan(reply, principal, record.missionId, 409, "factory_plan_stale");
      }
      const existing = missions.operations(record.missionId);
      const wanted = latest.plan.units.map((unit) => unit.unitId).sort();
      if (existing.length > 0) {
        const have = existing.map((operation) => operation.operationId).sort();
        if (JSON.stringify(have) !== JSON.stringify(wanted)) {
          return refusePlan(reply, principal, record.missionId, 409, "factory_plan_frozen");
        }
      } else {
        if (record.state !== "PLANNING") return refusePlan(reply, principal, record.missionId, 409, "factory_plan_frozen");
        const result = missions.addWorkUnits(
          record.missionId,
          latest.plan.units.map((unit) => ({
            unitId: unit.unitId,
            kind: "coding" as const,
            title: unit.title,
            dependsOn: [...unit.dependsOn],
            payload: { kind: "coding", files: [...unit.paths], repository: record.repository, baseSha: record.baseSha },
            verificationPolicy: "independent" as const
          })),
          (deps.now?.() ?? config.now?.() ?? new Date()).toISOString()
        );
        if (!result.ok) {
          return refusePlan(reply, principal, record.missionId, 409, "factory_budget_refused", {
            exhausted: result.decision.exhausted,
            unaccounted: result.decision.unaccounted
          });
        }
      }
      // Every unit needs an independent-verification requirement before it can be claimed (F7). The
      // criteria come from the admitted intent, bound by hash; units without one stay unclaimable.
      const criteria = proposal.intent.acceptanceCriteria.map((text, index) => ({
        id: "acceptance-" + (index + 1),
        description: text,
        expected: "Independently verified as satisfied by the integrated change"
      }));
      const requirementTime = (deps.now?.() ?? config.now?.() ?? new Date()).toISOString();
      for (const unit of latest.plan.units) {
        if (!missions.verificationRequirement(record.missionId, unit.unitId)) {
          missions.setVerificationRequirement(record.missionId, unit.unitId, criteria, requirementTime);
        }
      }
      const accepted = store.recordSystemEventOnce({
        name: FACTORY_INTAKE_EVENTS.planAccepted,
        uniqueAttribute: "factory.mission_id",
        body: { principal, missionId: record.missionId, revision: latest.revision, planDigest },
        attributes: { "factory.mission_id": record.missionId, "factory.plan_digest": planDigest }
      });
      return reply.code(accepted.recorded ? 201 : 200).send({
        plan: { ...planView(latest), accepted: true },
        units: missions.operations(record.missionId).map((operation) => ({
          unitId: operation.operationId,
          dependsOn: operation.dependsOn,
          status: operation.status
        })),
        dispatched: false
      });
    } catch (error) {
      return deps.sendError(reply, error);
    }
  });
  const readerOf = (request: FastifyRequest, reply: FastifyReply) =>
    deps.requireReader ? deps.requireReader(request, reply) : deps.requireActor(request, reply);

  const viewOf = (missions: FactoryMissionStore, record: CodingMissionRecord): FactoryMissionView => {
    const latest = latestPlan(store, record.missionId);
    return projectFactoryMission({
      mission: record,
      units: missions.workUnits(record.missionId),
      budget: missions.budget(record.missionId),
      publication: factoryPublicationEffect(missions, record.missionId),
      plan: latest
        ? { revision: latest.revision, planDigest: latest.planDigest, accepted: planAccepted(store, record.missionId, latest.planDigest) }
        : null
    });
  };

  /** F10: owner-scoped operator view, projected only from recorded ACS state. */
  app.get<{ Params: { id: string } }>("/api/factory/missions/:id/view", async (request, reply) => {
    try {
      const reader = readerOf(request, reply);
      if (!reader) return;
      const missions = deps.missions?.();
      const id = request.params.id;
      const record = missions && isFactoryMissionId(id) ? missions.get(id) : undefined;
      if (!missions || !record || record.initiatorId !== reader) {
        return reply.code(404).send({ code: "factory_mission_not_found", error: "factory mission not found" });
      }
      return { view: viewOf(missions, record) };
    } catch (error) {
      return deps.sendError(reply, error);
    }
  });

  /** F10: the reader's own factory backlog, newest first. */
  app.get("/api/factory/backlog", async (request, reply) => {
    try {
      const reader = readerOf(request, reply);
      if (!reader) return;
      const missions = deps.missions?.();
      if (!missions) return { missions: [] };
      const views = missions
        .listRecent(500)
        .filter((record) => isFactoryMissionId(record.missionId) && record.initiatorId === reader)
        .slice(0, 100)
        .map((record) => viewOf(missions, record));
      return { missions: views };
    } catch (error) {
      return deps.sendError(reply, error);
    }
  });
}

function planAccepted(store: Pick<WorkItemStore, "readEvents">, missionId: string, planDigest: string): boolean {
  let before: number | undefined;
  for (let page = 0; page < 200; page++) {
    const events = store.readEvents({
      name: FACTORY_INTAKE_EVENTS.planAccepted,
      limit: 500,
      ...(before === undefined ? {} : { beforeSequence: before })
    });
    if (events.length === 0) return false;
    if (events.some((event) => (event.body as { missionId?: unknown; planDigest?: unknown }).missionId === missionId && (event.body as { planDigest?: unknown }).planDigest === planDigest)) {
      return true;
    }
    before = Math.min(...events.map((event) => event.sequence));
    if (events.length < 500) return false;
  }
  return false;
}

interface RecordedPlan {
  revision: number;
  planDigest: string;
  previousPlanDigest: string | null;
  plan: FactoryPlan;
}

function planView(recorded: RecordedPlan) {
  return {
    revision: recorded.revision,
    planDigest: recorded.planDigest,
    previousPlanDigest: recorded.previousPlanDigest
  };
}

/** Newest recorded plan revision for a mission, read back from the hash-chained audit log. */
function latestPlan(store: Pick<WorkItemStore, "readEvents">, missionId: string): RecordedPlan | undefined {
  let best: RecordedPlan | undefined;
  let before: number | undefined;
  for (let page = 0; page < 200; page++) {
    const events = store.readEvents({
      name: FACTORY_INTAKE_EVENTS.planRecorded,
      limit: 500,
      ...(before === undefined ? {} : { beforeSequence: before })
    });
    if (events.length === 0) break;
    for (const event of events) {
      const body = event.body as Partial<RecordedPlan> & { missionId?: unknown };
      if (body.missionId !== missionId || typeof body.revision !== "number" || typeof body.planDigest !== "string") continue;
      if (!best || body.revision > best.revision) {
        best = {
          revision: body.revision,
          planDigest: body.planDigest,
          previousPlanDigest: (body.previousPlanDigest as string | null | undefined) ?? null,
          plan: body.plan as FactoryPlan
        };
      }
    }
    before = Math.min(...events.map((event) => event.sequence));
    if (events.length < 500) break;
  }
  return best;
}

function exactBody(input: unknown, fields: readonly string[]): Record<string, unknown> | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const keys = Object.keys(input);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) return undefined;
  return input as Record<string, unknown>;
}

function admissionBody(input: unknown): { intent: unknown; expectedPreviewHash: string } | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.includes("intent") || !keys.includes("expectedPreviewHash")) return undefined;
  const { intent, expectedPreviewHash } = input as { intent: unknown; expectedPreviewHash: unknown };
  if (typeof expectedPreviewHash !== "string" || !/^[a-f0-9]{64}$/u.test(expectedPreviewHash)) return undefined;
  return { intent, expectedPreviewHash };
}
