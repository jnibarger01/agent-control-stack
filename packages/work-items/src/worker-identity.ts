import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ControlStackError, createId } from "@agent-control-stack/shared";

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

const tokenSchema = z.string().min(32).max(512);

const ttlMsSchema = z
  .number()
  .int()
  .positive()
  .max(24 * 60 * 60 * 1_000);

export const workerIdentityStatusSchema = z.enum(["active", "revoked"]);

export const workerIdentityViewSchema = z
  .object({
    id: identifierSchema,
    workerId: identifierSchema,
    issuedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    status: workerIdentityStatusSchema,
    generation: z.number().int().positive()
  })
  .strict();

export type WorkerIdentityStatus = z.infer<typeof workerIdentityStatusSchema>;
export type WorkerIdentityView = z.infer<typeof workerIdentityViewSchema>;

export interface IssuedWorkerIdentity extends WorkerIdentityView {
  /** Opaque bearer token returned once on issue/rotate. Never persisted in the clear elsewhere. */
  token: string;
}

export type WorkerIdentityResolveResult =
  | { ok: true; identity: WorkerIdentityView }
  | { ok: false; code: "worker_identity_unknown" | "worker_identity_expired" | "worker_identity_revoked" };

interface WorkerIdentityRecord {
  id: string;
  workerId: string;
  token: string;
  issuedAt: string;
  expiresAt: string;
  status: WorkerIdentityStatus;
  generation: number;
}

export function hashWorkerIdentityToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateWorkerIdentityToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * In-process worker credential registry with TTL, rotation, and revoke.
 *
 * Worker identity is lease-bound at the work-item layer (workerId on the
 * claim/lease). This registry owns the bearer tokens that prove that
 * identity at the gateway before a result may be accepted.
 */
export class WorkerIdentityRegistry {
  readonly #records: WorkerIdentityRecord[] = [];

  issue(input: { workerId: string; ttlMs: number; token?: string; id?: string; now?: Date }): IssuedWorkerIdentity {
    const workerId = identifierSchema.parse(input.workerId);
    const ttlMs = ttlMsSchema.parse(input.ttlMs);
    const now = input.now ?? new Date();
    const token = tokenSchema.parse(input.token ?? generateWorkerIdentityToken());
    const issuedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const generation = this.#nextGeneration(workerId);

    // A fresh issue for the same worker retires every still-active prior
    // generation so only one live credential exists per workerId.
    for (const record of this.#records) {
      if (record.workerId === workerId && record.status === "active") {
        record.status = "revoked";
      }
    }

    const record: WorkerIdentityRecord = {
      id: identifierSchema.parse(input.id ?? createId("wident")),
      workerId,
      token,
      issuedAt,
      expiresAt,
      status: "active",
      generation
    };
    this.#records.push(record);
    return this.#issued(record);
  }

  rotate(input: {
    workerId: string;
    currentToken: string;
    ttlMs: number;
    newToken?: string;
    now?: Date;
  }): IssuedWorkerIdentity {
    const workerId = identifierSchema.parse(input.workerId);
    const currentToken = tokenSchema.parse(input.currentToken);
    const ttlMs = ttlMsSchema.parse(input.ttlMs);
    const now = input.now ?? new Date();
    const current = this.#findByToken(currentToken);

    if (!current || current.workerId !== workerId) {
      throw new ControlStackError("worker_identity_unknown", "worker identity token is not recognized");
    }
    if (current.status === "revoked") {
      throw new ControlStackError("worker_identity_revoked", "worker identity has been revoked");
    }
    if (Date.parse(current.expiresAt) <= now.getTime()) {
      throw new ControlStackError("worker_identity_expired", "worker identity has expired");
    }

    current.status = "revoked";
    return this.issue({
      workerId,
      ttlMs,
      token: input.newToken,
      now
    });
  }

  /**
   * Idempotent: revoking an unknown, already-revoked, or already-expired
   * identity is a no-op so callers can clean up in finally blocks.
   */
  revoke(input: { workerId: string; token?: string; now?: Date }): void {
    const workerId = identifierSchema.parse(input.workerId);
    void input.now;
    if (input.token !== undefined) {
      const token = tokenSchema.parse(input.token);
      const record = this.#findByToken(token);
      if (record && record.workerId === workerId && record.status === "active") {
        record.status = "revoked";
      }
      return;
    }
    for (const record of this.#records) {
      if (record.workerId === workerId && record.status === "active") {
        // Mark revoked even if already past expiresAt so a later clock skew
        // cannot revive the credential on authenticate.
        record.status = "revoked";
      }
    }
  }

  resolve(token: string, now = new Date()): WorkerIdentityResolveResult {
    const parsed = tokenSchema.safeParse(token);
    if (!parsed.success) {
      return { ok: false, code: "worker_identity_unknown" };
    }
    const record = this.#findByToken(parsed.data);
    if (!record) {
      return { ok: false, code: "worker_identity_unknown" };
    }
    if (record.status === "revoked") {
      return { ok: false, code: "worker_identity_revoked" };
    }
    if (Date.parse(record.expiresAt) <= now.getTime()) {
      return { ok: false, code: "worker_identity_expired" };
    }
    return { ok: true, identity: this.#view(record) };
  }

  authenticate(token: string, now = new Date()): WorkerIdentityView {
    const result = this.resolve(token, now);
    if (result.ok) return result.identity;
    const messages = {
      worker_identity_unknown: "worker identity token is not recognized",
      worker_identity_expired: "worker identity has expired",
      worker_identity_revoked: "worker identity has been revoked"
    } as const;
    throw new ControlStackError(result.code, messages[result.code]);
  }

  getActive(workerId: string, now = new Date()): WorkerIdentityView | undefined {
    const id = identifierSchema.parse(workerId);
    const active = this.#records
      .filter(
        (record) => record.workerId === id && record.status === "active" && Date.parse(record.expiresAt) > now.getTime()
      )
      .sort((left, right) => right.generation - left.generation)[0];
    return active ? this.#view(active) : undefined;
  }

  #nextGeneration(workerId: string): number {
    let max = 0;
    for (const record of this.#records) {
      if (record.workerId === workerId) max = Math.max(max, record.generation);
    }
    return max + 1;
  }

  #findByToken(token: string): WorkerIdentityRecord | undefined {
    const tokenBuffer = Buffer.from(token);
    for (const record of this.#records) {
      const candidate = Buffer.from(record.token);
      if (candidate.length === tokenBuffer.length && timingSafeEqual(candidate, tokenBuffer)) {
        return record;
      }
    }
    return undefined;
  }

  #view(record: WorkerIdentityRecord): WorkerIdentityView {
    return workerIdentityViewSchema.parse({
      id: record.id,
      workerId: record.workerId,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      status: record.status,
      generation: record.generation
    });
  }

  #issued(record: WorkerIdentityRecord): IssuedWorkerIdentity {
    return { ...this.#view(record), token: record.token };
  }
}
