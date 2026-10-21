import snapshot from "./snapshot.json" with { type: "json" };
import { FIXTURE_RUNS } from "./fixture.js";
import { RecorderStore } from "./store.js";
import type { IngestDraft, RunAnnotation } from "./types.js";

export const LIVE_FOCUS_RUN = "wrk_f0c9e63f-44f5-4b3c-a2ca-265bdbcebd8e";

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

const data = snapshot as Snapshot;

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
