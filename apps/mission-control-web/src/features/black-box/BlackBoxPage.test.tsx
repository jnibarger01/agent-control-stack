// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NAV_ITEMS } from "../../shell/nav";
import { BlackBoxPage } from "./BlackBoxPage";

afterEach(() => cleanup());

describe("Agent Black Box page", () => {
  it("is not one of the default eleven destinations", () => {
    expect(NAV_ITEMS.map((item) => item.key)).not.toContain("black-box");
    expect(NAV_ITEMS).toHaveLength(11);
  });

  it("loads the labeled snapshot and does not call it a live connection", async () => {
    render(<BlackBoxPage />);
    expect(await screen.findByRole("heading", { name: "Agent Black Box" })).toBeTruthy();
    expect(screen.getByText(/not a live socket/i)).toBeTruthy();
    expect(await screen.findByText(/100\s*runs/)).toBeTruthy();
    expect(screen.getByText(/abbr\.unverified-success/)).toBeTruthy();
  });
});
