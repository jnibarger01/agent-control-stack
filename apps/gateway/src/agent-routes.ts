import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import {
  AGENT_CLI_CATALOG,
  agentCliSpec,
  createDispatchWorktree,
  discoverRepos,
  planAgentCommand,
  redactLines,
  runAgent,
  type AgentCliProbe
} from "@agent-control-stack/agent-cli";
import { ControlStackError } from "@agent-control-stack/shared";
import type { StoredAuditEvent, WorkItemStore } from "@agent-control-stack/work-items";
import { AgentRunService } from "./agent-runs.js";
import { agentRunBodySchema, agentRunConfirmedBodySchema, agentRunReviewBodySchema } from "./public-contracts.js";

const dispatchBodySchema = agentRunBodySchema;
const confirmedDispatchBodySchema = agentRunConfirmedBodySchema;

export const AGENT_CLI_REGISTRY_PREFIX = "cli-";
export const AGENT_CLI_TEST_EVENT = "agent_cli.tested";
const TEST_PROMPT = "Reply with exactly the single word ACS_OK and do not read, create or modify any files.";

export interface AgentCliView extends AgentCliProbe {
  registryId: string;
  registered: boolean;
  dispatchable: boolean;
  /** Why it cannot be dispatched right now (blocked, not installed, or dispatch is off). */
  unavailableReason?: string;
  lastTest?: { at: string; ok: boolean; outcome: string; detail: string };
}

export interface AgentRouteDeps {
  app: FastifyInstance;
  store: WorkItemStore;
  service: AgentRunService;
  requireRead: preHandlerAsyncHookHandler;
  /** Human operator with acs:approve. Replies and returns undefined on failure. */
  requireHumanActor: (request: FastifyRequest, reply: FastifyReply) => string | undefined;
  /** Registry actor bound to the credential; replies and returns undefined on failure. */
  requireRegistryActor: (request: FastifyRequest, reply: FastifyReply) => string | undefined;
  sendError: (reply: FastifyReply, error: unknown) => unknown;
}

function lastTests(events: StoredAuditEvent[]): Map<string, AgentCliView["lastTest"]> {
  const out = new Map<string, AgentCliView["lastTest"]>();
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const body = event.body as Record<string, unknown>;
    if (typeof body.agentId !== "string") continue;
    out.set(body.agentId, {
      at: new Date(Math.floor(Number(event.timeUnixNano) / 1e6)).toISOString(),
      ok: body.ok === true,
      outcome: String(body.outcome ?? ""),
      detail: String(body.detail ?? "")
    });
  }
  return out;
}

export async function agentCliViews(store: WorkItemStore, service: AgentRunService): Promise<AgentCliView[]> {
  const probes = await service.probes();
  const registered = new Set(store.listRegistryAgents().map((agent) => agent.id));
  const tests = lastTests(store.readEvents({ name: AGENT_CLI_TEST_EVENT, limit: 200 }));
  return probes.map((probe) => {
    const registryId = `${AGENT_CLI_REGISTRY_PREFIX}${probe.id}`;
    const reason = !probe.installed
      ? "not installed on this machine"
      : probe.dispatchBlockedReason
        ? probe.dispatchBlockedReason
        : !service.config.enabled
          ? "agent dispatch is off on this gateway"
          : undefined;
    return {
      ...probe,
      registryId,
      registered: registered.has(registryId),
      dispatchable: reason === undefined,
      ...(reason ? { unavailableReason: reason } : {}),
      ...(tests.get(probe.id) ? { lastTest: tests.get(probe.id)! } : {})
    };
  });
}

export function registerAgentRoutes(deps: AgentRouteDeps): void {
  const { app, store, service, requireRead, requireHumanActor, requireRegistryActor } = deps;
  /** Agent errors carry stable codes; map them to statuses here and leave everything else to the gateway. */
  const sendError = (reply: FastifyReply, error: unknown) => {
    if (error instanceof ControlStackError && error.code.startsWith("agent_")) {
      const status =
        error.code === "agent_dispatch_disabled"
          ? 503
          : error.code === "agent_run_not_found"
            ? 404
            : error.code === "agent_run_capacity"
              ? 429
              : error.code === "agent_repo_not_allowed"
                ? 403
                : [
                      "agent_repo_invalid",
                      "agent_prompt_required",
                      "agent_prompt_too_long",
                      "agent_mode_unsupported",
                      "agent_not_supported",
                      "agent_run_invalid"
                    ].includes(error.code)
                  ? 400
                  : 409;
      return reply.code(status).send({ error: error.message, code: error.code });
    }
    return deps.sendError(reply, error);
  };
  const limit = (max: number) => ({ rateLimit: { max, timeWindow: "1 minute" } });

  app.get("/api/agent-clis", { preHandler: requireRead, config: limit(60) }, async (_request, reply) => {
    try {
      return {
        dispatch: {
          enabled: service.config.enabled,
          repoRoots: service.config.repoRoots,
          repos: service.config.enabled ? discoverRepos(service.config.repoRoots) : [],
          maxConcurrent: service.config.maxConcurrent,
          active: service.activeCount()
        },
        agents: await agentCliViews(store, service)
      };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** Make every CLI visible in the registry (and so in the roster and composer). Idempotent. */
  app.post("/api/agent-clis/sync", { config: limit(10) }, async (request, reply) => {
    try {
      const actorId = requireRegistryActor(request, reply);
      if (!actorId) return;
      const views = await agentCliViews(store, service);
      let created = 0;
      let updated = 0;
      for (const view of views) {
        const spec = AGENT_CLI_CATALOG[view.id];
        const status: "OFFLINE" | "DEGRADED" | "AVAILABLE" = !view.installed
          ? "OFFLINE"
          : view.dispatchBlockedReason
            ? "DEGRADED"
            : "AVAILABLE";
        const lastError = view.dispatchBlockedReason ?? (view.installed ? undefined : "not installed");
        if (store.getRegistryAgent(view.registryId)) {
          store.updateRegistryAgent(view.registryId, { status, lastError: lastError ?? null, actorId });
          updated += 1;
        } else {
          // Registry names are unique (case-insensitive) and may already be used by another agent.
          const base = {
            id: view.registryId,
            kind: "cli",
            acpRole: "LOCAL_CODING_AGENT" as const,
            provider: spec.provider,
            status,
            ...(lastError ? { lastError } : {}),
            actorId
          };
          try {
            store.createRegistryAgent({ ...base, name: `${spec.displayName} CLI` });
          } catch (error) {
            if (!String(error instanceof Error ? error.message : error).includes("agents.name")) throw error;
            store.createRegistryAgent({ ...base, name: `${spec.displayName} CLI (${spec.id})` });
          }
          created += 1;
        }
      }
      return { created, updated, agents: await agentCliViews(store, service) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** Run a harmless prompt to prove the CLI is signed in and its flags still work. Records the result. */
  app.post<{ Params: { id: string } }>("/api/agent-clis/:id/test", { config: limit(10) }, async (request, reply) => {
    try {
      const actorId = requireHumanActor(request, reply);
      if (!actorId) return;
      service.assertEnabled();
      const spec = agentCliSpec(request.params.id);
      if (!spec) return reply.code(404).send({ error: "unknown agent CLI" });
      const checkRoot = join(service.config.worktreeRoot, "_checks", spec.id);
      mkdirSync(checkRoot, { recursive: true, mode: 0o700 });
      const repo = join(checkRoot, "repo");
      mkdirSync(repo, { recursive: true });
      const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
      try {
        git("rev-parse", "--git-dir");
      } catch {
        git("init", "-q", "-b", "main");
        git("config", "user.email", "acs-check@example.invalid");
        git("config", "user.name", "ACS agent check");
        writeFileSync(join(repo, "README.md"), "ACS agent connection check\n");
        git("add", "-A");
        git("commit", "-q", "-m", "init");
      }
      const wt = await createDispatchWorktree({
        repoRoot: repo,
        runId: `check${Date.now().toString(36)}`,
        agentId: spec.id,
        worktreeRoot: join(checkRoot, "wt")
      });
      const mode = spec.readOnlySupported ? "read-only" : "edit";
      const command = planAgentCommand({
        agentId: spec.id,
        prompt: TEST_PROMPT,
        mode,
        cwd: wt.worktreePath,
        timeoutSec: 150,
        allowBlocked: true
      });
      const result = await runAgent({ command, cwd: wt.worktreePath });
      const ok = result.outcome === "succeeded" && /ACS_OK/u.test(result.output);
      const detail = redactLines(result.output.trim().split("\n").slice(-3).join(" ⏎ ")).slice(0, 300);
      const event = store.recordSystemEvent({
        name: AGENT_CLI_TEST_EVENT,
        body: { agentId: spec.id, ok, outcome: result.outcome, durationMs: result.durationMs, detail, actorId },
        attributes: { "agent_cli.id": spec.id }
      });
      return {
        agentId: spec.id,
        ok,
        outcome: result.outcome,
        durationMs: result.durationMs,
        detail,
        eventId: event.id
      };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/agent-runs/preview", { config: limit(60) }, async (request, reply) => {
    try {
      const actorId = requireHumanActor(request, reply);
      if (!actorId) return;
      return { preview: await service.preview(dispatchBodySchema.parse(request.body), actorId) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/agent-runs", { config: limit(30) }, async (request, reply) => {
    try {
      const actorId = requireHumanActor(request, reply);
      if (!actorId) return;
      const { confirmationHash, ...body } = confirmedDispatchBodySchema.parse(request.body);
      const run = await service.dispatch(body, actorId, confirmationHash);
      return reply.code(202).send({ run });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/api/agent-runs", { preHandler: requireRead, config: limit(120) }, async (_request, reply) => {
    try {
      return { runs: service.list(50), active: service.activeCount() };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>(
    "/api/agent-runs/:id",
    { preHandler: requireRead, config: limit(120) },
    async (request, reply) => {
      try {
        const run = service.get(request.params.id);
        if (!run) return reply.code(404).send({ error: "agent run not found", code: "agent_run_not_found" });
        return { run, output: service.readOutput(run.runId) ?? "" };
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.post<{ Params: { id: string } }>("/api/agent-runs/:id/review", { config: limit(30) }, async (request, reply) => {
    try {
      const actorId = requireHumanActor(request, reply);
      if (!actorId) return;
      const body = agentRunReviewBodySchema.parse(request.body);
      return { run: service.review(request.params.id, actorId, body.decision, body.note) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/agent-runs/:id/cancel", { config: limit(30) }, async (request, reply) => {
    try {
      const actorId = requireHumanActor(request, reply);
      if (!actorId) return;
      return { run: service.cancel(request.params.id, actorId) };
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
