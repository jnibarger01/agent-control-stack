/**
 * JSON Schema tool registry for Jace Commander.
 *
 * Exposes every MCP tool with its JSON Schema input definition and manifest
 * metadata from a single canonical source (the generated JC manifest). This is
 * the registry used by the MCP server, the Streamable HTTP transport, and
 * external consumers that need to inspect available tools and their schemas.
 */
import { JC_MANIFEST, type JcManifestTool } from './manifest.generated.js';
import { JC_TOOLS, type JcToolDescriptor } from './tool-descriptors.js';

export interface JcRegisteredTool extends JcToolDescriptor {
  readonly scopes: readonly string[];
  readonly actionKind: string;
  readonly risk: string;
  readonly requiresApproval: boolean;
  readonly group: string;
  readonly pathArguments: readonly string[];
  readonly cliCommands: readonly string[];
}

function toRegistered(tool: JcManifestTool): JcRegisteredTool {
  return Object.freeze({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    scopes: tool.scopes,
    actionKind: tool.actionKind,
    risk: tool.risk,
    requiresApproval: tool.requiresApproval,
    group: tool.group,
    pathArguments: tool.pathArguments,
    cliCommands: tool.cliCommands,
  });
}

/** All tools in manifest order, each carrying its JSON Schema inputSchema. */
export const JC_TOOL_REGISTRY: ReadonlyArray<JcRegisteredTool> = Object.freeze(
  JC_MANIFEST.tools.map(toRegistered),
);

export function getToolRegistry(): ReadonlyArray<JcRegisteredTool> {
  return JC_TOOL_REGISTRY;
}

export function getToolByName(name: string): JcRegisteredTool | undefined {
  return JC_TOOL_REGISTRY.find((tool) => tool.name === name);
}

/** MCP tools/list-compatible descriptors (name, description, inputSchema). */
export function listToolDescriptors(): ReadonlyArray<JcToolDescriptor> {
  return JC_TOOLS;
}

export function toolRegistryJson(): { version: string; manifestHash: string; tools: ReadonlyArray<JcRegisteredTool> } {
  return {
    version: JC_MANIFEST.version,
    manifestHash: JC_MANIFEST.manifestHash,
    tools: JC_TOOL_REGISTRY,
  };
}
