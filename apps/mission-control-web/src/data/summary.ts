/**
 * Client for POST /api/mission-control/summaries/open-items.
 *
 * EventSource is GET-only, so this reads the POST response body as a stream. The
 * request carries no data: the gateway builds the context from what the session may read.
 * Same-origin, so no CSP change is needed and no token is held by the page.
 */
export const OPEN_ITEMS_SUMMARY_URL = "/api/mission-control/summaries/open-items";

export type SummaryErrorCode = "auth" | "rate_limited" | "unavailable" | "failed" | "aborted";

export interface SummaryHandlers {
  onDelta(text: string): void;
  onDone(): void;
  onError(code: SummaryErrorCode): void;
}

/** Splits complete SSE frames off the buffer and returns the unfinished tail. */
export function takeSseFrames(buffer: string): { frames: { event: string; data: string }[]; rest: string } {
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? "";
  const frames = parts
    .map((raw) => {
      let event = "message";
      const data: string[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      return { event, data: data.join("\n") };
    })
    .filter((frame) => frame.data.length > 0);
  return { frames, rest };
}

const statusCode = (status: number): SummaryErrorCode => {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status === 503) return "unavailable";
  return "failed";
};

const errorCodes: readonly SummaryErrorCode[] = ["auth", "rate_limited", "unavailable", "failed", "aborted"];
const normalizeCode = (value: unknown): SummaryErrorCode =>
  errorCodes.includes(value as SummaryErrorCode) ? (value as SummaryErrorCode) : "failed";

export async function streamOpenItemsSummary(
  handlers: SummaryHandlers,
  options: { signal: AbortSignal; fetchImpl?: typeof fetch }
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const fail = (): SummaryErrorCode => (options.signal.aborted ? "aborted" : "failed");

  let response: Response;
  try {
    response = await fetchImpl(OPEN_ITEMS_SUMMARY_URL, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "text/event-stream" },
      signal: options.signal
    });
  } catch {
    handlers.onError(fail());
    return;
  }
  if (!response.ok) {
    handlers.onError(statusCode(response.status));
    return;
  }
  if (!response.body) {
    handlers.onError("failed");
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  try {
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = takeSseFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        if (frame.event === "done") {
          finished = true;
          handlers.onDone();
          break;
        }
        if (frame.event === "error") {
          finished = true;
          let code: unknown;
          try {
            code = (JSON.parse(frame.data) as { code?: unknown }).code;
          } catch {
            code = undefined;
          }
          handlers.onError(normalizeCode(code));
          break;
        }
        if (frame.event === "delta") {
          let text: unknown;
          try {
            text = (JSON.parse(frame.data) as { text?: unknown }).text;
          } catch {
            text = undefined;
          }
          if (typeof text !== "string") {
            finished = true;
            handlers.onError("failed");
            break;
          }
          handlers.onDelta(text);
        }
      }
    }
    if (!finished) handlers.onError(fail());
  } catch {
    handlers.onError(fail());
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
