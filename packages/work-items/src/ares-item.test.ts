import { describe, expect, it } from "vitest";
import {
  ARES_ACTION_KINDS,
  aresItemTargetsWorker,
  createWorkItem,
  isAresWorkItem,
  mentionsAresKind,
  type WorkItem
} from "./work-item.js";

type ActionLike = { kind: string; description: string; params?: Record<string, unknown> };
const action = (kind: string): ActionLike => ({ kind, description: kind, params: {} });
const item = (kinds: string[], services: string[] = ["ares"]) =>
  ({
    target: { services },
    requestedActions: kinds.map(action)
  }) as unknown as Pick<WorkItem, "target" | "requestedActions">;

const base = (kinds: string[]) => ({
  title: "t",
  requester: "user",
  intent: "i",
  target: { services: ["ares"] },
  requestedActions: kinds.map(action),
  risk: "medium"
});

const CASES: { kinds: string[]; ares: boolean; mentions: boolean; label: string }[] = [
  { kinds: [], ares: false, mentions: false, label: "no actions" },
  { kinds: ["system.status"], ares: false, mentions: false, label: "one ordinary action" },
  { kinds: ["ares.analyze.local"], ares: true, mentions: true, label: "one known ARES action" },
  { kinds: ["ares.spec.seal"], ares: true, mentions: true, label: "another known ARES action" },
  {
    kinds: ["ares.analyze.local", "system.status"],
    ares: false,
    mentions: true,
    label: "ARES mixed with an ordinary action"
  },
  {
    kinds: ["system.status", "ares.analyze.local"],
    ares: false,
    mentions: true,
    label: "ordinary mixed with ARES (other order)"
  },
  { kinds: ["ares.analyze.local", "ares.spec.seal"], ares: false, mentions: true, label: "two ARES actions" },
  { kinds: ["ares.shell.exec"], ares: false, mentions: true, label: "unknown ares.* kind" }
];

describe("the one definition of an ARES work item", () => {
  it("exports the known ARES kinds once", () => {
    expect([...ARES_ACTION_KINDS].sort()).toEqual([
      "ares.adapter.ghidra",
      "ares.adapter.rea",
      "ares.analyze.local",
      "ares.oracle.run",
      "ares.spec.seal",
      "ares.task.decide"
    ]);
  });

  for (const c of CASES) {
    it(`classifies: ${c.label}`, () => {
      expect(isAresWorkItem(item(c.kinds))).toBe(c.ares);
      expect(mentionsAresKind(item(c.kinds))).toBe(c.mentions);
    });
  }

  it("never lets an item be 'ARES' for one layer and not for another: strict implies mentions, and the difference cannot be created", () => {
    for (const c of CASES) {
      if (isAresWorkItem(item(c.kinds))) expect(mentionsAresKind(item(c.kinds))).toBe(true);
      const differs = mentionsAresKind(item(c.kinds)) && !isAresWorkItem(item(c.kinds));
      if (differs) expect(() => createWorkItem(base(c.kinds)), c.label).toThrow(/ares/i);
      else expect(() => createWorkItem(base(c.kinds)), c.label).not.toThrow();
    }
  });

  it("rejects an item that mixes ares.* with another action, repeats ARES actions, or uses an unknown ares.* kind", () => {
    for (const kinds of [
      ["ares.analyze.local", "system.status"],
      ["system.status", "ares.spec.seal"],
      ["ares.analyze.local", "ares.spec.seal"],
      ["ares.shell.exec"]
    ]) {
      expect(() => createWorkItem(base(kinds)), kinds.join("+")).toThrow(/ares/i);
    }
  });

  it("still creates a single known ARES item and ordinary items, including several ordinary actions", () => {
    expect(createWorkItem(base(["ares.analyze.local"])).requestedActions).toHaveLength(1);
    expect(createWorkItem(base(["system.status"])).requestedActions).toHaveLength(1);
    expect(createWorkItem(base(["system.status", "system.status"])).requestedActions).toHaveLength(2);
  });

  it("binds an ARES item to the worker it names, and leaves other items alone", () => {
    expect(aresItemTargetsWorker(item(["ares.analyze.local"], ["ares"]), "ares")).toBe(true);
    expect(aresItemTargetsWorker(item(["ares.analyze.local"], ["ares"]), "other-worker")).toBe(false);
    expect(aresItemTargetsWorker(item(["ares.analyze.local"], []), "ares")).toBe(false);
    expect(aresItemTargetsWorker(item(["system.status"], []), "anyone")).toBe(true);
  });

  it("fails closed for a stored mixed item: targeting uses the broader 'mentions' definition", () => {
    // Even a named worker must not claim malformed persisted ARES work.
    expect(aresItemTargetsWorker(item(["ares.analyze.local", "system.status"], ["ares"]), "other-worker")).toBe(false);
    expect(aresItemTargetsWorker(item(["ares.analyze.local", "system.status"], ["ares"]), "ares")).toBe(false);
  });
});
