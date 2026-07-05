import type { ServerResponse } from "node:http";
import { SqliteAuditLog, type StoredAuditEvent } from "@agent-control-stack/audit-log";
import { renderDashboard } from "@agent-control-stack/control-ui";
import { evaluateApproval } from "@agent-control-stack/policy-gate";
import { ControlStackError, type AuditEvent } from "@agent-control-stack/shared";
import {
  approvalRequestSchema,
  cancelRequestSchema,
  createWorkItemTools,
  SqliteWorkItemStore,
  submitWorkResultSchema
} from "@agent-control-stack/work-items";
import { ZodError } from "zod";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";

export interface GatewayOptions {
  dbPath?: string;
  logger?: boolean;
}

export function buildGateway(options: GatewayOptions = {}): FastifyInstance {
  const dbPath = options.dbPath ?? process.env.ACS_DB_PATH ?? "storage/local.db";
  const auditLog = new SqliteAuditLog(dbPath);
  const workItems = new SqliteWorkItemStore(dbPath);
  const app = Fastify({ logger: options.logger ?? true });
  const sseClients = new Set<ServerResponse>();

  function append(event: AuditEvent): StoredAuditEvent {
    const stored = auditLog.append(event);
    broadcast(stored);
    return stored;
  }

  const tools = createWorkItemTools(workItems, append);

  function broadcast(event: StoredAuditEvent): void {
    const frame = `event: ${event.name}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) {
      client.write(frame);
    }
  }

  app.get("/health", async () => ({ ok: true }));

  app.get("/", async (_request, reply) => {
    reply.type("text/html").send(renderDashboard(workItems.list()));
  });

  app.get("/mcp/tools", async () => ({
    tools: [
      "create_work_item",
      "get_work_item",
      "list_work_items",
      "approve_work_item",
      "cancel_work_item",
      "submit_work_result"
    ]
  }));

  app.get("/work-items", async (request) => ({ workItems: tools.list_work_items(request.query) }));

  app.get<{ Params: { id: string } }>("/work-items/:id", async (request, reply) => {
    const workItem = tools.get_work_item({ id: request.params.id });
    if (!workItem) {
      return reply.code(404).send({ error: "work item not found" });
    }
    return { workItem };
  });

  app.post("/work-items", async (request, reply) => {
    try {
      const workItem = tools.create_work_item(request.body);
      return reply.code(201).send(workItem);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/work-items/:id/approve", async (request, reply) => {
    const approval = approvalRequestSchema.safeParse(request.body);
    if (!approval.success) {
      return reply.code(400).send({ error: "invalid approval request" });
    }

    const workItem = workItems.get(request.params.id);
    if (!workItem) {
      return reply.code(404).send({ error: "work item not found" });
    }

    const decision = evaluateApproval(workItem, approval.data);
    if (!decision.allowed) {
      return reply.code(403).send(decision);
    }

    try {
      const approved = tools.approve_work_item({ id: workItem.id, ...approval.data });
      return { decision, workItem: approved };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/work-items/:id/cancel", async (request, reply) => {
    const cancel = cancelRequestSchema.safeParse(request.body ?? {});
    if (!cancel.success) {
      return reply.code(400).send({ error: "invalid cancel request" });
    }

    try {
      const cancelled = tools.cancel_work_item({ id: request.params.id, ...cancel.data });
      return { workItem: cancelled };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/work-items/:id/results", async (request, reply) => {
    const parsed = submitWorkResultSchema.safeParse({ ...(request.body as object), id: request.params.id });
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid result request" });
    }

    try {
      const completed = tools.submit_work_result(parsed.data);
      return { workItem: completed };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/events", (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    reply.raw.write(`event: ready\ndata: {}\n\n`);
    sseClients.add(reply.raw);
    request.raw.on("close", () => {
      sseClients.delete(reply.raw);
    });
  });

  app.addHook("onClose", async () => {
    auditLog.close();
    workItems.close();
  });

  return app;
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof ZodError) {
    return reply.code(400).send({ error: "invalid request" });
  }
  if (error instanceof ControlStackError) {
    const status = error.code === "work_item_not_found" ? 404 : 409;
    return reply.code(status).send({ error: error.message, code: error.code });
  }
  throw error;
}

export async function startGateway(): Promise<FastifyInstance> {
  const app = buildGateway();
  await app.listen({
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 3000)
  });
  return app;
}
