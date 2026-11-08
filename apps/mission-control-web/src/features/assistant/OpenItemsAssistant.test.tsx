// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OpenItemsAssistant } from "./OpenItemsAssistant";

const encoder = new TextEncoder();
const streamResponse = (chunks: string[], status = 200) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      }
    }),
    { status, headers: { "content-type": "text/event-stream" } }
  );

const summarizeButton = () => screen.getByRole("button", { name: "Summarize today’s open items" });

afterEach(() => cleanup());

describe("OpenItemsAssistant", () => {
  it("opens from the floating button and streams the summary as plain text", async () => {
    const fetchImpl = (async () =>
      streamResponse([
        'event: delta\ndata: {"text":"Two open. "}\n\n',
        'event: delta\ndata: {"text":"<img src=x onerror=alert(1)>"}\n\nevent: done\ndata: {}\n\n'
      ])) as unknown as typeof fetch;
    render(<OpenItemsAssistant fetchImpl={fetchImpl} />);
    fireEvent.click(screen.getByRole("button", { name: "Open assistant" }));
    fireEvent.click(summarizeButton());
    await waitFor(() => expect(screen.getByRole("log").textContent).toBe("Two open. <img src=x onerror=alert(1)>"));
    expect(screen.getByRole("log").querySelector("img")).toBeNull();
    expect((summarizeButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a fail-closed message when the gateway has no summary configured", async () => {
    const fetchImpl = (async () => streamResponse(["{}"], 503)) as unknown as typeof fetch;
    render(<OpenItemsAssistant fetchImpl={fetchImpl} />);
    fireEvent.click(screen.getByRole("button", { name: "Open assistant" }));
    fireEvent.click(summarizeButton());
    expect((await screen.findByRole("alert")).textContent).toContain("not configured");
  });

  it("asks the user to sign in when the session has no read access", async () => {
    const fetchImpl = (async () => streamResponse(["{}"], 401)) as unknown as typeof fetch;
    render(<OpenItemsAssistant fetchImpl={fetchImpl} />);
    fireEvent.click(screen.getByRole("button", { name: "Open assistant" }));
    fireEvent.click(summarizeButton());
    expect((await screen.findByRole("alert")).textContent).toContain("Sign in");
  });
});
