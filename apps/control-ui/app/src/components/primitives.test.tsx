// @vitest-environment jsdom
import { act } from "react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, click, render } from "../test-utils";
import { DataTable } from "./DataTable";
import { Tabs } from "./Tabs";

afterEach(cleanup);

const key = (el: Element, k: string) =>
  act(async () => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));

describe("Tabs (WAI-ARIA)", () => {
  function Harness() {
    const [active, setActive] = useState("a");
    return (
      <Tabs
        tabs={[
          { id: "a", label: "Alpha" },
          { id: "b", label: "Beta" },
          { id: "c", label: "Gamma" }
        ]}
        active={active}
        onChange={setActive}
        label="Sections"
      >
        <p>panel {active}</p>
      </Tabs>
    );
  }

  it("uses roving tabindex, aria-selected and a labelled tabpanel", async () => {
    const { container } = await render(<Harness />);
    const tabs = [...container.querySelectorAll("[role=tab]")];
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    const panel = container.querySelector("[role=tabpanel]")!;
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs[0]!.id);
    expect(tabs[0]!.getAttribute("aria-controls")).toBe(panel.id);
    expect(container.querySelector("[role=tablist]")?.getAttribute("aria-label")).toBe("Sections");
  });

  it("arrow keys, Home and End move selection and focus, wrapping around", async () => {
    const { container } = await render(<Harness />);
    const list = container.querySelector("[role=tablist]")!;
    await key(list, "ArrowRight");
    expect(container.querySelector("[role=tabpanel]")?.textContent).toBe("panel b");
    expect(document.activeElement?.textContent).toBe("Beta");
    await key(list, "End");
    expect(container.querySelector("[role=tabpanel]")?.textContent).toBe("panel c");
    await key(list, "ArrowRight");
    expect(container.querySelector("[role=tabpanel]")?.textContent).toBe("panel a");
    await key(list, "ArrowLeft");
    expect(container.querySelector("[role=tabpanel]")?.textContent).toBe("panel c");
    await key(list, "Home");
    expect(container.querySelector("[role=tabpanel]")?.textContent).toBe("panel a");
  });

  it("clicking a tab selects it", async () => {
    const { container } = await render(<Harness />);
    await click([...container.querySelectorAll("[role=tab]")][1]);
    expect(container.querySelector("[role=tabpanel]")?.textContent).toBe("panel b");
  });
});

describe("DataTable", () => {
  const rows = [
    { id: "1", n: "one" },
    { id: "2", n: "two" }
  ];
  const columns = [
    { id: "n", header: "Name", sortKey: "n", cell: (r: (typeof rows)[number]) => r.n },
    { id: "act", header: "", cell: () => <button type="button">Go</button> }
  ];

  it("rows activate with Enter and Space, expose aria-selected, and headers have accessible names", async () => {
    const onActivate = vi.fn();
    const { container } = await render(
      <DataTable
        caption="Things"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        selectedKey="2"
        onRowActivate={onActivate}
      />
    );
    const tr = [...container.querySelectorAll("tbody tr")];
    expect(tr.map((r) => r.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    await key(tr[0]!, "Enter");
    await key(tr[1]!, " ");
    expect(onActivate.mock.calls.map((c) => c[0].id)).toEqual(["1", "2"]);
    for (const th of container.querySelectorAll("th")) expect((th.textContent ?? "").trim().length).toBeGreaterThan(0);
    expect(container.querySelector("caption")?.textContent).toBe("Things");
  });

  it("a click on an inner button does not double-activate via keyboard handler", async () => {
    const onActivate = vi.fn();
    const { container } = await render(
      <DataTable caption="Things" columns={columns} rows={rows} rowKey={(r) => r.id} onRowActivate={onActivate} />
    );
    await key(container.querySelector("tbody button")!, "Enter");
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("sortable headers report aria-sort", async () => {
    const onSort = vi.fn();
    const { container } = await render(
      <DataTable
        caption="T"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        sort={{ key: "n", dir: "desc" }}
        onSort={onSort}
      />
    );
    expect(container.querySelector("th")?.getAttribute("aria-sort")).toBe("descending");
    await click(container.querySelector("th button"));
    expect(onSort).toHaveBeenCalledWith("n");
  });
});
