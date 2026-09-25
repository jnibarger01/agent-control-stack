import { Model, type ModelStreamEvent, type Message, type StreamOptions } from "@strands-agents/sdk";

/** Deterministic model: one tool call, then a final text turn. Test-only. */
export class ScriptedToolModel extends Model {
  seen: Message[][] = [];
  advertised: string[] = [];
  constructor(
    private readonly name = "list_directory",
    private readonly args: Record<string, unknown> = { path: "/repo" }
  ) {
    super();
  }
  updateConfig() {}
  getConfig() {
    return { modelId: "scripted" };
  }
  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    this.advertised = options?.toolSpecs?.map((t) => t.name) ?? [];
    this.seen.push(messages.slice());
    yield { type: "modelMessageStartEvent", role: "assistant" };
    if (this.seen.length === 1) {
      yield {
        type: "modelContentBlockStartEvent",
        start: { type: "toolUseStart", name: this.name, toolUseId: "call-1" }
      };
      yield {
        type: "modelContentBlockDeltaEvent",
        delta: { type: "toolUseInputDelta", input: JSON.stringify(this.args) }
      };
      yield { type: "modelContentBlockStopEvent" };
      yield { type: "modelMessageStopEvent", stopReason: "toolUse" };
    } else {
      yield { type: "modelContentBlockStartEvent" };
      yield { type: "modelContentBlockDeltaEvent", delta: { type: "textDelta", text: "Finished." } };
      yield { type: "modelContentBlockStopEvent" };
      yield { type: "modelMessageStopEvent", stopReason: "endTurn" };
    }
  }
}
