import { describe, expect, it } from "vitest";
import type { ProjectedActor, RegistryAgentView } from "../api/types";
import { workItem } from "../test-fixtures";
import { searchIndex } from "./search";

const agent = { id: "analyst-1", name: "Analyst One", kind: "llm" } as RegistryAgentView;
const connector = { id: "corp-dc-1", displayName: "Corp DC", kind: "connector" } as ProjectedActor;
const worker = { id: "w9", displayName: "Worker", kind: "worker" } as ProjectedActor;
const input = {
  workItems: [workItem({ id: "WI-1837", title: "Deploy gate" }), workItem({ id: "WI-2000", title: "Other" })],
  registryAgents: [agent],
  actors: [connector, worker],
  attemptIds: [{ attemptId: "T-33721", workItemId: "WI-1837" }]
};

describe("global search (client-side over loaded data)", () => {
  it("finds work items by id or title and links to the deep route", () => {
    expect(searchIndex(input, "wi-1837")[0]).toMatchObject({ kind: "work", href: "/work/WI-1837" });
    expect(searchIndex(input, "deploy")[0]).toMatchObject({ id: "WI-1837" });
  });
  it("finds agents, connectors (not plain workers) and execution attempts", () => {
    expect(searchIndex(input, "analyst")[0]).toMatchObject({ kind: "agent", href: "/agents/analyst-1" });
    expect(searchIndex(input, "corp")[0]).toMatchObject({ kind: "connector", href: "/connectors/corp-dc-1" });
    expect(searchIndex(input, "w9")).toEqual([]);
    expect(searchIndex(input, "T-33721")[0]).toMatchObject({ kind: "execution", href: "/execution/WI-1837" });
  });
  it("ranks exact id matches first and honours the limit", () => {
    expect(searchIndex(input, "WI-", 1)).toHaveLength(1);
    expect(
      searchIndex(
        { ...input, workItems: [workItem({ id: "abc", title: "x abc" }), workItem({ id: "zzz", title: "abc first" })] },
        "abc"
      )[0]?.id
    ).toBe("abc");
  });
  it("encodes ids in links and returns nothing for empty queries", () => {
    expect(searchIndex({ ...input, workItems: [workItem({ id: "a/b?c", title: "t" })] }, "a/b")[0]?.href).toBe(
      "/work/a%2Fb%3Fc"
    );
    expect(searchIndex(input, "   ")).toEqual([]);
  });
});
