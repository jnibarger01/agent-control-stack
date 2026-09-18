import { ControlStackError } from "@agent-control-stack/shared";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { desktopCommanderInvocationFingerprint } from "./arguments.js";
import type { DesktopCommanderAdapterConfig } from "./config.js";
import type { ContainmentConfig } from "./containment.js";
import { containPath } from "./containment.js";
import {
  authorizeDesktopCommanderExecution,
  isExecutionAuthorization,
  type AuthorizeExecutionInput,
  type ExecutionAuthorization
} from "./execution-authorization.js";
import {
  McpStdioClient,
  type McpRuntimeBootstrap,
  type McpStdioClientOptions,
  type McpToolCallResult,
  type McpToolDescriptor
} from "./mcp-stdio-client.js";
import { normalizeToolResult, type MachineExecutionResult } from "./result.js";
import { desktopCommanderToolPolicy, isAllowlistedDesktopCommanderTool } from "./tool-policy.js";
import { prepareDesktopCommanderCapability, signPreparedDesktopCommanderCapability } from "./capability.js";
import { capabilityDeniedEvent, capabilityIssuedEvent, type AuditEventDraft } from "./audit.js";
import type { CapabilityIssuanceBinding, RuntimeBootstrapRegistry } from "./runtime-registry.js";
import { SqliteDesktopCommanderRuntimeRegistry } from "./runtime-registry.js";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";

/**
 * Phase 1 + Phase 10 - the machine execution boundary.
 *
 * `execute` accepts ONLY a branded `ExecutionAuthorization`. It re-checks the
 * allowlist, re-validates the normalised arguments, re-verifies the invocation
 * fingerprint and re-asserts path containment before the MCP call. There is no
 * `execute(toolName, args)`. The raw stdio client is not exported from the
 * package barrel.
 */

export interface MachineTool {
  name: string;
  description?: string;
  /** Whether ACS will ever permit this tool to execute. */
  allowlisted: boolean;
}

export interface AuthorizedExecutionRequest {
  authorization: ExecutionAuthorization;
  signal?: AbortSignal;
}

export interface MachineExecutor {
  listTools(): Promise<MachineTool[]>;
  execute(request: AuthorizedExecutionRequest): Promise<MachineExecutionResult>;
  close(): Promise<void>;
}

/** Test seam: a minimal transport the executor can drive. */
export interface DesktopCommanderTransport {
  connect(runtimeBootstrap?: McpRuntimeBootstrap): Promise<unknown>;
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(name: string, args: unknown, meta?: Record<string, unknown>): Promise<McpToolCallResult>;
  close(): Promise<void>;
  isConnected(): boolean;
  getServerInfo(): { name?: string; version?: string; protocolVersion?: string };
}

export interface DesktopCommanderMachineExecutorDeps {
  /** Inject a fake transport for unit tests. */
  transport?: DesktopCommanderTransport;
  now?: () => Date;
  /** Authoritative transaction gate; a capability is never signed before it commits. */
  capabilityRegistry?: {
    recordIssuance(input: CapabilityIssuanceBinding): { requestHash: string; approvalId?: string };
  };
  /** Durable bootstrap challenge/attestation gate for managed startup. */
  runtimeRegistry?: RuntimeBootstrapRegistry;
  /** Canonical audit persistence; failure prevents signing and transmission. */
  persistAuditEvent?: (event: AuditEventDraft) => void | Promise<void>;
}

export class DesktopCommanderMachineExecutor implements MachineExecutor {
  private readonly transport: DesktopCommanderTransport;
  private readonly containment: ContainmentConfig;
  private readonly now: () => Date;
  private readonly capabilityRegistry: DesktopCommanderMachineExecutorDeps["capabilityRegistry"];
  private readonly runtimeRegistry: RuntimeBootstrapRegistry | undefined;
  private readonly persistAuditEvent: DesktopCommanderMachineExecutorDeps["persistAuditEvent"];
  private readonly ownedRegistry: SqliteDesktopCommanderRuntimeRegistry | undefined;
  private readonly ownedAuditStore: SqliteWorkItemStore | undefined;
  private connecting: Promise<void> | undefined;

  constructor(
    private readonly config: DesktopCommanderAdapterConfig,
    deps: DesktopCommanderMachineExecutorDeps = {}
  ) {
    this.containment = { allowedRoots: config.allowedRoots, deniedRoots: config.deniedRoots };
    this.now = deps.now ?? (() => new Date());
    const databasePath = config.capability?.databasePath;
    this.ownedRegistry =
      !deps.capabilityRegistry && !config.capability?.issuanceRegistry && databasePath
        ? new SqliteDesktopCommanderRuntimeRegistry(databasePath)
        : undefined;
    this.ownedAuditStore =
      !deps.persistAuditEvent && !config.capability?.persistAuditEvent && databasePath
        ? new SqliteWorkItemStore(databasePath)
        : undefined;
    this.capabilityRegistry = deps.capabilityRegistry ?? config.capability?.issuanceRegistry ?? this.ownedRegistry;
    this.runtimeRegistry = deps.runtimeRegistry ?? config.capability?.runtimeRegistry ?? this.ownedRegistry;
    const ownedAuditStore = this.ownedAuditStore;
    this.persistAuditEvent =
      deps.persistAuditEvent ??
      config.capability?.persistAuditEvent ??
      (ownedAuditStore
        ? (event) => {
            ownedAuditStore.recordExecutionEvent({
              name: event.name,
              workItemId: String(event.body.workItemId),
              body: event.body,
              attributes: event.attributes
            });
          }
        : undefined);
    this.transport = deps.transport ?? new McpStdioClient(this.stdioOptions());
  }

  private stdioOptions(): McpStdioClientOptions {
    const capability = this.config.capability;
    if (!capability) {
      throw new ControlStackError(
        "desktop_commander_capability_missing",
        "managed capability signing is not configured"
      );
    }
    let publicKey: string;
    try {
      const privateKey = createPrivateKey({
        key: Buffer.from(capability.privateKey, "base64url"),
        format: "der",
        type: "pkcs8"
      });
      if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("not Ed25519");
      publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64url");
    } catch {
      throw new ControlStackError(
        "desktop_commander_config_invalid",
        "managed Desktop Commander capability private key must be base64url PKCS#8 Ed25519 material"
      );
    }
    return {
      command: this.config.command,
      args: this.config.args,
      cwd: this.config.cwd,
      connectTimeoutMs: this.config.connectTimeoutMs,
      requestTimeoutMs: this.config.requestTimeoutMs,
      // Desktop Commander receives verification material only. The ACS private
      // signing key never crosses the process boundary.
      env: {
        DESKTOP_COMMANDER_ACS_PUBLIC_KEY: publicKey,
        DESKTOP_COMMANDER_ACS_KEY_ID: capability.keyId,
        DESKTOP_COMMANDER_ACS_SCOPES: capability.runtimeScopes.join(",")
      }
    };
  }

  /**
   * Fail-closed startup probe: connect and confirm the local Desktop Commander
   * MCP answers `tools/list`. Callers (the worker) must run this before
   * claiming work when the backend is `desktop_commander`.
   */
  async preflight(): Promise<{ serverInfo: { name?: string; version?: string }; toolCount: number }> {
    await this.ensureConnected();
    const tools = await this.transport.listTools();
    return { serverInfo: this.transport.getServerInfo(), toolCount: tools.length };
  }

  private async ensureConnected(): Promise<void> {
    if (this.transport.isConnected()) return;
    if (!this.connecting) {
      const capability = this.config.capability;
      if (!capability || !this.runtimeRegistry) {
        throw new ControlStackError(
          "desktop_commander_runtime_identity_rejected",
          "managed Desktop Commander requires a runtime registry"
        );
      }
      const bootstrap = this.runtimeRegistry.issueBootstrap(
        {
          runtimeId: capability.runtimeId,
          identityConfigFingerprint: capability.runtimeIdentityConfigFingerprint,
          scopes: capability.runtimeScopes
        },
        this.now()
      );
      const request: McpRuntimeBootstrap = {
        schemaVersion: 1,
        runtimeId: bootstrap.runtimeId,
        challenge: bootstrap.challenge,
        scopes: bootstrap.scopes
      };
      this.connecting = this.transport
        .connect(request)
        .then(() => {
          this.runtimeRegistry?.completeBootstrap(
            {
              runtimeId: bootstrap.runtimeId,
              identityConfigFingerprint: bootstrap.identityConfigFingerprint,
              scopes: bootstrap.scopes,
              challenge: bootstrap.challenge
            },
            this.now()
          );
        })
        .then(() => {
          // Success: drop the cached promise so a later disconnect can
          // reconnect instead of awaiting a stale resolved promise.
          this.connecting = undefined;
        })
        .catch((error) => {
          // Failure: never cache a rejected promise; the next caller must be
          // able to retry the connection from scratch.
          this.connecting = undefined;
          throw error instanceof Error
            ? new ControlStackError("desktop_commander_connect_failed", error.message)
            : new ControlStackError("desktop_commander_connect_failed", String(error));
        });
    }
    await this.connecting;
  }

  async listTools(): Promise<MachineTool[]> {
    await this.ensureConnected();
    const discovered = await this.transport.listTools();
    return discovered.map((tool) => ({
      name: tool.name,
      description: tool.description,
      allowlisted: isAllowlistedDesktopCommanderTool(tool.name)
    }));
  }

  async execute(request: AuthorizedExecutionRequest): Promise<MachineExecutionResult> {
    const auth = request?.authorization;
    if (!isExecutionAuthorization(auth)) {
      throw new ControlStackError(
        "desktop_commander_unauthorized",
        "execute() requires a valid ExecutionAuthorization produced by authorizeDesktopCommanderExecution"
      );
    }

    // Defence in depth: re-run the checks that do not need store state.
    const policy = desktopCommanderToolPolicy(auth.toolName);
    if (!policy) {
      throw new ControlStackError(
        "desktop_commander_tool_not_allowlisted",
        `tool is not on the ACS allowlist: ${auth.toolName}`
      );
    }
    const reparsed = policy.argsSchema.safeParse(auth.normalizedArguments);
    if (!reparsed.success) {
      throw new ControlStackError(
        "desktop_commander_argument_invalid",
        `authorized arguments failed re-validation for ${auth.toolName}`
      );
    }
    const refingerprint = desktopCommanderInvocationFingerprint({
      toolName: auth.toolName,
      validatedArguments: auth.normalizedArguments as Record<string, unknown>
    });
    if (refingerprint !== auth.invocationFingerprint) {
      throw new ControlStackError(
        "desktop_commander_invocation_tampered",
        "authorized arguments do not match the authorized invocation fingerprint"
      );
    }
    for (const canonical of auth.canonicalPaths) {
      // Re-assert containment; throws if a canonical path is no longer contained.
      containPath(this.containment, canonical);
    }

    if (!this.config.capability) {
      throw new ControlStackError(
        "desktop_commander_capability_missing",
        "managed capability signing is not configured"
      );
    }
    const capability = await this.issueCapability(auth);
    await this.ensureConnected();

    const startedAt = this.now();
    let raw: McpToolCallResult;
    try {
      raw = await this.withTimeout(
        this.transport.callTool(auth.toolName, auth.normalizedArguments, { acsCapability: capability }),
        policy.timeoutMs,
        auth.toolName,
        request.signal
      );
    } catch (error) {
      const completedAt = this.now();
      const message = error instanceof Error ? error.message : String(error);
      return {
        toolName: auth.toolName,
        invocationFingerprint: auth.invocationFingerprint,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
        isError: true,
        output: "",
        error: message.slice(0, 4000),
        ...(error instanceof ControlStackError ? { errorCode: error.code } : {}),
        truncated: false,
        resultHash: "",
        omittedBlocks: 0
      };
    }
    const completedAt = this.now();

    return normalizeToolResult(raw, {
      toolName: auth.toolName,
      invocationFingerprint: auth.invocationFingerprint,
      startedAt,
      completedAt,
      maxResultBytes: Math.min(policy.maxResultBytes, this.config.maxResultBytes)
    });
  }

  private async issueCapability(auth: ExecutionAuthorization) {
    if (!this.config.capability || !this.capabilityRegistry || !this.persistAuditEvent) {
      throw new ControlStackError(
        "desktop_commander_capability_missing",
        "managed capability requires an authoritative issuance registry and audit sink"
      );
    }
    const payload = prepareDesktopCommanderCapability(auth, auth.requestHash, this.config.capability, this.now());
    try {
      const recorded = this.capabilityRegistry.recordIssuance({
        runtimeId: payload.runtimeId,
        identityConfigFingerprint: this.config.capability.runtimeIdentityConfigFingerprint,
        leaseId: payload.leaseId,
        attemptId: payload.attemptId,
        workItemId: payload.workItemId,
        workerId: auth.workerId,
        fencingEpoch: payload.leaseEpoch,
        planHash: payload.planHash,
        actionHash: payload.actionHash,
        invocationHash: payload.invocationHash,
        requiredScopes: payload.scopes,
        approvalRequired: auth.requiresApproval,
        approvalId: payload.approvalId,
        keyId: this.config.capability.keyId,
        nonce: payload.nonce,
        issuedAt: payload.issuedAt,
        expiresAt: payload.expiresAt
      });
      if (recorded.requestHash !== payload.requestHash || recorded.approvalId !== payload.approvalId) {
        throw new ControlStackError(
          "desktop_commander_capability_issuance_rejected",
          "issuance binding does not match capability payload"
        );
      }
      await this.persistAuditEvent(
        capabilityIssuedEvent({
          auth,
          runtimeId: payload.runtimeId,
          keyId: this.config.capability.keyId,
          requestHash: payload.requestHash,
          expiresAt: payload.expiresAt
        })
      );
      return signPreparedDesktopCommanderCapability(payload, this.config.capability);
    } catch (error) {
      const code = error instanceof ControlStackError ? error.code : "desktop_commander_capability_issuance_rejected";
      try {
        await this.persistAuditEvent(capabilityDeniedEvent({ auth, runtimeId: payload.runtimeId, code }));
      } catch {
        // Capability was neither signed nor transmitted.
      }
      throw error;
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    toolName: string,
    signal?: AbortSignal
  ): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      // The stdio MCP transport has no server-side cancellation primitive and
      // carries one execution at a time, so the only way to guarantee a
      // timed-out or aborted tool call does not keep executing in the
      // background is to tear the transport down. This intentionally kills
      // any sibling in-flight call (the worker executes one attempt at a
      // time); the next ensureConnected() call establishes a fresh child.
      // Known trade-off: repeated slow tool calls cause bounded spawn/kill
      // churn — no unbounded background execution is possible.
      const cancelUnderlying = (reason: ControlStackError): void => {
        if (settled) return;
        settled = true;
        this.connecting = undefined;
        void this.transport.close().catch(() => undefined);
        reject(reason);
      };
      const timer = setTimeout(() => {
        cancelUnderlying(
          new ControlStackError(
            "desktop_commander_tool_timeout",
            `Desktop Commander tool '${toolName}' timed out after ${timeoutMs}ms`
          )
        );
      }, timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        cancelUnderlying(new ControlStackError("desktop_commander_tool_aborted", `tool '${toolName}' aborted`));
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
  }

  async close(): Promise<void> {
    await this.transport.close();
    this.ownedRegistry?.close();
    this.ownedAuditStore?.close();
  }
}

export { authorizeDesktopCommanderExecution };
export type { AuthorizeExecutionInput, ExecutionAuthorization };
