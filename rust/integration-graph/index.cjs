// Rust Anything's replay/benchmark entry point. Calls the same adapter ACS uses.
// Unsupported input must fail here, so certification cannot count fallback as native.
const { createGraphBridge } = require("../../packages/integration-manager/native/bridge.cjs");
const bridge = createGraphBridge(require("./acs_integration_graph.node"));

exports.analyzeDependencies = (prs, target) => {
  const result = bridge.analyzeDependencies(prs, target);
  if (result === undefined) throw new TypeError("Unsupported dependency graph fixture");
  return result;
};

exports.findOverlaps = (prs) => {
  const result = bridge.findOverlaps(prs);
  if (result === undefined) throw new TypeError("Unsupported overlap graph fixture");
  return result;
};
