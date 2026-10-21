import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURE_RUNS } from "./fixture.js";
import { RecorderStore } from "./store.js";
import type { IngestDraft, RunAnnotation } from "./types.js";

export const LIVE_FOCUS_RUN = "wrk_f0c9e63f-44f5-4b3c-a2ca-265bdbcebd8e";

function resolveSnapshotPath(): string {
  const candidates: string[] = [];
  if (import.meta.url.startsWith("file:")) {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(join(here, "snapshot.json"), join(here, "../src/snapshot.json"));
  }
  candidates.push(join(process.cwd(), "packages/black-box-recorder/src/snapshot.json"));
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error("black-box snapshot.json was not found");
  return found;
}

export const SNAPSHOT_PATH = resolveSnapshotPath();

type Snapshot = {
  capturedAt: string;
  source: {
    repoHead: string;
    via: string;
    runtimeId: string;
    gatewayReachable: boolean;
    note: string;
  };
  runs: Array<{
    runId: string;
    annotations: RunAnnotation;
    events: IngestDraft[];
    agent: string;
    tool: string;
    observedStatus: string;
    coverage: string;
  }>;
};

function readSnapshot(): Snapshot {
  return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as Snapshot;
}

const data = readSnapshot();

export const capture = {
  capturedAt: data.capturedAt,
  repoHead: data.source.repoHead,
  via: data.source.via,
  runtimeId: data.source.runtimeId,
  gatewayReachable: data.source.gatewayReachable,
  note: data.source.note,
  liveRuns: data.runs.length
};

export async function loadLane(lane: "live" | "fixture"): Promise<RecorderStore> {
  const store = new RecorderStore();
  if (lane === "fixture") {
    for (const run of FIXTURE_RUNS) {
      store.annotate(run.annotation.runId, run.annotation);
      for (const event of run.events) await store.ingest(event);
    }
    return store;
  }
  for (const run of data.runs) {
    store.annotate(run.runId, {
      ...run.annotations,
      agent: run.agent,
      tool: run.tool,
      observedStatus: run.observedStatus,
      coverage: run.coverage
    });
    for (const event of run.events) await store.ingest(event);
  }
  return store;
}
