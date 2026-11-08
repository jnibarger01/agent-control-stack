import snapshotHeader from "./snapshot-header.json" with { type: "json" };
import { FIXTURE_RUNS } from "./fixture.js";
import { recorderFeatureEnabled } from "./flag.js";
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

export const capture = Object.freeze(snapshotHeader);

export async function loadLane(lane: "live" | "fixture", options: { enabled?: boolean } = {}): Promise<RecorderStore> {
  const enabled = options.enabled ?? recorderFeatureEnabled();
  const store = new RecorderStore({ enabled });
  if (!enabled) return store;
  // Bundled snapshot and fixture data is unsigned repository content. It can be shown, but it is never authoritative:
  // no trust is granted here, so its authority claims stay untrusted and cannot produce allowed or verified states.
  if (lane === "fixture") {
    for (const run of FIXTURE_RUNS) {
      store.annotate(run.annotation.runId, run.annotation);
      for (const event of run.events) await store.ingest(event);
    }
    return store;
  }
  const { default: snapshot } = await import("./snapshot.json", { with: { type: "json" } });
  const data = snapshot as Snapshot;
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
