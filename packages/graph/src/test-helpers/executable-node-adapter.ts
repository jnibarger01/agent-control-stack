import type { NodeAdapter, NodeAdapterContext } from "../adapter.js";

export type ExecutableTestHandler = (context: NodeAdapterContext) => unknown | Promise<unknown>;

/** Test-only callback adapter. It is intentionally absent from the package index and rejected by StaticGraphScheduler. */
export class ExecutableTestNodeAdapter implements NodeAdapter {
  readonly adapterId = "fake";
  readonly sideEffectFree = false;

  constructor(private readonly handlers: Readonly<Record<string, ExecutableTestHandler>>) {}

  async execute(context: NodeAdapterContext): Promise<unknown> {
    const handler = this.handlers[context.node.id];
    if (!handler) {
      throw new Error(`no executable test handler declared for node ${context.node.id}`);
    }
    return handler(context);
  }
}
