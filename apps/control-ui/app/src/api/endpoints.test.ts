import { describe, expect, it, vi } from "vitest";
import { AcsClient } from "./client";
import { createEndpoints } from "./endpoints";

describe("execution detail projections", () => {
  it("reads detail and current plan with encoded resource identity and the same cancellation signal", async () => {
    const signal = new AbortController().signal;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        Response.json(String(url).endsWith("/execution-plan") ? { plan: null } : { workItem: { id: "work/a" } })
      );
    const endpoints = createEndpoints(new AcsClient({ fetcher }));
    expect(await endpoints.getWorkItem("work/a", signal)).toEqual({ workItem: { id: "work/a" }, executionPlan: null });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "/work-items/work%2Fa?limit=500",
      "/work-items/work%2Fa/execution-plan"
    ]);
    expect(
      fetcher.mock.calls.every(([, options]) => options?.signal === signal && options.credentials === "same-origin")
    ).toBe(true);
  });

  it("does not present partial detail as authoritative when the plan read is unauthorized", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        String(url).endsWith("/execution-plan")
          ? Response.json({ error: "unauthorized" }, { status: 401 })
          : Response.json({ workItem: { id: "work" } })
      );
    const endpoints = createEndpoints(new AcsClient({ fetcher }));
    await expect(endpoints.getWorkItem("work")).rejects.toMatchObject({ status: 401 });
  });
});
