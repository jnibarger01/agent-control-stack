import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { auditEventHash, createEvent, type AuditChainEvent } from "@agent-control-stack/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { SlidingWindowRateLimiter, type RateLimitOptions } from "../rate-limit.js";

const DEFAULT_UPSTREAM_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const DEFAULT_INFERENCE_RATE_LIMIT: RateLimitOptions = { windowMs: 60_000, maxRequests: 120 };

const responseCreateSchema = z
  .object({
    model: z.string().min(1).max(256),
    stream: z.boolean().optional()
  })
  .passthrough();

export interface InferenceAuditEvent {
  type: "request_allowed" | "request_denied" | "upstream_completed" | "upstream_failed";
  requestId: string;
  actor?: string;
  method: string;
  path: string;
  model?: string;
  decision: "allow" | "deny" | "error";
  code?: string;
  stream?: boolean;
  upstreamStatus?: number;
  upstreamRequestId?: string;
  durationMs?: number;
}

export interface InferenceAuditSink {
  record(event: InferenceAuditEvent): void;
}

export interface OpenAiCompatibleGatewayDeps {
  authenticate: (request: FastifyRequest) => Promise<{ actor: string } | null>;
  apiKey: string;
  upstreamBaseUrl: string;
  allowedModels: ReadonlySet<string> | "*";
  audit: InferenceAuditSink;
  fetchImpl?: typeof fetch;
  newRequestId?: () => string;
  maxBodyBytes?: number;
  rateLimit?: RateLimitOptions;
}

export interface OpenAiCompatibleConfig {
  apiKey: string;
  upstreamBaseUrl: string;
  allowedModels: ReadonlySet<string> | "*";
  auditLogPath: string;
  maxBodyBytes: number;
}

export function openAiCompatibleConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): OpenAiCompatibleConfig | undefined {
  const enabled = env.ACS_INFERENCE_ENABLED;
  if (enabled === undefined || enabled === "" || enabled === "false") return undefined;
  if (enabled !== "true") {
    throw new Error("ACS_INFERENCE_ENABLED must be exactly true or false");
  }

  const apiKey = env.ACS_OPENAI_API_KEY ?? env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("ACS_OPENAI_API_KEY is required when ACS inference is enabled");

  const allowedModelsRaw = env.ACS_INFERENCE_ALLOWED_MODELS?.trim();
  if (!allowedModelsRaw) {
    throw new Error("ACS_INFERENCE_ALLOWED_MODELS is required when ACS inference is enabled");
  }
  const allowedModels = parseAllowedModels(allowedModelsRaw);
  const maxBodyBytes = parseMaxBodyBytes(env.ACS_INFERENCE_MAX_BODY_BYTES);

  return {
    apiKey,
    upstreamBaseUrl: DEFAULT_UPSTREAM_BASE_URL,
    allowedModels,
    auditLogPath: env.ACS_INFERENCE_AUDIT_LOG ?? "storage/inference-audit.jsonl",
    maxBodyBytes
  };
}

export function registerOpenAiCompatibleGateway(
  app: FastifyInstance,
  deps: OpenAiCompatibleGatewayDeps
): void {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const newRequestId = deps.newRequestId ?? (() => `inf_${randomUUID()}`);
  const bodyLimit = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const rateLimiter = new SlidingWindowRateLimiter(deps.rateLimit ?? DEFAULT_INFERENCE_RATE_LIMIT);

  app.post("/v1/responses", { bodyLimit }, async (request, reply) => {
    const requestId = newRequestId();
    reply.header("x-acs-request-id", requestId);
    const path = "/v1/responses";
    if (!enforceInferenceRateLimit(rateLimiter, request, reply, deps.audit, requestId, path)) return reply;

    const auth = await authenticateRequest(request, reply, deps, requestId, path);
    if (!auth) return reply;

    if (isRecursiveRequest(request)) {
      recordDenied(deps.audit, requestId, auth.actor, request.method, path, "recursion_rejected");
      return reply
        .code(508)
        .send(openAiError("recursive ACS inference proxy hop rejected", "acs_recursion_rejected"));
    }

    const parsed = responseCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      recordDenied(deps.audit, requestId, auth.actor, request.method, path, "invalid_request");
      return reply.code(400).send(openAiError("invalid Responses API request", "invalid_request"));
    }
    if (!modelAllowed(deps.allowedModels, parsed.data.model)) {
      recordDenied(
        deps.audit,
        requestId,
        auth.actor,
        request.method,
        path,
        "model_not_allowed",
        parsed.data.model,
        parsed.data.stream
      );
      return reply.code(403).send(openAiError("requested model is not allowed by ACS policy", "model_not_allowed"));
    }

    deps.audit.record({
      type: "request_allowed",
      requestId,
      actor: auth.actor,
      method: request.method,
      path,
      model: parsed.data.model,
      stream: parsed.data.stream,
      decision: "allow"
    });

    return proxyUpstream(request, reply, deps, fetchImpl, requestId, auth.actor, path, {
      model: parsed.data.model,
      stream: parsed.data.stream
    });
  });

  app.get("/v1/models", async (request, reply) => {
    const requestId = newRequestId();
    reply.header("x-acs-request-id", requestId);
    const path = "/v1/models";
    if (!enforceInferenceRateLimit(rateLimiter, request, reply, deps.audit, requestId, path)) return reply;

    const auth = await authenticateRequest(request, reply, deps, requestId, path);
    if (!auth) return reply;
    if (isRecursiveRequest(request)) {
      recordDenied(deps.audit, requestId, auth.actor, request.method, path, "recursion_rejected");
      return reply
        .code(508)
        .send(openAiError("recursive ACS inference proxy hop rejected", "acs_recursion_rejected"));
    }
    deps.audit.record({
      type: "request_allowed",
      requestId,
      actor: auth.actor,
      method: request.method,
      path,
      decision: "allow"
    });
    return proxyUpstream(request, reply, deps, fetchImpl, requestId, auth.actor, path);
  });
}

function enforceInferenceRateLimit(
  limiter: SlidingWindowRateLimiter,
  request: FastifyRequest,
  reply: FastifyReply,
  audit: InferenceAuditSink,
  requestId: string,
  path: string
): boolean {
  const decision = limiter.check(`${request.method}:${path}:ip:${request.ip}`);
  reply.header("x-ratelimit-remaining", String(decision.remaining));
  if (decision.allowed) return true;

  recordDenied(audit, requestId, undefined, request.method, path, "rate_limited");
  reply
    .header("retry-after", String(decision.retryAfterSeconds))
    .code(429)
    .send(openAiError("rate limit exceeded", "rate_limited", "rate_limit_error"));
  return false;
}

async function authenticateRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: OpenAiCompatibleGatewayDeps,
  requestId: string,
  path: string
): Promise<{ actor: string } | undefined> {
  const auth = await deps.authenticate(request);
  if (auth) return auth;
  recordDenied(deps.audit, requestId, undefined, request.method, path, "unauthorized");
  reply.code(401).send(openAiError("unauthorized", "unauthorized", "authentication_error"));
  return undefined;
}

async function proxyUpstream(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: OpenAiCompatibleGatewayDeps,
  fetchImpl: typeof fetch,
  requestId: string,
  actor: string,
  path: string,
  metadata: { model?: string; stream?: boolean } = {}
): Promise<FastifyReply> {
  const startedAt = performance.now();
  let upstream: Response;
  try {
    upstream = await fetchImpl(`${deps.upstreamBaseUrl.replace(/\/$/, "")}${path.slice(3)}`, {
      method: request.method,
      headers: upstreamHeaders(request, deps.apiKey),
      body: request.method === "GET" || request.method === "DELETE" ? undefined : JSON.stringify(request.body)
    });
  } catch {
    deps.audit.record({
      type: "upstream_failed",
      requestId,
      actor,
      method: request.method,
      path,
      model: metadata.model,
      stream: metadata.stream,
      decision: "error",
      code: "upstream_unreachable",
      durationMs: performance.now() - startedAt
    });
    return reply.code(502).send(openAiError("OpenAI upstream request failed", "upstream_unreachable", "api_error"));
  }

  copySafeResponseHeaders(upstream.headers, reply);
  deps.audit.record({
    type: "upstream_completed",
    requestId,
    actor,
    method: request.method,
    path,
    model: metadata.model,
    stream: metadata.stream,
    decision: upstream.ok ? "allow" : "error",
    upstreamStatus: upstream.status,
    upstreamRequestId: upstream.headers.get("x-request-id") ?? undefined,
    durationMs: performance.now() - startedAt
  });

  reply.code(upstream.status);
  if (!upstream.body) return reply.send();
  return reply.send(Readable.fromWeb(upstream.body as unknown as NodeReadableStream<Uint8Array>));
}

function upstreamHeaders(request: FastifyRequest, apiKey: string): Headers {
  const headers = new Headers({
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    "x-acs-inference-hop": "1"
  });
  const accept = firstHeader(request.headers.accept);
  if (accept) headers.set("accept", accept);
  const openAiBeta = firstHeader(request.headers["openai-beta"]);
  if (openAiBeta) headers.set("openai-beta", openAiBeta);
  return headers;
}

function copySafeResponseHeaders(headers: Headers, reply: FastifyReply): void {
  for (const name of ["content-type", "x-request-id", "openai-processing-ms", "openai-version", "retry-after"]) {
    const value = headers.get(name);
    if (value) reply.header(name, value);
  }
  headers.forEach((value, name) => {
    if (name.toLowerCase().startsWith("x-ratelimit-")) reply.header(name, value);
  });
}

function isRecursiveRequest(request: FastifyRequest): boolean {
  return request.headers["x-acs-inference-hop"] !== undefined;
}

function modelAllowed(allowed: ReadonlySet<string> | "*", model: string): boolean {
  return allowed === "*" || allowed.has(model);
}

function parseAllowedModels(value: string): ReadonlySet<string> | "*" {
  if (value === "*") return "*";
  const models = value
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  if (models.length === 0) throw new Error("ACS_INFERENCE_ALLOWED_MODELS must contain at least one model");
  return new Set(models);
}

function parseMaxBodyBytes(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_MAX_BODY_BYTES;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1024 || parsed > MAX_BODY_BYTES) {
    throw new Error(`ACS_INFERENCE_MAX_BODY_BYTES must be an integer between 1024 and ${MAX_BODY_BYTES}`);
  }
  return parsed;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function recordDenied(
  audit: InferenceAuditSink,
  requestId: string,
  actor: string | undefined,
  method: string,
  path: string,
  code: string,
  model?: string,
  stream?: boolean
): void {
  audit.record({
    type: "request_denied",
    requestId,
    actor,
    method,
    path,
    model,
    stream,
    decision: "deny",
    code
  });
}

function openAiError(message: string, code: string, type = "invalid_request_error") {
  return { error: { message, type, param: null, code } };
}

export class HashChainedInferenceAuditSink implements InferenceAuditSink {
  private sequence: number;
  private previousHash: string;

  constructor(private readonly logPath: string) {
    const tail = readAuditTail(logPath);
    this.sequence = tail.sequence;
    this.previousHash = tail.previousHash;
  }

  record(event: InferenceAuditEvent): void {
    const { type, ...body } = event;
    const base = createEvent(`inference.${type}`, body, {
      "inference.request_id": event.requestId,
      "inference.actor": event.actor ?? "anonymous",
      "inference.model": event.model ?? "",
      "inference.decision": event.decision
    });
    const chained: Omit<AuditChainEvent, "eventHash"> = {
      ...base,
      sequence: this.sequence + 1,
      previousHash: this.previousHash
    };
    const record = { ...chained, eventHash: auditEventHash(chained) };
    mkdirSync(dirname(this.logPath), { recursive: true });
    appendFileSync(this.logPath, `${JSON.stringify(record)}\n`, "utf8");
    this.sequence = record.sequence;
    this.previousHash = record.eventHash;
  }
}

function readAuditTail(path: string): { sequence: number; previousHash: string } {
  if (!existsSync(path)) return { sequence: 0, previousHash: "" };
  const last = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).at(-1);
  if (!last) return { sequence: 0, previousHash: "" };
  const parsed = JSON.parse(last) as { sequence?: unknown; eventHash?: unknown };
  if (typeof parsed.sequence !== "number" || typeof parsed.eventHash !== "string") {
    throw new Error(`inference audit log is malformed at ${path}`);
  }
  return { sequence: parsed.sequence, previousHash: parsed.eventHash };
}
