import { describe, expect, it } from "vitest";
import { nextReconnectDelayMs } from "./events";
import { SseParser } from "./sse-parse";

describe("SseParser", () => {
  it("parses the gateway's named frames", () => {
    const parser = new SseParser();
    expect(parser.push('event: ready\ndata: {}\n\nevent: work_item.needs_approval\ndata: {"id":"e1"}\n\n')).toEqual([
      { event: "ready", data: "{}" },
      { event: "work_item.needs_approval", data: '{"id":"e1"}' }
    ]);
  });

  it("reassembles frames split across arbitrary chunk boundaries", () => {
    const parser = new SseParser();
    const frames = [...'event: a.b\ndata: {"x":1}\n\n'].flatMap((char) => parser.push(char));
    expect(frames).toEqual([{ event: "a.b", data: '{"x":1}' }]);
  });

  it("handles CRLF, comments, multi-line data and unknown fields", () => {
    const parser = new SseParser();
    expect(parser.push(": keepalive\r\nevent: x\r\nid: 5\r\ndata: one\r\ndata: two\r\n\r\n")).toEqual([
      { event: "x", data: "one\ntwo" }
    ]);
  });

  it("defaults the event name to 'message' and ignores empty frames", () => {
    const parser = new SseParser();
    expect(parser.push("\n\ndata: hi\n\n")).toEqual([{ event: "message", data: "hi" }]);
  });
});

describe("reconnect backoff", () => {
  it("is 1s,2s,4s,8s,16s then capped at 30s", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 50].map(nextReconnectDelayMs)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000
    ]);
  });
});
