import { useEffect, useRef, useState } from "react";
import { streamOpenItemsSummary, type SummaryErrorCode } from "../../data/summary";

type Phase = "idle" | "streaming" | "done" | "error";

const errorText: Record<SummaryErrorCode, string> = {
  auth: "Sign in to Mission Control to see open items.",
  rate_limited: "Too many requests. Try again in a minute.",
  unavailable: "The summary service is not configured on this gateway.",
  failed: "The summary could not be generated. Try again.",
  aborted: ""
};

/**
 * Floating assistant for the Mission Control main dashboard. Output is set as text
 * content only, never as HTML, so model output cannot inject markup or script.
 */
export function OpenItemsAssistant({ fetchImpl }: { fetchImpl?: typeof fetch }) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [text, setText] = useState("");
  const [code, setCode] = useState<SummaryErrorCode | undefined>(undefined);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const reset = () => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setPhase("idle");
    setText("");
    setCode(undefined);
  };

  const close = () => {
    reset();
    setOpen(false);
  };

  const summarize = () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setText("");
    setCode(undefined);
    setPhase("streaming");
    void streamOpenItemsSummary(
      {
        onDelta: (chunk) => setText((previous) => previous + chunk),
        onDone: () => {
          if (controllerRef.current === controller) setPhase("done");
        },
        onError: (errorCode) => {
          if (controllerRef.current !== controller || errorCode === "aborted") return;
          setCode(errorCode);
          setPhase("error");
        }
      },
      { signal: controller.signal, fetchImpl }
    );
  };

  return (
    <>
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-label={open ? "Close assistant" : "Open assistant"}
        className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-orange-500 text-white shadow-lg transition-colors hover:bg-orange-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-300"
      >
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M4 5h16v11H9l-5 4z" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <section
          aria-label="Open items assistant"
          className="fixed bottom-24 right-6 z-40 flex max-h-[70vh] w-[min(26rem,calc(100vw-3rem))] flex-col gap-3 rounded-ctl border border-line bg-surface p-4 shadow-xl"
        >
          <header className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-ink">Open items assistant</h2>
            <button type="button" onClick={close} className="rounded-ctl px-2 py-1 text-sm text-muted hover:text-ink">
              Close
            </button>
          </header>
          <button
            type="button"
            onClick={summarize}
            disabled={phase === "streaming"}
            className="rounded-ctl border border-line bg-surface-2 px-3 py-2 text-left text-sm text-ink hover:border-accent disabled:cursor-wait disabled:opacity-60"
          >
            {phase === "streaming" ? "Summarizing…" : "Summarize today’s open items"}
          </button>
          <div
            role="log"
            aria-live="polite"
            aria-busy={phase === "streaming"}
            className="min-h-24 flex-1 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-ink"
          >
            {text}
          </div>
          {phase === "error" && code && <p role="alert" className="text-sm text-warn">{errorText[code]}</p>}
        </section>
      )}
    </>
  );
}
