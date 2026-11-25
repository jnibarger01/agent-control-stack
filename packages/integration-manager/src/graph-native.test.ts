import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pr } from "./fixtures.test-support.js";
import { analyzeDependencies, findOverlaps } from "./graph.js";
import { createGraphSelector, graphBackendFromEnvironment, type NativeGraph } from "./graph-backend.js";

const require = createRequire(import.meta.url);
const nativeEnabled = process.env.ACS_TEST_INTEGRATION_GRAPH_NATIVE === "1";
type Graph = { analyzeDependencies: typeof analyzeDependencies; findOverlaps: typeof findOverlaps };

function strictNative(): Graph {
  return require("../../../rust/integration-graph/index.cjs");
}

function observed(analysis: ReturnType<typeof analyzeDependencies>) {
  return {
    dependsOn: [...analysis.dependsOn],
    detached: [...analysis.detached],
    cyclic: [...analysis.cyclic],
    blockedByCycle: [...analysis.blockedByCycle],
    order: analysis.order
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("graph backend selection", () => {
  it("selects TypeScript when unset, empty or typescript", () => {
    expect(graphBackendFromEnvironment({})).toBe("typescript");
    expect(graphBackendFromEnvironment({ ACS_INTEGRATION_GRAPH_BACKEND: "" })).toBe("typescript");
    expect(graphBackendFromEnvironment({ ACS_INTEGRATION_GRAPH_BACKEND: " typescript " })).toBe("typescript");
  });

  it("rejects any other selection instead of guessing", () => {
    expect(() => graphBackendFromEnvironment({ ACS_INTEGRATION_GRAPH_BACKEND: "auto" })).toThrow(
      expect.objectContaining({ code: "ACS_INTEGRATION_GRAPH_BACKEND_INVALID" })
    );
  });

  it("negative, typescript: never loads the addon and returns the TypeScript result", () => {
    const loadNative = vi.fn(() => {
      throw new Error("must not load");
    });
    const selector = createGraphSelector({ env: {}, loadNative });
    const prs = [pr({ number: 9 }), pr({ number: 2 })];
    expect(observed(selector.analyzeDependencies(prs, "main"))).toEqual(observed(analyzeDependencies(prs, "main")));
    expect([...selector.findOverlaps(prs)]).toEqual([...findOverlaps(prs)]);
    expect(loadNative).not.toHaveBeenCalled();
  });

  it("negative, rust: a missing addon throws and never substitutes TypeScript", () => {
    const selector = createGraphSelector({
      env: { ACS_INTEGRATION_GRAPH_BACKEND: "rust" },
      loadNative: () => {
        throw new Error("Cannot find module 'acs_integration_graph.node' /private/path");
      }
    });
    const prs = [pr({ number: 1 })];
    expect(() => selector.analyzeDependencies(prs, "main")).toThrow(
      expect.objectContaining({ code: "ACS_INTEGRATION_GRAPH_ADDON_UNAVAILABLE" })
    );
    expect(() => selector.findOverlaps(prs)).toThrow(
      expect.objectContaining({ code: "ACS_INTEGRATION_GRAPH_ADDON_UNAVAILABLE" })
    );
  });

  it("negative, rust: an ABI-mismatched addon fails closed through the real bridge", () => {
    const { createGraphBridge } = require("../native/bridge.cjs") as {
      createGraphBridge: (addon: unknown) => NativeGraph;
    };
    const selector = createGraphSelector({
      env: { ACS_INTEGRATION_GRAPH_BACKEND: "rust" },
      loadNative: () =>
        createGraphBridge({
          graphAbiVersion: () => 2,
          analyzeDependencies: () => undefined,
          findOverlaps: () => undefined
        })
    });
    expect(() => selector.analyzeDependencies([pr({ number: 1 })], "main")).toThrow(
      expect.objectContaining({ code: "ACS_INTEGRATION_GRAPH_ADDON_UNAVAILABLE" })
    );
  });

  it("negative, rust: a throwing native call fails closed without a result", () => {
    const selector = createGraphSelector({
      env: { ACS_INTEGRATION_GRAPH_BACKEND: "rust" },
      loadNative: () => ({
        analyzeDependencies: () => {
          throw new Error("filename and request must stay out of diagnostics");
        },
        findOverlaps: () => undefined
      })
    });
    let caught: unknown;
    try {
      selector.analyzeDependencies([pr({ number: 1 })], "main");
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(expect.objectContaining({ code: "ACS_INTEGRATION_GRAPH_CALL_FAILED" }));
    expect(String((caught as Error).message)).not.toContain("filename");
  });

  it("rust: an input shape outside the native domain uses TypeScript by design", () => {
    const selector = createGraphSelector({
      env: { ACS_INTEGRATION_GRAPH_BACKEND: "rust" },
      loadNative: () => ({
        analyzeDependencies: () => undefined,
        findOverlaps: () => undefined
      })
    });
    const prs = [pr({ number: 1 }), pr({ number: 1 })];
    expect(observed(selector.analyzeDependencies(prs, "main"))).toEqual(observed(analyzeDependencies(prs, "main")));
    expect([...selector.findOverlaps(prs)]).toEqual([...findOverlaps(prs)]);
  });
});

describe.skipIf(!nativeEnabled)("native graph", () => {
  it("preserves map and set iteration order and UTF-16 file ordering", () => {
    const native = strictNative();
    const files = [".ts", "😀.ts", "\uD800.ts", "10.ts", "2.ts"];
    const prs = [
      pr({ number: 19, baseRef: "branch-20" }),
      pr({ number: 4, baseRef: "branch-3", changedFiles: files }),
      pr({ number: 8, baseRef: "branch-4" }),
      pr({ number: 3, baseRef: "branch-4", changedFiles: [...files, "😀.ts"] }),
      pr({ number: 13, baseRef: "branch-3" }),
      pr({ number: 20, baseRef: "branch-21" }),
      pr({ number: 21, baseRef: "missing" }),
      pr({ number: 26, headRef: "fork-only", isCrossRepository: true }),
      pr({ number: 25, baseRef: "fork-only" })
    ];

    const expected = analyzeDependencies(prs, "main");
    const actual = native.analyzeDependencies(prs, "main");
    expect([...expected.dependsOn.keys()]).toEqual([19, 4, 8, 3, 13, 20, 21, 26, 25]);
    expect([...expected.detached]).toEqual([21, 25, 20, 19]);
    expect([...expected.cyclic]).toEqual([4, 3]);
    expect([...expected.blockedByCycle]).toEqual([8, 13]);
    expect(actual.order).toEqual([26]);
    expect([...actual.dependsOn]).toEqual([...expected.dependsOn]);
    expect([...actual.detached]).toEqual([...expected.detached]);
    expect([...actual.cyclic]).toEqual([...expected.cyclic]);
    expect([...actual.blockedByCycle]).toEqual([...expected.blockedByCycle]);

    const overlaps = findOverlaps(prs);
    expect(overlaps.get(4)).toEqual([{ number: 3, files: ["10.ts", "2.ts", "\uD800.ts", "😀.ts", "😀.ts", ".ts"] }]);
    expect([...native.findOverlaps(prs)]).toEqual([...overlaps]);
  });

  it("matches the ordered output for 256 generated graphs", () => {
    const native = strictNative();
    let state = 90481;
    const random = (max: number) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return Math.floor((state / 0x100000000) * max);
    };
    for (let sample = 0; sample < 256; sample++) {
      const size = random(40);
      const prs = Array.from({ length: size }, (_, row) =>
        pr({
          number: (row + 1) * 149,
          headRef: `branch-${random(19)}`,
          baseRef: random(4) === 0 ? "main" : `branch-${random(22)}`,
          isCrossRepository: random(5) === 0,
          changedFiles: Array.from({ length: random(10) }, () => `path-${random(16)}`)
        })
      );
      for (let row = prs.length - 1; row > 0; row--) {
        const swap = random(row + 1);
        [prs[row], prs[swap]] = [prs[swap]!, prs[row]!];
      }
      expect(observed(native.analyzeDependencies(prs, "main")), `sample ${sample}`).toEqual(
        observed(analyzeDependencies(prs, "main"))
      );
      expect([...native.findOverlaps(prs)], `sample ${sample}`).toEqual([...findOverlaps(prs)]);
    }
  });

  it("uses the installed addon at the package entry point and fails closed on a call error", async () => {
    vi.stubEnv("ACS_INTEGRATION_GRAPH_BACKEND", "rust");
    const addon: Graph = require("../native/acs_integration_graph.node");
    const analyze = vi.spyOn(addon, "analyzeDependencies");
    const overlaps = vi.spyOn(addon, "findOverlaps");
    const graph = await import("./index.js");
    const prs = [pr({ number: 1, changedFiles: ["file"] }), pr({ number: 2, changedFiles: ["file"] })];
    expect(observed(graph.analyzeDependencies(prs, "main"))).toEqual(observed(analyzeDependencies(prs, "main")));
    expect([...graph.findOverlaps(prs)]).toEqual([...findOverlaps(prs)]);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(overlaps).toHaveBeenCalledTimes(1);

    const duplicate = [prs[0]!, prs[0]!];
    expect(observed(graph.analyzeDependencies(duplicate, "main"))).toEqual(
      observed(analyzeDependencies(duplicate, "main"))
    );
    expect(analyze).toHaveBeenCalledTimes(1);

    analyze.mockImplementation(() => {
      throw new Error("filename and request must stay out of diagnostics");
    });
    expect(() => graph.analyzeDependencies(prs, "main")).toThrow(
      expect.objectContaining({ code: "ACS_INTEGRATION_GRAPH_CALL_FAILED" })
    );
  });
});
