/**
 * The MCP tools/list surface, derived from the generated manifest (the only
 * tool list in this package). Adding a tool means adding it to
 * packages/jc-tool-manifest, regenerating, and adding a handler in server.ts.
 * Dependency-free: manifest.generated.ts is plain data.
 */
import { JC_MANIFEST } from './manifest.generated.js';

export const JC_TOOLS: ReadonlyArray<{ name: string; description: string; inputSchema: Readonly<Record<string, unknown>> }> = Object.freeze(
  JC_MANIFEST.tools.map(({ name, description, inputSchema }) => Object.freeze({ name, description, inputSchema })),
);
