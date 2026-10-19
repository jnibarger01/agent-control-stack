// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextReconnectDelayMs, useEventStream, type EventSourceLike, type StreamState } from "./stream";

class FakeSource implements EventSourceLike {
  static all: FakeSource[] = [];
  listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  closed = false;
  constructor() { FakeSource.all.push(this); }
  addEventListener(type: string, l: (e: MessageEvent) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]); }
  close() { this.closed = true; }
  emit(type: string) { for (const l of this.listeners.get(type) ?? []) l(new MessageEvent(type)); }
}

function Probe({ onState, onEvent, onReconnect }: { onState: (s: StreamState) => void; onEvent: (n: string) => void; onReconnect: () => void }) {
  const state = useEventStream(onEvent, onReconnect, () => new FakeSource());
  onState(state);
  return null;
}

describe("useEventStream", () => {
  beforeEach(() => { vi.useFakeTimers(); FakeSource.all = []; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("follows the legacy backoff schedule", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(nextReconnectDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(nextReconnectDelayMs(Number.NaN)).toBe(1000);
  });

  it("goes live, reports events, goes stale on error, then reconnects and asks to catch up", () => {
    const states: StreamState[] = [];
    const events: string[] = [];
    const onReconnect = vi.fn();
    render(<Probe onState={(s) => states.push(s)} onEvent={(n) => events.push(n)} onReconnect={onReconnect} />);
    const first = FakeSource.all[0]!;
    expect(states.at(-1)).toBe("connecting");
    act(() => first.emit("open"));
    expect(states.at(-1)).toBe("live");
    act(() => first.emit("work_item.running"));
    expect(events).toEqual(["work_item.running"]);
    expect(onReconnect).not.toHaveBeenCalled();

    act(() => first.emit("error"));
    expect(first.closed).toBe(true);
    expect(states.at(-1)).toBe("stale");
    act(() => { vi.advanceTimersByTime(1000); });
    expect(FakeSource.all).toHaveLength(2);
    act(() => FakeSource.all[1]!.emit("open"));
    expect(states.at(-1)).toBe("live");
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("closes the stream on unmount", () => {
    const { unmount } = render(<Probe onState={() => undefined} onEvent={() => undefined} onReconnect={() => undefined} />);
    unmount();
    expect(FakeSource.all[0]!.closed).toBe(true);
  });
});
