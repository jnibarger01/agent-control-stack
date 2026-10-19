import { describe, expect, it } from "vitest";
import { overviewFixture } from "../../test/fixture";
import { layoutNetwork, neighbourhood } from "./network-layout";

describe("layoutNetwork", () => {
  const { nodes, edges } = overviewFixture().network;

  it("is deterministic: same input, same output", () => {
    expect(layoutNetwork(nodes, edges)).toEqual(layoutNetwork([...nodes].reverse(), edges));
  });

  it("puts bound agents first and never invents edges", () => {
    const layout = layoutNetwork(nodes, edges);
    expect(layout.agents.map((a) => a.node.id)).toEqual(["agent:a1", "agent:a2"]);
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]?.edge).toEqual(edges[0]);
  });

  it("drops an edge whose endpoint is not drawn instead of fabricating a node", () => {
    const layout = layoutNetwork(nodes.filter((n) => n.id !== "work:w1"), edges);
    expect(layout.edges).toHaveLength(0);
  });

  it("sizes to the larger lane", () => {
    expect(layoutNetwork(nodes, edges).height).toBeGreaterThan(60);
    expect(layoutNetwork([], []).height).toBeGreaterThan(0);
  });
});

describe("neighbourhood", () => {
  const { edges } = overviewFixture().network;
  it("returns only real neighbours", () => {
    expect([...(neighbourhood("agent:a1", edges) ?? [])].sort()).toEqual(["agent:a1", "work:w1"]);
    expect([...(neighbourhood("agent:a2", edges) ?? [])]).toEqual(["agent:a2"]);
    expect(neighbourhood(null, edges)).toBeNull();
  });
});
