import { createRequire } from "node:module";
import * as ts from "./graph.js";
import type { PullRequestSnapshot } from "./types.js";

type NativeGraph = {
  [Key in "analyzeDependencies" | "findOverlaps"]: (
    ...args: Parameters<(typeof ts)[Key]>
  ) => ReturnType<(typeof ts)[Key]> | undefined;
};

const require = createRequire(import.meta.url);
let bridge: NativeGraph | null | undefined;
let warnedAboutCall = false;

function selectedBridge(): NativeGraph | undefined {
  if (process.env.ACS_INTEGRATION_GRAPH_BACKEND !== "rust") return undefined;
  if (bridge === undefined) {
    try {
      const adapter: { createGraphBridge: (addon: unknown) => NativeGraph } = require("../native/bridge.cjs");
      bridge = adapter.createGraphBridge(require("../native/acs_integration_graph.node"));
    } catch {
      bridge = null;
      process.emitWarning("ACS integration graph addon failed to load. Using TypeScript.", {
        code: "ACS_INTEGRATION_GRAPH_LOAD"
      });
    }
  }
  return bridge ?? undefined;
}

function tryNative<Result>(call: (graph: NativeGraph) => Result | undefined): Result | undefined {
  const native = selectedBridge();
  if (!native) return undefined;
  try {
    return call(native);
  } catch {
    if (!warnedAboutCall) {
      warnedAboutCall = true;
      process.emitWarning("ACS integration graph addon call failed. Using TypeScript for this invocation.", {
        code: "ACS_INTEGRATION_GRAPH_CALL"
      });
    }
    return undefined;
  }
}

export function analyzeDependencies(prs: readonly PullRequestSnapshot[], targetRef: string): ts.DependencyAnalysis {
  return tryNative((native) => native.analyzeDependencies(prs, targetRef)) ?? ts.analyzeDependencies(prs, targetRef);
}

export function findOverlaps(prs: readonly PullRequestSnapshot[]): ReturnType<typeof ts.findOverlaps> {
  return tryNative((native) => native.findOverlaps(prs)) ?? ts.findOverlaps(prs);
}
