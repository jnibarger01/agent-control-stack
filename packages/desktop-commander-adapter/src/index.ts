/**
 * @agent-control-stack/desktop-commander-adapter
 *
 * ACS-side adapter that spawns the LOCAL Desktop Commander MCP fork over stdio
 * and executes an explicit allowlist of its tools - but only when handed a
 * branded `ExecutionAuthorization` that proves the full ACS lifecycle
 * (auth -> scope -> work item -> policy -> approval -> exact action hash ->
 * worker lease -> tool allowlist -> argument validation -> path/command
 * containment) has already passed.
 *
 * ACS decides. Desktop Commander executes. The raw stdio client is intentionally
 * not exported.
 */

export { desktopCommanderAdapterConfigFromEnv } from "./config.js";
export type { DesktopCommanderAdapterConfig } from "./config.js";

export {
  desktopCommanderToolPolicy,
  isAllowlistedDesktopCommanderTool,
  allowlistedDesktopCommanderToolNames
} from "./tool-policy.js";
export type { DesktopCommanderToolPolicy, DesktopCommanderRiskClass } from "./tool-policy.js";

export { containPath, containCwd } from "./containment.js";
export type { ContainmentConfig, ContainedPath } from "./containment.js";

export { validateProcessCommand } from "./command-validation.js";
export type { ValidatedCommand } from "./command-validation.js";

export {
  normalizeInvocation,
  reconstructDesktopCommanderInvocation,
  desktopCommanderInvocationFingerprint,
  DESKTOP_COMMANDER_INVOCATION_DOMAIN
} from "./arguments.js";
export type { NormalizedInvocation } from "./arguments.js";

export { authorizeDesktopCommanderExecution, isExecutionAuthorization } from "./execution-authorization.js";
export type { ExecutionAuthorization, AuthorizeExecutionInput } from "./execution-authorization.js";

export { normalizeToolResult } from "./result.js";
export type { MachineExecutionResult, NormalizeResultOptions } from "./result.js";

export {
  ExecutionAuditEvent,
  executionAuditAttributes,
  authorizationRequestedEvent,
  authorizationGrantedEvent,
  authorizationDeniedEvent,
  executionStartedEvent,
  toolCalledEvent,
  toolOutcomeEvent,
  resultPersistedEvent,
  executionCompletedEvent
} from "./audit.js";
export type { AuditEventDraft, ExecutionAuditEventName } from "./audit.js";

export { DesktopCommanderMachineExecutor } from "./machine-executor.js";
export type {
  MachineExecutor,
  MachineTool,
  AuthorizedExecutionRequest,
  DesktopCommanderTransport,
  DesktopCommanderMachineExecutorDeps
} from "./machine-executor.js";

export { disabledDeviceAuthorizationProvider } from "./device-authorization.js";
export type { DeviceAuthorizationProvider, DeviceAuthorizationGrant } from "./device-authorization.js";
