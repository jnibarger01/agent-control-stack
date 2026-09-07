import { ControlStackError } from "@agent-control-stack/shared";
import { z } from "zod";

export const PORTFOLIO_UNAVAILABLE_CODE = "PORTFOLIO_UNAVAILABLE";
export const PORTFOLIO_UNAVAILABLE_MESSAGE =
  "PORTFOLIO_UNAVAILABLE: Portfolio intelligence is not available from this gateway.";

const FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const STATUS = z.enum(["HEALTHY", "ATTENTION", "BLOCKED", "UNKNOWN", "ARCHIVED"]);
const LIFECYCLE = z.enum(["ACTIVE", "MAINTENANCE", "EXPERIMENTAL", "DORMANT", "ARCHIVED", "UNKNOWN"]);

export const portfolioClientConfigSchema = z
  .object({
    baseUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return url.hostname === "127.0.0.1" || url.hostname === "localhost";
      }, "portfolio base URL must remain loopback in V1"),
    timeoutMs: z.number().int().min(100).max(30_000).default(5_000)
  })
  .strict();

export type PortfolioClientConfig = z.infer<typeof portfolioClientConfigSchema>;

export const portfolioListRepositoriesInputSchema = z
  .object({
    status: STATUS.optional(),
    lifecycle: LIFECYCLE.optional(),
    limit: z.number().int().min(1).max(100).optional()
  })
  .strict();

export const portfolioLimitInputSchema = z
  .object({
    limit: z.number().int().min(1).max(100).optional()
  })
  .strict();

export const portfolioGetRepositoryInputSchema = z
  .object({
    repository: z.string().regex(FULL_NAME)
  })
  .strict();

export type PortfolioClient = {
  getSummary(): Promise<unknown>;
  listRepositories(input?: z.infer<typeof portfolioListRepositoriesInputSchema>): Promise<unknown>;
  listAttentionRequired(input?: z.infer<typeof portfolioLimitInputSchema>): Promise<unknown>;
  getRepository(input: z.infer<typeof portfolioGetRepositoryInputSchema>): Promise<unknown>;
  listFailures(input?: z.infer<typeof portfolioLimitInputSchema>): Promise<unknown>;
  listPendingWork(input?: z.infer<typeof portfolioLimitInputSchema>): Promise<unknown>;
  listRecentProgress(input?: z.infer<typeof portfolioLimitInputSchema>): Promise<unknown>;
};

export function createUnavailablePortfolioClient(): PortfolioClient {
  const unavailable = async (): Promise<never> => {
    throw new ControlStackError(PORTFOLIO_UNAVAILABLE_CODE, PORTFOLIO_UNAVAILABLE_MESSAGE);
  };
  return {
    getSummary: unavailable,
    listRepositories: unavailable,
    listAttentionRequired: unavailable,
    getRepository: unavailable,
    listFailures: unavailable,
    listPendingWork: unavailable,
    listRecentProgress: unavailable
  };
}

export function createPortfolioClient(config: PortfolioClientConfig): PortfolioClient {
  const parsed = portfolioClientConfigSchema.parse(config);
  const baseUrl = parsed.baseUrl.replace(/\/+$/, "");
  const timeoutMs = parsed.timeoutMs;

  const getJson = async (path: string): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new ControlStackError(
          PORTFOLIO_UNAVAILABLE_CODE,
          "PORTFOLIO_UNAVAILABLE: Portfolio intelligence request timed out."
        );
      }
      throw new ControlStackError(PORTFOLIO_UNAVAILABLE_CODE, PORTFOLIO_UNAVAILABLE_MESSAGE);
    } finally {
      clearTimeout(timer);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      throw new ControlStackError(
        PORTFOLIO_UNAVAILABLE_CODE,
        `PORTFOLIO_UNAVAILABLE: Visualizer portfolio request failed with HTTP ${response.status}.`
      );
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new ControlStackError(
        PORTFOLIO_UNAVAILABLE_CODE,
        "PORTFOLIO_UNAVAILABLE: Visualizer portfolio response was not a JSON object."
      );
    }
    if ("token" in body || "privateKey" in body || "authorization" in body) {
      throw new ControlStackError(
        PORTFOLIO_UNAVAILABLE_CODE,
        "PORTFOLIO_UNAVAILABLE: Visualizer portfolio response contained credential fields."
      );
    }
    return body;
  };

  return {
    async getSummary() {
      return getJson("/api/v1/portfolio");
    },
    async listRepositories(input = {}) {
      const body = await getJson("/api/v1/portfolio/repositories");
      const record = asRecord(body);
      const repositories = Array.isArray(record.repositories) ? record.repositories : [];
      const filtered = repositories.filter((item) => {
        const repository = asRecord(item);
        if (input.status !== undefined && repository.status !== input.status) return false;
        if (input.lifecycle !== undefined && repository.lifecycle !== input.lifecycle) return false;
        return true;
      });
      return {
        ...record,
        repositories: input.limit === undefined ? filtered : filtered.slice(0, input.limit)
      };
    },
    async listAttentionRequired(input = {}) {
      return limitPayload(await getJson("/api/v1/portfolio/attention"), "items", input.limit);
    },
    async getRepository(input) {
      const [owner, repo] = input.repository.split("/");
      return getJson(
        `/api/v1/portfolio/repositories/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(repo ?? "")}`
      );
    },
    async listFailures(input = {}) {
      return limitPayload(await getJson("/api/v1/portfolio/failures"), "failures", input.limit);
    },
    async listPendingWork(input = {}) {
      return limitPayload(await getJson("/api/v1/portfolio/pending-work"), "pendingWork", input.limit);
    },
    async listRecentProgress(input = {}) {
      return limitPayload(await getJson("/api/v1/portfolio/activity"), "activity", input.limit);
    }
  };
}

export function createPortfolioClientFromEnv(env: NodeJS.ProcessEnv = process.env): PortfolioClient {
  const baseUrl = env.ACS_PORTFOLIO_BASE_URL?.trim();
  if (!baseUrl) return createUnavailablePortfolioClient();
  const parsed = portfolioClientConfigSchema.safeParse({
    baseUrl,
    timeoutMs: env.ACS_PORTFOLIO_TIMEOUT_MS === undefined ? 5_000 : Number(env.ACS_PORTFOLIO_TIMEOUT_MS)
  });
  if (!parsed.success) return createUnavailablePortfolioClient();
  return createPortfolioClient(parsed.data);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function limitPayload(body: unknown, key: string, limit: number | undefined): unknown {
  const record = asRecord(body);
  const items = Array.isArray(record[key]) ? record[key] : [];
  return { ...record, [key]: limit === undefined ? items : items.slice(0, limit) };
}
