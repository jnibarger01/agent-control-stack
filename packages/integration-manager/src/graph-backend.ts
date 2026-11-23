import { createRequire } from "node:module";
import * as ts from "./graph.js";
import type { PullRequestSnapshot } from "./types.js";

/**
 * Selects the integration graph implementation for one process.
 *
 * - unset, empty or `typescript`: TypeScript. The addon is never loaded.
 * - `rust`: the Node-API addon. Fails closed: a missing, incompatible or failing
 *   addon throws. There is no silent TypeScript fallback.
 * - any other value throws at selection time.
 *
 * One documented exception stays: the bridge returns `undefined` for input shapes
 * the native port does not cover (duplicate or out-of-range PR numbers, non-string
 * refs). Those calls use TypeScript by design; see docs/migrations/rust-graph-runbook.md.
 */

export type GraphBackend = "typescript" | "rust";

export type NativeGraph = {
  [Key in "analyzeDependencies" | "findOverlaps"]: (
    ...args: Parameters<(typeof ts)[Key]>
  ) => ReturnType<(typeof ts)[Key]> | undefined;
};

export class GraphBackendError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GraphBackendError";
    this.code = code;
  }
}

export function graphBackendFromEnvironment(env: NodeJS.ProcessEnv = process.env): GraphBackend {
  const value = env.ACS_INTEGRATION_GRAPH_BACKEND?.trim() ?? "";
  if (value === "" || value === "typescript") return "typescript";
  if (value === "rust") return "rust";
  throw new GraphBackendError(
    "ACS_INTEGRATION_GRAPH_BACKEND_INVALID",
    "ACS_INTEGRATION_GRAPH_BACKEND must be typescript or rust"
  );
}

const require = createRequire(import.meta.url);

/** Loads and ABI-verifies the packaged addon. Throws on any failure. */
function loadPackagedNative(): NativeGraph {
  const adapter: { createGraphBridge: (addon: unknown) => NativeGraph } = require("../native/bridge.cjs");
  return adapter.createGraphBridge(require("../native/acs_integration_graph.node"));
}

export interface GraphSelectorOptions {
  env?: NodeJS.ProcessEnv;
  /** Test seam. Production uses the packaged addon. */
  loadNative?: () => NativeGraph;
}

export interface GraphSelector {
  analyzeDependencies(prs: readonly PullRequestSnapshot[], targetRef: string): ts.DependencyAnalysis;
  findOverlaps(prs: readonly PullRequestSnapshot[]): ReturnType<typeof ts.findOverlaps>;
}

export function createGraphSelector(options: GraphSelectorOptions = {}): GraphSelector {
  let native: NativeGraph | undefined;

  const resolveNative = (): NativeGraph | undefined => {
    if (graphBackendFromEnvironment(options.env ?? process.env) === "typescript") return undefined;
    if (native === undefined) {
      try {
        native = (options.loadNative ?? loadPackagedNative)();
      } catch {
        throw new GraphBackendError(
          "ACS_INTEGRATION_GRAPH_ADDON_UNAVAILABLE",
          "ACS integration graph addon is missing or incompatible and ACS_INTEGRATION_GRAPH_BACKEND=rust requires it"
        );
      }
    }
    return native;
  };

  const dispatch = <Result>(call: (graph: NativeGraph) => Result | undefined, typescript: () => Result): Result => {
    const graph = resolveNative();
    if (graph === undefined) return typescript();
    let result: Result | undefined;
    try {
      result = call(graph);
    } catch {
      throw new GraphBackendError(
        "ACS_INTEGRATION_GRAPH_CALL_FAILED",
        "ACS integration graph addon call failed; no TypeScript result is substituted"
      );
    }
    return result ?? typescript();
  };

  return {
    analyzeDependencies: (prs, targetRef) =>
      dispatch(
        (graph) => graph.analyzeDependencies(prs, targetRef),
        () => ts.analyzeDependencies(prs, targetRef)
      ),
    findOverlaps: (prs) =>
      dispatch(
        (graph) => graph.findOverlaps(prs),
        () => ts.findOverlaps(prs)
      )
  };
}

const defaultSelector = createGraphSelector();

export function analyzeDependencies(prs: readonly PullRequestSnapshot[], targetRef: string): ts.DependencyAnalysis {
  return defaultSelector.analyzeDependencies(prs, targetRef);
}

export function findOverlaps(prs: readonly PullRequestSnapshot[]): ReturnType<typeof ts.findOverlaps> {
  return defaultSelector.findOverlaps(prs);
}
