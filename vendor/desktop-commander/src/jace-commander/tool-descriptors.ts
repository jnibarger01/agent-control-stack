/**
 * Dependency-free MCP tools/list descriptors for Jace Commander.
 *
 * Derived from the generated manifest (manifest.generated.ts, pure data from
 * packages/jc-tool-manifest), so this module stays importable without the MCP
 * SDK and there is no second hand-maintained tool list. The root drift test
 * compares these descriptors with the manifest's jcMcpToolDescriptors().
 */
import { JC_MANIFEST } from './manifest.generated.js';

export interface JcToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export const JC_TOOLS: ReadonlyArray<JcToolDescriptor> = Object.freeze(
  JC_MANIFEST.tools.map(({ name, description, inputSchema }) => Object.freeze({ name, description, inputSchema })),
);
