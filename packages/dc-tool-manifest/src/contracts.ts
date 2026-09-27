import { DC_TRANSPORT_METADATA_ARGUMENT_KEYS, DC_TRANSPORT_METADATA_VALUES, dcToolContracts } from "./manifest.js";

/**
 * Derived JSON projections of the manifest. These are what
 * contracts/desktop-commander/*.json and the Desktop Commander test fixtures
 * contain; scripts/dc-tool-manifest.ts writes/checks the files.
 */

export const MANAGED_TOOL_COVERAGE_CONTRACT = "acs.dc.v1/managed-tool-coverage" as const;
export const MANAGED_TOOL_COVERAGE_PATH = "contracts/desktop-commander/managed-tool-coverage.v1.json" as const;
export const AUTHORIZATION_ARGUMENTS_PATH = "contracts/desktop-commander/authorization-arguments.v1.json" as const;

export interface ManagedToolCoverageEntry {
  readonly toolClass: string;
  readonly managed: "capability" | "unsupported";
  readonly scopes?: readonly string[];
  readonly requiresApproval?: boolean;
}

export interface ManagedToolCoverageDocument {
  readonly contract: typeof MANAGED_TOOL_COVERAGE_CONTRACT;
  readonly version: 1;
  readonly doc: string;
  readonly note: string;
  readonly tools: Readonly<Record<string, ManagedToolCoverageEntry>>;
}

export function managedToolCoverageDocument(): ManagedToolCoverageDocument {
  const tools: Record<string, ManagedToolCoverageEntry> = {};
  for (const entry of dcToolContracts()) {
    tools[entry.name] =
      entry.managed === "capability"
        ? {
            toolClass: entry.toolClass,
            managed: "capability",
            scopes: [entry.scope],
            requiresApproval: entry.requiresApproval
          }
        : { toolClass: entry.toolClass, managed: "unsupported" };
  }
  return {
    contract: MANAGED_TOOL_COVERAGE_CONTRACT,
    version: 1,
    doc: "docs/protocol/dc-authorization-arguments.md",
    note: "Every tool Desktop Commander registers must appear here with an explicit managed disposition. Pinned byte-identically in the Desktop Commander repository.",
    tools
  };
}

/**
 * The manifest-owned fields of the authorization-arguments contract. The rest
 * of that file is a conformance-case corpus (raw -> authorizationArguments ->
 * delivered) that ACS and Desktop Commander both replay; the generator checks
 * these fields and that every case names a capability tool.
 */
export function authorizationArgumentsMetadata(): {
  transportMetadataKeys: string[];
  transportMetadataValues: Record<string, string[]>;
} {
  return {
    transportMetadataKeys: [...DC_TRANSPORT_METADATA_ARGUMENT_KEYS],
    transportMetadataValues: Object.fromEntries(
      Object.entries(DC_TRANSPORT_METADATA_VALUES).map(([key, values]) => [key, [...values]])
    )
  };
}
