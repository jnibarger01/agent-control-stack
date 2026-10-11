import { DatabaseSync } from "node:sqlite";
import { applyControlPlaneMigrations } from "@agent-control-stack/shared";
import { ModelEvidenceStore } from "./evidence.js";
import { parseCatalog } from "./catalog.js";
import {
  DEFAULT_ROUTING_POLICY,
  type CatalogEntry,
  type ComputeSnapshot,
  type ProviderAvailability,
  type RoutingPolicy
} from "./types.js";

export const T0 = Date.parse("2026-10-11T12:00:00.000Z");
export const iso = (offsetMs = 0) => new Date(T0 + offsetMs).toISOString();
export const GiB = 1024 ** 3;

export function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyControlPlaneMigrations(db);
  return db;
}

export function store(): { db: DatabaseSync; store: ModelEvidenceStore } {
  const db = memoryDb();
  return { db, store: new ModelEvidenceStore(db) };
}

/** local: small + large generative models on ollama, an embedding model, and a hosted model. */
export function catalog(): CatalogEntry[] {
  return parseCatalog([
    { providerId: "ollama", model: "small:4b", kind: "local", taskTypes: ["summarization", "classification", "code_generation"], contextWindow: 8192, memoryBytes: 4 * GiB, priority: 20 },
    { providerId: "ollama", model: "large:20b", kind: "local", taskTypes: ["code_generation", "planning", "summarization"], contextWindow: 32768, memoryBytes: 14 * GiB, priority: 10 },
    { providerId: "ollama", model: "embed:300m", kind: "local", taskTypes: ["embedding"], contextWindow: 2048, memoryBytes: GiB, priority: 5 },
    { providerId: "hosted-a", model: "frontier", kind: "hosted", taskTypes: ["code_generation", "planning", "summarization"], contextWindow: 200000, priority: 30 }
  ]);
}

export function availability(overrides: Partial<Record<string, Partial<ProviderAvailability>>> = {}): ProviderAvailability[] {
  return [
    {
      providerId: "ollama",
      kind: "local",
      reachable: true,
      models: ["small:4b", "large:20b", "embed:300m"],
      loadedModels: [],
      checkedAt: iso(),
      ...overrides.ollama
    },
    {
      providerId: "hosted-a",
      kind: "hosted",
      reachable: "unknown",
      credentialPresent: true,
      models: [],
      loadedModels: [],
      checkedAt: iso(),
      ...overrides["hosted-a"]
    }
  ];
}

export function compute(overrides: Partial<ComputeSnapshot> = {}): ComputeSnapshot {
  return {
    takenAt: iso(),
    cpu: { cores: 16, load1: 1 },
    memory: { totalBytes: 29 * GiB, availableBytes: 20 * GiB },
    gpus: { status: "unknown", devices: [] },
    ...overrides
  };
}

export function policy(overrides: Partial<RoutingPolicy> = {}): RoutingPolicy {
  return { ...DEFAULT_ROUTING_POLICY, ...overrides };
}
