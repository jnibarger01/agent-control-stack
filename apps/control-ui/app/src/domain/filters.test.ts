import { describe, expect, it } from "vitest";
import { workItem } from "../test-fixtures";
import {
  applyWorkFilters,
  DEFAULT_WORK_FILTERS,
  paginate,
  parseWorkFilters,
  serializeWorkFilters,
  workItemSource,
  workItemTargetLabel,
  type WorkFilters
} from "./filters";

const NOW = Date.parse("2026-09-19T12:00:00.000Z");
const items = [
  workItem({
    id: "wrk_a",
    title: "Alpha deploy",
    status: "needs_approval",
    risk: "high",
    createdAt: "2026-09-19T11:30:00.000Z",
    updatedAt: "2026-09-19T11:30:00.000Z"
  }),
  workItem({
    id: "wrk_b",
    title: "Beta read",
    status: "succeeded",
    risk: "low",
    requesterSubject: "op-2",
    createdAt: "2026-09-10T11:30:00.000Z",
    updatedAt: "2026-09-10T11:30:00.000Z"
  }),
  workItem({
    id: "wrk_c",
    title: "Gamma",
    status: "blocked",
    risk: "critical",
    lineageType: "retry",
    createdAt: "2026-09-18T11:30:00.000Z",
    updatedAt: "2026-09-19T11:59:00.000Z"
  })
];
const f = (over: Partial<WorkFilters>): WorkFilters => ({ ...DEFAULT_WORK_FILTERS, ...over });

describe("work filters", () => {
  it("filters by status, risk, requester, source, worker, window, attention", () => {
    expect(applyWorkFilters(items, f({ status: "blocked" }), NOW).map((i) => i.id)).toEqual(["wrk_c"]);
    expect(applyWorkFilters(items, f({ risk: "high" }), NOW).map((i) => i.id)).toEqual(["wrk_a"]);
    expect(applyWorkFilters(items, f({ requester: "op-2" }), NOW).map((i) => i.id)).toEqual(["wrk_b"]);
    expect(applyWorkFilters(items, f({ source: "retry" }), NOW).map((i) => i.id)).toEqual(["wrk_c"]);
    expect(
      applyWorkFilters(items, f({ agent: "worker-1" }), NOW, new Map([["wrk_b", "worker-1"]])).map((i) => i.id)
    ).toEqual(["wrk_b"]);
    expect(applyWorkFilters(items, f({ window: "24h" }), NOW).map((i) => i.id)).toEqual(["wrk_a"]);
    expect(
      applyWorkFilters(items, f({ window: "7d" }), NOW)
        .map((i) => i.id)
        .sort()
    ).toEqual(["wrk_a", "wrk_c"]);
    expect(
      applyWorkFilters(items, f({ attention: true }), NOW)
        .map((i) => i.id)
        .sort()
    ).toEqual(["wrk_a", "wrk_c"]);
  });
  it("text search matches id, title, intent, requester and target case-insensitively", () => {
    expect(applyWorkFilters(items, f({ q: "ALPHA" }), NOW).map((i) => i.id)).toEqual(["wrk_a"]);
    expect(applyWorkFilters(items, f({ q: "wrk_b" }), NOW).map((i) => i.id)).toEqual(["wrk_b"]);
    expect(applyWorkFilters(items, f({ q: "no such thing" }), NOW)).toEqual([]);
  });
  it("sorts by created (default desc), risk, title and reverses direction", () => {
    expect(applyWorkFilters(items, f({}), NOW).map((i) => i.id)).toEqual(["wrk_a", "wrk_c", "wrk_b"]);
    expect(applyWorkFilters(items, f({ sort: "risk", dir: "desc" }), NOW).map((i) => i.id)).toEqual([
      "wrk_c",
      "wrk_a",
      "wrk_b"
    ]);
    expect(applyWorkFilters(items, f({ sort: "title", dir: "asc" }), NOW).map((i) => i.title)).toEqual([
      "Alpha deploy",
      "Beta read",
      "Gamma"
    ]);
    expect(applyWorkFilters(items, f({ sort: "updated", dir: "asc" }), NOW)[0]?.id).toBe("wrk_b");
  });
  it("does not mutate its input", () => {
    const copy = [...items];
    applyWorkFilters(items, f({ sort: "title" }), NOW);
    expect(items).toEqual(copy);
  });
  it("round-trips filters through the URL, omitting defaults", () => {
    const filters = f({ q: "x y", status: "blocked", attention: true, sort: "risk", dir: "asc" });
    const params = serializeWorkFilters(filters);
    expect(params.toString()).toBe("q=x+y&status=blocked&attention=1&sort=risk&dir=asc");
    expect(parseWorkFilters(params)).toEqual(filters);
    expect(serializeWorkFilters(DEFAULT_WORK_FILTERS).toString()).toBe("");
  });
  it("ignores hostile sort/dir values from the URL", () => {
    expect(parseWorkFilters(new URLSearchParams("sort=__proto__&dir=sideways"))).toMatchObject({
      sort: "created",
      dir: "desc"
    });
  });
  it("paginates and clamps out-of-range pages", () => {
    const many = Array.from({ length: 55 }, (_, i) => i);
    expect(paginate(many, 1, 25)).toMatchObject({ pages: 3, page: 1 });
    expect(paginate(many, 3, 25).rows).toHaveLength(5);
    expect(paginate(many, 99, 25).page).toBe(3);
    expect(paginate(many, -4, 25).page).toBe(1);
    expect(paginate([], 1, 25)).toEqual({ rows: [], pages: 1, page: 1 });
  });
  it("derives origin and target labels", () => {
    expect(workItemSource(items[2]!)).toBe("retry");
    expect(workItemSource(items[0]!)).toBe("direct");
    expect(workItemSource(workItem({ metadata: { webhookSource: "hermes" }, lineageType: "clone" }))).toBe("hermes");
    expect(workItemTargetLabel(workItem({ target: { services: ["build-svc"], cwd: "/x" } }))).toBe("build-svc");
    expect(workItemTargetLabel(workItem({ target: {} }))).toBe("—");
  });
});
