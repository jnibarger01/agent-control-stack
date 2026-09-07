import type { ZodTypeAny } from 'zod';
import { getManagedAcsToolPolicy, type ManagedToolPolicy } from '../managed-acs.js';
import { toolArgSchemas } from './schemas.js';

export interface ToolContract {
  readonly name: string;
  readonly args: ZodTypeAny;
  readonly managedAcs: ManagedToolPolicy | undefined;
}

const TOOL_REGISTRY: Readonly<Record<string, ToolContract>> = Object.freeze(
  Object.fromEntries(
    Object.entries(toolArgSchemas).map(([name, args]) => [name, Object.freeze({
      name,
      args,
      managedAcs: getManagedAcsToolPolicy(name),
    })]),
  ),
);

export function getToolContract(name: string): ToolContract | undefined {
  return TOOL_REGISTRY[name];
}

export function listToolContracts(): readonly ToolContract[] {
  return Object.values(TOOL_REGISTRY);
}
