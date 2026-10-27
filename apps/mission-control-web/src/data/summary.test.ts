import { describe, expect, it } from "vitest";
import { OPEN_ITEMS_SUMMARY_URL, streamOpenItemsSummary, takeSseFrames, type SummaryErrorCode } from "./summary";

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

async function run(fetchImpl: typeof fetch) {
  const deltas: string[] = [];
  const outcome: { done: boolean; error?: SummaryErrorCode } = { done: false };
  await streamOpenItemsSummary(
    {
      onDelta: (text) => deltas.push(text),
      onDone: () => (outcome.done = true),
      onError: (code) => (outcome.error = code)
    },
    { signal: new AbortController().signal, fetchImpl }
  );
  return { deltas, outcome };
}

describe("takeSseFrames", () => {
  it("returns complete frames and keeps the partial tail", () => {
    const { frames, rest } = takeSseFrames('event: delta\ndata: {"text":"a"}\n\nevent: do');
    expect(frames).toEqual([{ event: "delta", data: '{"text":"a"}' }]);
    expect(rest).toBe("event: do");
  });
});

describe("streamOpenItemsSummary", () => {
  it("posts with no body to the same-origin summary route", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return streamResponse(['event: done\ndata: {}\n\n']);
    }) as unknown as typeof fetch;
    await run(fetchImpl);
    expect(seen!.url).toBe(OPEN_ITEMS_SUMMARY_URL);
    expect(seen!.init.method).toBe("POST");
    expect(seen!.init.body).toBeUndefined();
    expect(seen!.init.credentials).toBe("same-origin");
  });

  it("streams deltas split across chunks and reports completion", async () => {
    const fetchImpl = (async () =>
      streamResponse([
        'event: delta\ndata: {"text":"Two "}\n\nevent: del',
        'ta\ndata: {"text":"items"}\n\nevent: done\ndata: {}\n\n'
      ])) as unknown as typeof fetch;
    const { deltas, outcome } = await run(fetchImpl);
    expect(deltas).toEqual(["Two ", "items"]);
    expect(outcome).toEqual({ done: true });
  });

  it("maps HTTP failures to fail-closed error codes", async () => {
    const cases: [number, SummaryErrorCode][] = [
      [401, "auth"],
      [403, "auth"],
      [429, "rate_limited"],
      [503, "unavailable"],
      [500, "failed"]
    ];
    for (const [status, code] of cases) {
      const fetchImpl = (async () => new Response("{}", { status })) as unknown as typeof fetch;
      expect((await run(fetchImpl)).outcome.error).toBe(code);
    }
  });

  it("treats an unknown error code or a stream that ends early as a failure", async () => {
    const unknownCode = (async () =>
      streamResponse(['event: error\ndata: {"code":"something_else"}\n\n'])) as unknown as typeof fetch;
    expect((await run(unknownCode)).outcome.error).toBe("failed");

    const truncated = (async () =>
      streamResponse(['event: delta\ndata: {"text":"partial"}\n\n'])) as unknown as typeof fetch;
    const result = await run(truncated);
    expect(result.deltas).toEqual(["partial"]);
    expect(result.outcome).toEqual({ done: false, error: "failed" });
  });
});
