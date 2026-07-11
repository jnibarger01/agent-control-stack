import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { chooseMoaMode, effectiveMode, type MoaMode } from "./classifier.js";
import type { MoaConfig } from "./config.js";
import { isMoaError, MoaError } from "./errors.js";
import { runMoaTask, type MoaRunResult, type OrchestratorDeps } from "./orchestrator.js";
import type { IdempotencyStore } from "./ports.js";
import { RiskLevelSchema } from "./types.js";
import { newTaskId, sha256, stableStringify } from "./util.js";

const GatewayTaskSchema = z.object({
  task_id: z.string().regex(/^task_[A-Za-z0-9_-]{3,64}$/).optional(),
  session_id: z.string().min(1).max(128).optional(),
  origin: z.enum(["telegram", "cli", "qwenpaw", "openclaw", "web", "test"]).optional(),
  goal: z.string().min(1).max(4000),
  risk: RiskLevelSchema,
  kind: z.string().min(1).max(64),
  repo: z.string().max(512).optional(),
  branch: z.string().max(128).optional(),
  files: z.array(z.string().min(1).max(512)).max(64).optional(),
  snippets: z.array(z.object({ path: z.string().min(1).max(512), content: z.string().max(20_000) }).strict()).max(32).optional(),
  asksForReview: z.boolean().optional()
}).strict();

const RunBodySchema = z.object({
  mode: z.enum(["moa", "single", "auto"]).default("auto"),
  preset: z.enum(["off", "cheap", "fast", "security"]).optional(),
  task: GatewayTaskSchema
}).strict();

export interface GatewayDeps extends OrchestratorDeps {
  config: MoaConfig;
  authenticate: (req: FastifyRequest) => Promise<{ actor: string } | null>;
  idempotency?: IdempotencyStore;
  allowInMemoryIdempotency?: boolean;
}

export function moaGatewayPlugin(deps: GatewayDeps) {
  if (!deps.idempotency && !deps.allowInMemoryIdempotency) {
    throw new MoaError("IDEMPOTENCY_REQUIRED", "persistent idempotency store is required for /agent/run");
  }
  const store = deps.idempotency ?? new MapIdempotencyStore();

  return async function register(app: FastifyInstance): Promise<void> {
    app.post("/agent/run", async (req, reply) => {
      const auth = await deps.authenticate(req);
      if (!auth) {
        return reply.code(401).send({ error: "UNAUTHORIZED" });
      }
      if (req.headers["x-moa-internal"] !== undefined) {
        return reply.code(403).send({ error: "RECURSION_REJECTED", message: "advisor/internal-originated submissions are rejected" });
      }
      const parsed = RunBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "ENVELOPE_INVALID", issues: parsed.error.issues });
      }
      const body = parsed.data;
      const routed = chooseMoaMode({
        risk: body.task.risk,
        kind: body.task.kind,
        files: body.task.files,
        asksForReview: body.task.asksForReview
      });
      const requested: MoaMode | undefined = body.mode === "single" ? "off" : body.preset;
      const mode = effectiveMode(requested, routed);
      const idempotencyKey = requestIdempotencyKey(req, auth.actor, mode, body);

      const cached = (await store.get(idempotencyKey)) as MoaRunResult | undefined;
      if (cached) {
        return reply.code(200).send({ ...cached, replayed: true });
      }

      const envelope = {
        task_id: body.task.task_id ?? newTaskId(),
        origin: body.task.origin ?? "web",
        session_id: body.task.session_id ?? `sess_${auth.actor}`,
        user_id: auth.actor,
        risk: body.task.risk,
        kind: body.task.kind,
        goal: body.task.goal,
        context: {
          repo: body.task.repo,
          branch: body.task.branch,
          files: body.task.files ?? [],
          snippets: body.task.snippets ?? []
        },
        constraints: { no_mutation: true, max_advisor_tokens: 500, require_citations: false }
      };
      if (mode === "off") {
        const result = {
          task_id: envelope.task_id,
          mode: "single",
          advisor_count: 0,
          decision: "routed_to_single_model",
          acs_work_item_id: null,
          summary: "Router selected single-model mode; MoA not engaged."
        };
        await store.put(idempotencyKey, result);
        return reply.code(200).send(result);
      }
      try {
        const result = await runMoaTask(deps, deps.config, mode, envelope, auth.actor);
        await store.put(idempotencyKey, result);
        return reply.code(200).send(result);
      } catch (error) {
        if (isMoaError(error)) {
          const status = error.code === "EXECUTION_NOT_APPROVED" ? 409 : error.code === "ENVELOPE_INVALID" || error.code === "PRESET_UNKNOWN" ? 400 : error.code === "RECURSION_REJECTED" ? 403 : 502;
          return reply.code(status).send({ error: error.code, message: error.message });
        }
        return reply.code(500).send({ error: "INTERNAL", message: "MoA run failed (fail closed)" });
      }
    });
  };
}

function requestIdempotencyKey(req: FastifyRequest, actor: string, mode: MoaMode, body: z.infer<typeof RunBodySchema>): string {
  const header = firstHeader(req.headers["idempotency-key"]);
  if (header) {
    return `header:${actor}:${header}`;
  }
  return `hash:${sha256(stableStringify({ actor, mode, body }))}`;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

class MapIdempotencyStore implements IdempotencyStore {
  private readonly values = new Map<string, unknown>();
  async get(key: string): Promise<unknown | undefined> {
    return this.values.get(key);
  }
  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}
