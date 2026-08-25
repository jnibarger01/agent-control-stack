import {
  acpxListSessions,
  acpxGetSession,
  acpxExec,
  acpxPrompt,
  acpxCancel,
} from '../tools/acpx.js';

import {
  AcpxListSessionsArgsSchema,
  AcpxGetSessionArgsSchema,
  AcpxExecArgsSchema,
  AcpxPromptArgsSchema,
  AcpxCancelArgsSchema,
} from '../tools/schemas.js';

import { ServerResult } from '../types.js';

export async function handleAcpxListSessions(args: unknown): Promise<ServerResult> {
  const parsed = AcpxListSessionsArgsSchema.parse(args);
  return acpxListSessions(parsed);
}

export async function handleAcpxGetSession(args: unknown): Promise<ServerResult> {
  const parsed = AcpxGetSessionArgsSchema.parse(args);
  return acpxGetSession(parsed);
}

export async function handleAcpxExec(args: unknown): Promise<ServerResult> {
  const parsed = AcpxExecArgsSchema.parse(args);
  return acpxExec(parsed);
}

export async function handleAcpxPrompt(args: unknown): Promise<ServerResult> {
  const parsed = AcpxPromptArgsSchema.parse(args);
  return acpxPrompt(parsed);
}

export async function handleAcpxCancel(args: unknown): Promise<ServerResult> {
  const parsed = AcpxCancelArgsSchema.parse(args);
  return acpxCancel(parsed);
}
