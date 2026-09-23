export interface SseFrame {
  event: string;
  data: string;
}

/**
 * Incremental Server-Sent-Events frame parser. The gateway names each frame
 * after the audit event (`event: work_item.needs_approval`), which the browser
 * EventSource API cannot subscribe to generically, so frames are parsed from a
 * fetch stream. Comment lines (`:`) and unknown fields are ignored per the spec.
 */
export class SseParser {
  private buffer = "";
  private event = "";
  private data: string[] = [];

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    let index: number;
    // Lines end with \n, \r\n, or \r.
    while ((index = this.nextLineEnd()) !== -1) {
      const raw = this.buffer.slice(0, index);
      const skip = this.buffer.startsWith("\r\n", index) ? 2 : 1;
      this.buffer = this.buffer.slice(index + skip);
      const frame = this.line(raw);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  private nextLineEnd(): number {
    const lf = this.buffer.indexOf("\n");
    const cr = this.buffer.indexOf("\r");
    if (lf === -1) {
      // A trailing bare \r may be half of \r\n that has not fully arrived.
      return cr !== -1 && cr < this.buffer.length - 1 ? cr : -1;
    }
    return cr !== -1 && cr < lf ? cr : lf;
  }

  private line(line: string): SseFrame | undefined {
    if (line === "") {
      if (this.data.length === 0 && this.event === "") return undefined;
      const frame = { event: this.event || "message", data: this.data.join("\n") };
      this.event = "";
      this.data = [];
      return frame;
    }
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    return undefined;
  }
}
