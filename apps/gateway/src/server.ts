import { registerMissionDispatchRoutes } from "./mission-dispatch-routes.js";
import {
  CodingMissionController,
  codingMissionPortsFromEnv,
  type CodingMissionPorts
} from "@agent-control-stack/coding-mission";
import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import {
  acpAdapterConfigFromEnv,
  ReadonlyAcpAdapter,
  type ReadonlyAcpAdapterConfig
} from "@agent-control-stack/acp-adapter";
import {
  authorizeDesktopCommanderExecution,
  authorizeJaceCommanderExecution,
  desktopCommanderCapabilityId,
  jaceCommanderCapabilityId,
  jaceCommanderApprovalSummary,
  jaceCommanderSigningConfigFromEnv,
  jaceCommanderToolNames,
  jaceCommanderToolPolicy,
  jaceCommanderWorkItemIntent,
  jaceCommanderWorkItemTitle,
  prepareJaceCommanderCapability,
  signPreparedJaceCommanderCapability,
  SqliteJaceCommanderIssuanceRegistry,
  validateJaceCommanderInvocation,
  containJaceCommanderInvocation,
  jaceCommanderContainmentFromEnv,
  validateJaceCommanderSigningConfig,
  type JaceCommanderExecutionAuthorization,
  type JaceCommanderInvocation,
  type JaceCommanderSigningConfig,
  authorizationDeniedEvent,
  capabilityDeniedEvent,
  capabilityIssuedEvent,
  classifyDesktopCommanderExecution,
  desktopCommanderAdapterConfigFromEnv,
  desktopCommanderSchedulerConfigFromEnv,
  ExecutionScheduler,
  ExecutionSchedulerError,
  desktopCommanderContainmentFromEnv,
  desktopCommanderInvocationFingerprint,
  desktopCommanderManagedToolDisposition,
  desktopCommanderManagedToolDispositions,
  desktopCommanderRequiredScopes,
  desktopCommanderToolPolicy,
  normalizeInvocation,
  prepareDesktopCommanderCapability,
  signPreparedDesktopCommanderCapability,
  SqliteDesktopCommanderRuntimeRegistry,
  validateCapabilitySigningConfig,
  type CapabilitySigningConfig,
  type ContainmentConfig,
  containPath,
  type ExecutionAdmission,
  type ExecutionAuthorization
} from "@agent-control-stack/desktop-commander-adapter";
import {
  AdmissionError,
  ExecutionAdmissionScheduler,
  classifyAdmissionTool,
  resolveExecutionAdmissionConfig,
  type AdmissionEvent,
  type AdmissionPermit,
  type ExecutionAdmissionController
} from "@agent-control-stack/execution-admission";
import {
  projectAgents,
  renderDashboard,
  renderDashboardFragments,
  toMissionControlAttemptLease,
  type ApprovalActionOption,
  type MissionControlViewModel
} from "@agent-control-stack/control-ui";
import {
  MachineController,
  loadMachineControllerConfig,
  type DirectAgentRunner
} from "@agent-control-stack/machine-controller";
import {
  claimNextAuthoritativeWorkItem,
  createPolicyEngine,
  evaluateChangeSetPolicy,
  createWorkItemTools,
  explainPolicy,
  probeNimbleRouting,
  previewWorkItemPolicy,
  resolveNimbleRoutingConfig,
  SUPPORTED_ACTION_KINDS,
  workItemToolNames,
  ACS_ADMIN_APPROVER,
  ACS_ADMIN_APPROVAL_REASON,
  adminExecutionGate,
  observeLiveManagedAuthority,
  policyContextAuditReceipt,
  recordDirectLaneRoutingDecision,
  readExecutionModeValue,
  type ManagedAuthorityObservation
} from "@agent-control-stack/policy-gate";
import { ObservationWorker } from "@agent-control-stack/evidence";
import {
  AuthFailureLockout,
  ControlStackError,
  DEFAULT_AUTH_LOCKOUT_MAX_FAILURES,
  DEFAULT_AUTH_LOCKOUT_WINDOW_MS,
  stableHash,
  type AuthLockoutOptions
} from "@agent-control-stack/shared";
import {
  executionActionHash,
  executionPlanApprovalRequestHash,
  listWorkItemsSchema,
  submitWorkResultSchema,
  requesterSchema,
  SqliteExecutionReadStore,
  SqliteWorkItemStore,
  changeSetPolicyHash,
  IMPLEMENTED_CHANGE_SET_VERIFICATION_KINDS,
  DEFAULT_EVENT_LIMIT,
  MAX_DASHBOARD_FINISHED_LIMIT,
  MAX_EVENT_LIMIT,
  DEFAULT_HEARTBEAT_TTL_MS,
  discoverLocalActors,
  isHeartbeatExpired,
  resolveTraceProducerConfig,
  validateHeartbeatTtl,
  WorkerIdentityRegistry,
  type ReadEventsOptions,
  type RegisteredConnector,
  type RegisteredTunnelSession,
  type RegistryAgentDetail,
  type RegistryStatus,
  type StoredAuditEvent,
  type ExecutionAttempt,
  type ExecutionPlanRecord,
  type WorkItem,
  type DiscoverLocalActorsDeps
} from "@agent-control-stack/work-items";
import { z, ZodError } from "zod";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { AgentRunService, agentDispatchConfigFromEnv, type AgentDispatchConfig } from "./agent-runs.js";
import { registerAgentRoutes } from "./agent-routes.js";
import {
  McpClientService,
  parseMcpClientPolicy,
  canonicalClientId,
  sanitizeClaim,
  type McpClientPolicy,
  type McpLane
} from "./mcp-clients.js";
import { registerMcpClientRoutes } from "./mcp-client-routes.js";
import {
  authorizeMcpRequest,
  createProtectedResourceMetadata,
  mcpAuthorizationHttpError,
  resolveMcpAuthOptions,
  type McpAuthenticatedRequest,
  type McpAuthOptions,
  type McpOAuthOptions
} from "./auth.js";
import {
  handleMcpHttpRequest,
  type AuthenticatedMcpRequestAudit,
  type GatewayDirectAgentController,
  type LocalAgentAuditEvent
} from "./mcp.js";
import { resolveMcpToolAllowlist, type McpToolAllowlistMode } from "./mcp-tool-allowlist.js";
import { registerMoaGateway, type MoaGatewayOverrides } from "./moa/index.js";
import { SqliteMoaIdempotencyStore } from "./moa/idempotency.js";
import {
  actorBodySchema,
  agentBodySchema,
  agentPatchSchema,
  approvalBodySchema,
  changeSetSubmissionBodySchema,
  changeSetPolicyBodySchema,
  missionTraceQuerySchema,
  changeSetReviewBodySchema,
  changeSetApprovalBodySchema,
  issueAutonomousAuthorityBodySchema,
  grantAuthorizationBodySchema,
  changeSetOperationPermitBodySchema,
  changeSetRevocationBodySchema,
  codingMissionCreateBodySchema,
  codingMissionApprovalBodySchema,
  changeSetQuerySchema,
  cancelBodySchema,
  capabilitiesBodySchema,
  connectorBodySchema,
  connectorKeyRotationBodySchema,
  cloneBodySchema,
  createWorkItemSchema,
  dcCapabilityIssueSchema,
  dcRuntimeBootstrapCompleteSchema,
  dcRuntimeBootstrapSchema,
  eventQuerySchema,
  executionModeBodySchema,
  heartbeatBodySchema,
  retryBodySchema,
  sessionLoginBodySchema,
  tunnelSessionBodySchema,
  unblockBodySchema,
  webhookIngestSchema
} from "./public-contracts.js";
import { SlidingWindowRateLimiter, type RateLimitOptions } from "./rate-limit.js";
import { GatewayMetrics } from "./metrics.js";
import {
  GATEWAY_SHUTTING_DOWN_CODE,
  SHUTDOWN_DRAIN_METRIC,
  ShutdownController,
  guardWorkItemClaimTools,
  type DrainFinishInfo,
  type DrainStartInfo
} from "./lifecycle.js";
import { validateProductionConfig } from "./production-config.js";
import {
  evaluateSandboxReadyzCheck,
  mergeSandboxReadyzCheck,
  type SandboxReadinessOptions
} from "./sandbox-readiness.js";
import { gatewayListenConfig } from "./runtime-config.js";
import { DeviceAuthStore } from "./device-auth-store.js";
import { registerDeviceAuthRoutes } from "./device-auth.js";
import { createPortfolioClientFromEnv, type PortfolioClient } from "./portfolio-client.js";
import { verifyChangeSetResult } from "./change-set-verification.js";
import { fileReadbackExpectationSchema } from "@agent-control-stack/verification";
import { changeSetExecutionInput } from "./change-set-execution.js";
import { dcWorkItemActionKind, resolveChangeSetRuntimePolicy } from "./change-set-runtime-policy.js";
import {
  type GatewayAuthOptions,
  firstHeader,
  isDevelopmentLoopbackRequest,
  type GatewayCredential,
  MIN_ADMIN_MODE_REASON_LENGTH,
  findIncompatibleHumanApprovalCredentials,
  gatewayCredentialCanMutate,
  gatewayCredentialForRequest,
  gatewayCredentialForToken,
  gatewayCredentialSchema,
  hasReadAccess,
  mutationActorForCredential,
  requesterForCredential,
  requireBoundActorId,
  requireExecutionModeAdminScope,
  requireHumanApprovalActor,
  requireMutationActor,
  requireWorkerIdentity,
  sendReadAccessError,
  sessionCookie
} from "./credentials.js";

/** Conservative Fastify JSON bodyLimit for mutation routes (memory DoS bound). */
const DEFAULT_JSON_BODY_LIMIT_BYTES = 256 * 1024;
/** Attempt lease TTL for gateway-claimed Desktop Commander bridge executions. */
const DC_BRIDGE_LEASE_MS = 300_000;
const DC_BRIDGE_WORKER_ID = "acs-dc-bridge";
/** Dedicated worker identity of the Jace Commander managed bridge (acs.jc.v1 issuance). */
const JC_BRIDGE_WORKER_ID = "acs-jc-bridge";
const JC_BRIDGE_LEASE_MS = 300_000;
/** Result submission keeps an explicit route bodyLimit; currently matches the default. */
const MAX_RESULT_BODY_BYTES = DEFAULT_JSON_BODY_LIMIT_BYTES;
// Well above the socket's 16 KB high-water mark, so ordinary bursts ride
// through; only a subscriber that has genuinely stopped draining reaches this.
const MAX_SSE_BUFFER_BYTES = 1024 * 1024;
export type { GatewayAuthOptions, GatewayCredential } from "./credentials.js";
export {
  EXECUTION_MODE_ADMIN_SCOPE,
  findIncompatibleHumanApprovalCredentials,
  gatewayCredentialCanMutate,
  gatewayCredentialForRequest
} from "./credentials.js";
export { WorkerIdentityRegistry };

export interface JevObservationWorkerLifecycle {
  start(): void;
  stop(): Promise<void>;
}

export interface GatewayJevObservationOptions {
  enabled?: boolean;
  createWorker?: (store: SqliteWorkItemStore) => JevObservationWorkerLifecycle;
}

export interface GatewayOptions {
  dbPath?: string;
  /** Governed ports for autonomous coding missions. Absent ports fail closed. */
  codingMissionPorts?: CodingMissionPorts;
  heartbeatTtlMs?: number;
  /**
   * Re-probe the local agent CLIs and refresh their heartbeats on this cadence. Without it nothing renews
   * a heartbeat and every agent expires to offline after the TTL. 0 or absent disables the loop.
   */
  actorDiscovery?: { intervalMs: number } & Partial<DiscoverLocalActorsDeps>;
  /** `observe` (default) or `require_label`. Defaults to ACS_MCP_CLIENT_POLICY. */
  mcpClientPolicy?: McpClientPolicy;
  /** Agent CLI dispatch settings. Defaults to the ACS_AGENT_* environment (off unless enabled). */
  agentDispatch?: AgentDispatchConfig;
  /** Test seam: clock for agent confirmation expiry. */
  agentRunNow?: () => number;
  missionDispatchEnabled?: boolean;
  /** Admin execution mode lasts this long before reverting to strict. Env: ACS_ADMIN_MODE_TTL_MS. */
  adminModeTtlMs?: number;
  logger?: boolean;
  auth?: GatewayAuthOptions;
  mcpAuth?: McpAuthOptions;
  mcpOAuth?: McpOAuthOptions;
  mcpAllowedOrigins?: string[];
  /** Per-identity MCP tool allowlist (identity → tool names). */
  mcpToolAllowlist?: Record<string, readonly string[]>;
  /** Override allowlist mode; defaults from NODE_ENV. */
  mcpToolAllowlistMode?: McpToolAllowlistMode;
  machineControllerConfigPath?: string;
  directAgentRunner?: DirectAgentRunner;
  directAgentController?: GatewayDirectAgentController;
  enableTestAgentRunForLocalDevelopment?: boolean;
  acpAdapter?: ReadonlyAcpAdapterConfig | false;
  moa?: MoaGatewayOverrides | false;
  rateLimit?: RateLimitOptions;
  authLockout?: AuthLockoutOptions;
  maxPendingWorkItems?: number;
  maxSseClients?: number;
  maxSseClientsPerPrincipal?: number;
  portfolioClient?: PortfolioClient;
  /**
   * Optional /readyz sandbox prerequisite probe (bwrap / systemd-run / cgroup v2).
   * Default off via ACS_READYZ_SANDBOX_PROBE; enable on real-execution hosts only.
   */
  sandboxReadiness?: SandboxReadinessOptions;
  /**
   * ACS-only Desktop Commander capability signing material for
   * POST /dc/capability/issue. Defaults to the existing
   * desktopCommanderAdapterConfigFromEnv() capability env (fail closed: when
   * absent the endpoint answers 503 rather than issuing anything). The durable
   * issuance registry additionally requires the runtime identity fingerprint
   * and granted runtime scopes.
   */
  desktopCommanderCapability?: CapabilitySigningConfig & {
    identityConfigFingerprint?: string;
    runtimeScopes?: readonly string[];
  };
  /**
   * ACS-only Jace Commander (acs.jc.v1) signing material for
   * POST /jc/capability/issue. Defaults to ACS_JACE_COMMANDER_CAPABILITY_* env;
   * `false` or absent config makes the endpoint answer 503 (fail closed).
   * Must be a different key from the acs.dc.v1 key.
   */
  jaceCommanderCapability?: JaceCommanderSigningConfig | false;
  /**
   * Containment roots for path-bearing Jace Commander tools. Defaults to
   * ACS_JACE_COMMANDER_ALLOWED_ROOTS / _DENIED_ROOTS; `false` or absent config
   * makes every path-bearing JC tool fail closed (503) at issuance.
   */
  jaceCommanderContainment?: ContainmentConfig | false;
  /** Containment roots for the gateway-side Phase 6-8 re-authorization. */
  desktopCommanderContainment?: ContainmentConfig;
  /** Shared ACS-side concurrency scheduler for managed Desktop Commander calls. */
  desktopCommanderScheduler?: ExecutionScheduler;
  /**
   * Canonical managed-authority observation. Tests inject this. Production
   * reads the executor lease and break-glass marker. It is not a second
   * authority store.
   */
  readManagedAuthority?: () => ManagedAuthorityObservation;
  /** Shared shutdown gate; tests may inject one to assert claim drain behavior. */
  shutdownController?: ShutdownController;
  /** Execution admission controller; tests may inject a deterministic controller. */
  executionAdmission?: ExecutionAdmissionController;
  /**
   * Post-authority JEV observation worker. false disables it explicitly.
   * Otherwise production follows ACS_JEV_ENABLED=1; tests may inject a
   * lifecycle-only worker without changing authority behavior.
   */
  jevObservation?: GatewayJevObservationOptions | false;
}

/**
 * Attach each attempt's own persisted execution plan so operator surfaces can
 * render a per-attempt execution-mode chip from attempt-local evidence.
 *
 * The plan is resolved by the attempt's own planId — never inferred from the
 * work item's final result or current plan head, which may reflect a later
 * replan. A missing plan stays absent and the UI fails closed (no chip)
 * instead of guessing.
 */
function withAttemptPlan(
  store: Pick<SqliteWorkItemStore, "getExecutionPlan">,
  attempt: ExecutionAttempt
): ExecutionAttempt & { plan?: ExecutionPlanRecord } {
  const plan = store.getExecutionPlan(attempt.planId);
  return plan ? { ...attempt, plan } : attempt;
}

export function buildGateway(options: GatewayOptions = {}): FastifyInstance {
  // Refuse to boot on an invalid ACS_TRACE_INSTANCE / ACS_RELEASE_SHA (trace_config_invalid)
  // rather than discovering it inside an approval transaction (PR #212 B4, ADR 0021).
  resolveTraceProducerConfig();
  const nimbleRouting = resolveNimbleRoutingConfig();
  const dbPath = options.dbPath ?? process.env.ACS_DB_PATH ?? "storage/local.db";
  const heartbeatTtlMs = validateHeartbeatTtl(options.heartbeatTtlMs ?? DEFAULT_HEARTBEAT_TTL_MS);
  const directAgentController = resolveDirectAgentController(options);
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: DEFAULT_JSON_BODY_LIMIT_BYTES });
  const sseClients = new Set<ServerResponse>();
  // Principal is retained per stream so a disconnect can decrement the right
  // bucket without rescanning every open client.
  const sseClientPrincipals = new Map<ServerResponse, string>();
  const sseClientsPerPrincipal = new Map<string, number>();
  const jevObservationOptions = options.jevObservation === false ? undefined : options.jevObservation;
  const jevObservationEnabled =
    options.jevObservation === false ? false : (jevObservationOptions?.enabled ?? process.env.ACS_JEV_ENABLED === "1");
  const codingMissions = options.codingMissionPorts
    ? new CodingMissionController(dbPath, options.codingMissionPorts)
    : undefined;
  if (codingMissions) {
    app.addHook("onReady", async () => {
      await codingMissions.resumeAll();
    });
    app.addHook("onClose", async () => {
      codingMissions.close();
    });
  }
  // Declared before the store: the store's event hook can fire while it is still being constructed.
  let mcpClients: McpClientService | undefined;
  const workItems = new SqliteWorkItemStore(dbPath, {
    onEvent: broadcast,
    heartbeatTtlMs,
    adminModeTtlMs: options.adminModeTtlMs ?? adminModeTtlFromEnv(),
    // The gateway is the one process that refuses to boot on a bad trace config.
    traceConfigValidation: "eager",
    observationEnabled: jevObservationEnabled
  });
  const mcpClientService = new McpClientService(workItems, options.mcpClientPolicy ?? parseMcpClientPolicy());
  // eslint-disable-next-line prefer-const -- the store hook above may fire before this assignment
  mcpClients = mcpClientService;
  mcpClientService.hydrate();
  const observationWorker: JevObservationWorkerLifecycle | undefined = jevObservationEnabled
    ? (jevObservationOptions?.createWorker?.(workItems) ?? new ObservationWorker(workItems))
    : undefined;
  const executionReads = new SqliteExecutionReadStore(dbPath);
  const deviceAuthStore = new DeviceAuthStore(dbPath);
  const policy = createPolicyEngine();
  const shutdownController = options.shutdownController ?? new ShutdownController();
  const tools = guardWorkItemClaimTools(createWorkItemTools(workItems, policy), shutdownController);
  const resolvedAuth = resolveAuth(options);
  const auth = resolvedAuth
    ? { ...resolvedAuth, deviceAccessTokenResolver: (token: string) => deviceAuthStore.authenticateAccessToken(token) }
    : resolvedAuth;
  const mcpAuth = resolveMcpAuth(options, workItems);
  const mcpAllowedOrigins = resolveMcpAllowedOrigins(options);
  const mcpToolAllowlist = resolveMcpToolAllowlist({
    allowlist: options.mcpToolAllowlist,
    mode: options.mcpToolAllowlistMode
  });
  const rateLimiter = new SlidingWindowRateLimiter(options.rateLimit ?? resolveRateLimitFromEnv());
  const authLockout = new AuthFailureLockout(options.authLockout ?? resolveAuthLockoutFromEnv());
  const maxPendingWorkItems = options.maxPendingWorkItems ?? resolveMaxPendingWorkItemsFromEnv();
  const maxSseClients = options.maxSseClients ?? resolveMaxSseClientsFromEnv();
  const configuredMaxSseClientsPerPrincipal =
    options.maxSseClientsPerPrincipal ?? resolveMaxSseClientsPerPrincipalFromEnv();
  const maxSseClientsPerPrincipal = effectiveMaxSseClientsPerPrincipal(
    configuredMaxSseClientsPerPrincipal,
    maxSseClients
  );
  if (maxSseClientsPerPrincipal < configuredMaxSseClientsPerPrincipal) {
    app.log.warn(
      { configured: configuredMaxSseClientsPerPrincipal, effective: maxSseClientsPerPrincipal, maxSseClients },
      "per-principal SSE cap lowered to stay below the global cap"
    );
  }
  // Human approval, revocation, execution-mode and grant authority is deliberately
  // restricted to a pure human operator. A credential that mixes in service or
  // worker roles is refused at request time, so surface it at startup rather than
  // letting an operator discover it as a mysterious 403 in production.
  const incompatibleApprovalCredentials = findIncompatibleHumanApprovalCredentials(auth?.credentials ?? []);
  if (incompatibleApprovalCredentials.length) {
    app.log.warn(
      {
        event: "incompatible_human_approval_credentials",
        credentialIds: incompatibleApprovalCredentials.map((credential) => credential.id),
        conflictingRoles: incompatibleApprovalCredentials.map((credential) => credential.roles),
        remediation:
          "Split these into a pure human operator credential (roles: [operator], actor: user) and a separate service or worker credential; mixed-role credentials cannot approve, revoke, change execution mode or issue authority grants."
      },
      "Configured credentials cannot hold human approval authority; requests using them will be refused with human_authority_required"
    );
  }
  const metrics = new GatewayMetrics();
  if (observationWorker) {
    app.addHook("onReady", async () => {
      try {
        observationWorker.start();
      } catch (error) {
        // JEV is observational only: startup failure must never block ACS readiness.
        app.log.error({ err: error }, "JEV observation worker failed to initialize");
      }
    });
  }

  function refreshAdmissionMetrics(): void {
    const snapshot = executionAdmission.snapshot();
    metrics.setGauge("acs_admission_active", snapshot.global.active, { class: "execution" });
    metrics.setGauge("acs_admission_active", snapshot.wait.active, { class: "wait" });
    metrics.setGauge("acs_admission_queue_depth", snapshot.global.queued, { class: "execution" });
    metrics.setGauge("acs_admission_queue_depth", snapshot.wait.queued, { class: "wait" });
    metrics.setGauge("acs_executor_inflight", snapshot.lanes.jc.active, { lane: "jc" });
    metrics.setGauge("acs_executor_inflight", snapshot.lanes.dc.active, { lane: "dc" });
  }
  function recordAdmissionEvent(event: AdmissionEvent): void {
    if (event.type === "admitted") {
      metrics.observeDurationMs("acs_admission_wait_ms", event.waitMs, {
        lane: event.lane,
        class: event.executionClass
      });
    } else if (event.type === "released") {
      metrics.observeDurationMs("acs_admission_service_ms", event.serviceMs, {
        lane: event.lane,
        class: event.executionClass
      });
    } else if (event.type === "cancelled") {
      metrics.increment("acs_admission_cancelled_total", { lane: event.lane, class: event.executionClass });
    } else {
      metrics.increment("acs_admission_rejected_total", {
        lane: event.lane,
        class: event.executionClass,
        reason: event.reason
      });
    }
    refreshAdmissionMetrics();
  }
  const executionAdmission: ExecutionAdmissionController =
    options.executionAdmission ??
    new ExecutionAdmissionScheduler({ config: resolveExecutionAdmissionConfig(), onEvent: recordAdmissionEvent });
  shutdownController.onShutdown(() => executionAdmission.shutdown());
  const admissionPermits = new Map<
    string,
    {
      permit: AdmissionPermit;
      lane: "jc" | "dc";
      executionClass: "execution" | "wait";
      workItemId: string;
      leaseId: string;
      workerId: string;
      fencingEpoch: number;
      actionHash: string;
      planHash: string;
      inputHash: string;
    }
  >();

  // Fail closed any lease that survived a restart holding execution capacity
  // without a durable reservation. Such a lease is uncountable and unreleasable;
  // fencing it lets startup converge instead of reporting permanently unhealthy.
  try {
    const orphaned = workItems.fenceLeasesWithoutAdmissionReservation({
      workerIds: [JC_BRIDGE_WORKER_ID, DC_BRIDGE_WORKER_ID],
      reservedAttemptIds: new Set(workItems.listAdmissionPermits().map((permit) => permit.attemptId))
    });
    if (orphaned.length)
      app.log.warn(
        { event: "admission_orphan_lease_fenced", count: orphaned.length },
        "Fenced execution leases recovered without an admission reservation"
      );
  } catch (error) {
    app.log.error(
      { event: "admission_orphan_fencing_failed", error: error instanceof Error ? error.message : String(error) },
      "Startup could not fence execution leases missing an admission reservation"
    );
  }

  // Re-establish capacity accounting only from a complete, current ACS lease binding.
  // Invalid records remain persisted for diagnosis and do not mutate scheduler state.
  for (const perm of workItems.listAdmissionPermits()) {
    const lease = workItems.getActiveLeaseForAttempt(perm.attemptId);
    if (!lease || lease.status !== "active" || Date.parse(lease.expiresAt) <= Date.now()) {
      workItems.releaseAdmissionPermit(perm.attemptId);
      continue;
    }
    const attempt = workItems.getAttempt(perm.attemptId);
    const admission = lease && workItems.getExecutionPlanAdmission(lease.admissionId);
    const workItem = workItems.get(perm.workItemId);
    const valid =
      lease?.status === "active" &&
      Date.parse(lease.expiresAt) > Date.now() &&
      lease.leaseId === perm.leaseId &&
      lease.attemptId === perm.attemptId &&
      lease.workItemId === perm.workItemId &&
      lease.workerId === perm.workerId &&
      lease.fencingEpoch === perm.fencingEpoch &&
      lease.planHash === perm.planHash &&
      lease.inputHash === perm.inputHash &&
      attempt?.workItemId === perm.workItemId &&
      attempt.status === "running" &&
      attempt.currentFencingEpoch === perm.fencingEpoch &&
      attempt.claimedByWorkerId === perm.workerId &&
      attempt.planHash === perm.planHash &&
      attempt.inputHash === perm.inputHash &&
      admission?.workItemId === perm.workItemId &&
      admission.planHash === perm.planHash &&
      workItem !== undefined &&
      workItem.status === "running" &&
      perm.workerId === (perm.lane === "jc" ? JC_BRIDGE_WORKER_ID : DC_BRIDGE_WORKER_ID) &&
      typeof workItem.requestedActions[0]?.params?.tool === "string" &&
      perm.executionClass === classifyAdmissionTool(perm.lane, String(workItem.requestedActions[0]?.params?.tool)) &&
      executionActionHash(workItem) === perm.actionHash;
    if (!valid) {
      app.log.warn(
        {
          event: "admission_permit_recovery_rejected",
          attemptId: perm.attemptId,
          workItemId: perm.workItemId,
          leaseId: perm.leaseId,
          fencingEpoch: perm.fencingEpoch,
          reason: "persisted permit does not match the current active lease binding"
        },
        "Persisted execution admission permit rejected during startup recovery"
      );
      continue;
    }

    try {
      const permit = executionAdmission.restoreActivePermit({
        permitId: perm.attemptId,
        lane: perm.lane,
        executionClass: perm.executionClass,
        executorId: perm.workerId
      });
      admissionPermits.set(perm.attemptId, {
        permit,
        lane: perm.lane,
        executionClass: perm.executionClass,
        workItemId: perm.workItemId,
        leaseId: perm.leaseId,
        workerId: perm.workerId,
        fencingEpoch: perm.fencingEpoch,
        actionHash: perm.actionHash,
        planHash: perm.planHash,
        inputHash: perm.inputHash
      });
      refreshAdmissionMetrics();
    } catch (error) {
      app.log.error(
        {
          event: "admission_permit_recovery_failed",
          attemptId: perm.attemptId,
          workItemId: perm.workItemId,
          leaseId: perm.leaseId,
          fencingEpoch: perm.fencingEpoch,
          error: error instanceof Error ? error.message : String(error)
        },
        "Execution admission controller failed to restore a validated permit"
      );
    }
  }

  async function acquireExecutionPermit(input: {
    request: FastifyRequest;
    reply: FastifyReply;
    lane: "jc" | "dc";
    executorId: string;
    actorId: string;
    toolName: string;
  }): Promise<AdmissionPermit> {
    reapAdmissionPermits();
    // Fence any capacity held without a durable reservation, then re-reconcile.
    // This converges the accounting invariant instead of latching on it.
    if (fenceUnreservedBridgeLeases()) reapAdmissionPermits();
    reconcileAdmissionAccounting();
    if (admissionReconciliationMismatch)
      throw new ControlStackError("admission_recovery_required", "admission recovery requires reconciliation");
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    input.request.raw.once("aborted", onAbort);
    input.reply.raw.once("close", onAbort);
    const enqueuedAt = Date.now();
    try {
      return await executionAdmission.acquire({
        requestId: input.request.id,
        lane: input.lane,
        executorId: input.executorId,
        actorId: input.actorId,
        toolName: input.toolName,
        executionClass: classifyAdmissionTool(input.lane, input.toolName),
        enqueuedAt,
        deadlineAt: Number.MAX_SAFE_INTEGER,
        signal: abort.signal
      });
    } finally {
      input.request.raw.removeListener("aborted", onAbort);
      input.reply.raw.removeListener("close", onAbort);
    }
  }

  function claimWithAdmissionPermit(input: {
    id: string;
    workerId: string;
    leaseMs: number;
    lane: "jc" | "dc";
    toolName: string;
    permit: AdmissionPermit;
    validateAuthority?: () => void;
    executionModeFence?: "admin";
  }) {
    const executionClass = classifyAdmissionTool(input.lane, input.toolName);
    const claimed = workItems.withTransaction(() => {
      input.validateAuthority?.();
      const claim = tools.claim_approved_work_item_by_id({
        id: input.id,
        workerId: input.workerId,
        leaseMs: input.leaseMs,
        ...(input.executionModeFence ? { executionModeFence: input.executionModeFence } : {})
      });
      if (!claim?.attemptId || claim.fencingEpoch === undefined || !claim.planHash || !claim.inputHash) return claim;
      workItems.bindAdmissionPermit({
        attemptId: claim.attemptId,
        workItemId: claim.id,
        leaseId: claim.leaseId,
        workerId: input.workerId,
        fencingEpoch: claim.fencingEpoch,
        actionHash: claim.actionHash,
        planHash: claim.planHash,
        inputHash: claim.inputHash,
        lane: input.lane,
        executionClass
      });
      return claim;
    });
    if (claimed?.attemptId && claimed.fencingEpoch !== undefined && claimed.planHash && claimed.inputHash) {
      admissionPermits.set(claimed.attemptId, {
        permit: input.permit,
        lane: input.lane,
        executionClass,
        workItemId: claimed.id,
        leaseId: claimed.leaseId,
        workerId: input.workerId,
        fencingEpoch: claimed.fencingEpoch,
        actionHash: claimed.actionHash,
        planHash: claimed.planHash,
        inputHash: claimed.inputHash
      });
      refreshAdmissionMetrics();
    }
    return claimed;
  }

  function reapAdmissionPermits(): void {
    workItems.failExpiredLeases();
    const durable = new Set(workItems.listAdmissionPermits().map((permit) => permit.attemptId));
    for (const attemptId of [...admissionPermits.keys()]) {
      const binding = admissionPermits.get(attemptId);
      const lease = workItems.getActiveLeaseForAttempt(attemptId);
      // Release when the durable reservation is gone, or the lease it was bound to
      // is no longer live. Both directions must converge or accounting latches.
      if (
        !binding ||
        !durable.has(attemptId) ||
        !lease ||
        lease.status !== "active" ||
        lease.leaseId !== binding.leaseId ||
        Date.parse(lease.expiresAt) <= Date.now()
      ) {
        releaseAdmissionPermit(attemptId, true);
      }
    }
    for (const attemptId of durable) {
      if (!admissionPermits.has(attemptId)) workItems.releaseAdmissionPermit(attemptId);
    }
  }

  /**
   * A bridge lease that holds execution capacity without a durable reservation can
   * neither be released nor counted. Fence it closed so reconciliation converges
   * instead of latching readiness at 503 until natural lease expiry. Returns true
   * when it fenced anything, so the caller re-reconciles.
   */
  function fenceUnreservedBridgeLeases(): boolean {
    const reserved = new Set(workItems.listAdmissionPermits().map((permit) => permit.attemptId));
    let fenced: ReturnType<typeof workItems.fenceLeasesWithoutAdmissionReservation>;
    try {
      fenced = workItems.fenceLeasesWithoutAdmissionReservation(
        {
          workerIds: [JC_BRIDGE_WORKER_ID, DC_BRIDGE_WORKER_ID],
          reservedAttemptIds: reserved
        },
        // Readiness is probed frequently and must answer promptly. Bound the wait for
        // the write lock so a contended database surfaces as its real readiness state
        // instead of stalling the probe for the default busy timeout.
        { busyTimeoutMs: 50 }
      );
    } catch (error) {
      // Reconciliation must not mutate authority when fencing cannot be proven safe.
      app.log.error(
        { event: "admission_orphan_fencing_failed", error: error instanceof Error ? error.message : String(error) },
        "Could not fence execution leases missing an admission reservation"
      );
      return false;
    }
    if (fenced.length) {
      metrics.increment("scheduler_orphan_execution_fenced_total");
      app.log.warn(
        { event: "admission_orphan_lease_fenced", count: fenced.length },
        "Fenced execution leases that held capacity without an admission reservation"
      );
    }
    return fenced.length > 0;
  }

  function releaseAdmissionPermit(attemptId: string, force = false): boolean {
    const binding = admissionPermits.get(attemptId);
    if (!binding) return false;
    if (!force) {
      const lease = workItems.getActiveLeaseForAttempt(attemptId);
      if (lease?.status === "active" && Date.parse(lease.expiresAt) > Date.now()) return false;
    }
    admissionPermits.delete(attemptId);
    binding.permit.release();
    workItems.releaseAdmissionPermit(attemptId);
    refreshAdmissionMetrics();
    return true;
  }

  let admissionReconciliationMismatch = false;
  function reconcileAdmissionAccounting(): void {
    const activeLeaseCount = workItems.countActiveAttemptLeases(new Date(), [JC_BRIDGE_WORKER_ID, DC_BRIDGE_WORKER_ID]);
    const mismatch =
      admissionPermits.size !== activeLeaseCount ||
      workItems.listAdmissionPermits().length !== admissionPermits.size ||
      [...admissionPermits.entries()].some(([attemptId, binding]) => {
        const lease = workItems.getActiveLeaseForAttempt(attemptId);
        return !lease || lease.leaseId !== binding.leaseId || lease.workerId !== binding.workerId;
      });
    if (mismatch && !admissionReconciliationMismatch) {
      metrics.increment("scheduler_runtime_reconciliation_required");
      try {
        workItems.recordSystemEvent({
          name: "scheduler_runtime_reconciliation_required",
          body: { admissionPermits: admissionPermits.size, activeAttemptLeases: activeLeaseCount },
          attributes: {
            "scheduler.admission_permits": admissionPermits.size,
            "scheduler.active_attempt_leases": activeLeaseCount
          }
        });
      } catch {
        // Diagnostic only. Reconciliation telemetry must never affect execution authority.
      }
    }
    admissionReconciliationMismatch = mismatch;
  }

  const portfolioClient = options.portfolioClient ?? createPortfolioClientFromEnv();
  const capabilitySigningConfig = resolveCapabilitySigningConfig(options.desktopCommanderCapability, dbPath);
  const capabilityIssuanceRegistry = new SqliteDesktopCommanderRuntimeRegistry(dbPath);
  let dcSchedulerNeedsRuntimeReconciliation =
    workItems.countActiveAttemptLeases() > 0 ||
    (capabilitySigningConfig !== undefined &&
      capabilityIssuanceRegistry.hasActiveRuntime(capabilitySigningConfig.runtimeId));
  let dcSchedulerRuntimeReattestedSinceStart = false;
  const dcContainment = resolveDcContainment(options.desktopCommanderContainment);
  const ownsDcScheduler = options.desktopCommanderScheduler === undefined;
  const dcScheduler =
    options.desktopCommanderScheduler ?? new ExecutionScheduler(desktopCommanderSchedulerConfigFromEnv());
  const jcSigningConfig = resolveJaceCommanderSigningConfig(options.jaceCommanderCapability);
  const jcContainment = resolveJcContainment(options.jaceCommanderContainment);
  const jcIssuanceRegistry = new SqliteJaceCommanderIssuanceRegistry(dbPath);

  const desktopExecutorCapabilities = () =>
    desktopCommanderManagedToolDispositions().map((disposition) => {
      const policy = desktopCommanderToolPolicy(disposition.name);
      return {
        executorId: DC_BRIDGE_WORKER_ID,
        name: disposition.name,
        contract: "acs.dc.v1" as const,
        managed: disposition.managed,
        toolClass: disposition.toolClass,
        scopes: policy ? desktopCommanderRequiredScopes(disposition.name) : [],
        ...(policy ? { riskClass: policy.riskClass, requiresApproval: policy.requiresApproval } : {}),
        reason: disposition.reason
      };
    });

  const jaceExecutorCapabilities = () =>
    jaceCommanderToolNames().map((name) => {
      const policy = jaceCommanderToolPolicy(name);
      if (!policy) throw new Error(`missing Jace Commander tool policy for ${name}`);
      return {
        executorId: JC_BRIDGE_WORKER_ID,
        name,
        contract: "acs.jc.v1" as const,
        managed: "capability" as const,
        toolClass: "jace_commander_tool" as const,
        scopes: [...policy.scopes],
        riskClass: policy.risk,
        requiresApproval: policy.requiresApproval,
        actionKind: policy.actionKind
      };
    });

  const executorSummaries = () => {
    const dcRuntime = capabilitySigningConfig
      ? capabilityIssuanceRegistry.getRuntime(capabilitySigningConfig.runtimeId)
      : undefined;
    const dcCapabilities = desktopExecutorCapabilities();
    const jcCapabilities = jaceExecutorCapabilities();
    return [
      {
        id: DC_BRIDGE_WORKER_ID,
        displayName: "Desktop Commander",
        kind: "managed_mcp_executor" as const,
        contract: "acs.dc.v1" as const,
        configured: Boolean(capabilitySigningConfig),
        status: !capabilitySigningConfig ? "unconfigured" : (dcRuntime?.status ?? "unattested"),
        ...(capabilitySigningConfig ? { runtimeId: capabilitySigningConfig.runtimeId } : {}),
        ...(dcRuntime ? { attestedAt: dcRuntime.attestedAt, scopes: [...dcRuntime.scopes] } : { scopes: [] }),
        capabilityCount: dcCapabilities.filter((capability) => capability.managed === "capability").length,
        unsupportedToolCount: dcCapabilities.filter((capability) => capability.managed === "unsupported").length
      },
      {
        id: JC_BRIDGE_WORKER_ID,
        displayName: "Jace Commander",
        kind: "managed_mcp_executor" as const,
        contract: "acs.jc.v1" as const,
        configured: Boolean(jcSigningConfig),
        status: jcSigningConfig ? "configured" : "unconfigured",
        ...(jcSigningConfig ? { runtimeId: jcSigningConfig.runtimeId } : {}),
        scopes: [],
        capabilityCount: jcCapabilities.length,
        unsupportedToolCount: 0
      }
    ];
  };

  /** Lease-authorized canonical execution evidence (Phases 6-8 authority). */
  function recordLeaseAuthorizedExecutionEvent(
    authority: { workItemId: string; attemptId: string; leaseId: string; workerId: string; fencingEpoch?: number },
    draft: { name: string; body: Record<string, unknown>; attributes: Record<string, string | number | boolean> }
  ): void {
    workItems.recordExecutionEvent({
      name: draft.name,
      workItemId: authority.workItemId,
      attemptId: authority.attemptId,
      leaseId: authority.leaseId,
      workerId: authority.workerId,
      fencingEpoch: authority.fencingEpoch,
      body: draft.body,
      attributes: draft.attributes
    });
  }

  function maybeCompleteDcSchedulerReconciliation(source: "runtime_attested" | "terminal_result"): boolean {
    if (!dcSchedulerNeedsRuntimeReconciliation || !dcSchedulerRuntimeReattestedSinceStart) {
      return !dcSchedulerNeedsRuntimeReconciliation;
    }
    const activeLeases = workItems.countActiveAttemptLeases();
    if (activeLeases > 0) return false;
    workItems.recordSystemEvent({
      name: "desktop_commander.scheduler_reconciled",
      body: { source, activeLeases },
      attributes: {
        "scheduler.reconciliation_source": source,
        "scheduler.active_attempt_leases": activeLeases
      }
    });
    dcSchedulerNeedsRuntimeReconciliation = false;
    return true;
  }

  const requestStartTimes = new WeakMap<object, number>();
  const acpAdapterConfig = options.acpAdapter === undefined ? acpAdapterConfigFromEnv() : options.acpAdapter;
  const acpAdapter =
    acpAdapterConfig === false || !acpAdapterConfig
      ? undefined
      : new ReadonlyAcpAdapter({ ...acpAdapterConfig, store: workItems });
  app.addHook("preHandler", async (request, reply) => {
    requestStartTimes.set(request, performance.now());
    if (!isRateLimitedRoute(request.url) || (request.method === "GET" && !isRateLimitedGetRoute(request.url))) return;
    const decision = rateLimiter.check(rateLimitKey(request, auth));
    reply.header("x-ratelimit-remaining", String(decision.remaining));
    if (!decision.allowed) {
      const route = request.routeOptions.url ?? "<unmatched>";
      metrics.increment("acs_rate_limit_rejected_total", { method: request.method, route });
      const limitedReply = reply.header("retry-after", String(decision.retryAfterSeconds)).code(429);
      if (route === "/mcp") {
        return limitedReply.send(
          jsonRpcError(jsonRpcRequestId(request.body), -32029, "rate limit exceeded", {
            code: "rate_limited",
            retry_after_seconds: decision.retryAfterSeconds
          })
        );
      }
      return limitedReply.send({
        error: "rate limit exceeded",
        code: "rate_limited",
        retry_after_seconds: decision.retryAfterSeconds
      });
    }
  });
  app.addHook("onResponse", async (request) => {
    mcpCallContexts.delete(request.id);
  });
  app.addHook("onResponse", async (request, reply) => {
    metrics.observeRequest(
      request.method,
      request.routeOptions.url ?? "<unmatched>",
      reply.statusCode,
      performance.now() - (requestStartTimes.get(request) ?? performance.now())
    );
  });
  // Idempotency store shared by the webhook ingest path. Same SQLite file as
  // the work-item store so state is co-located; separate table (moa_idempotency).
  const workItemIdempotency = new SqliteMoaIdempotencyStore(dbPath);
  const requireRead = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!hasReadAccess(request, auth)) {
      if (request.routeOptions.url === "/" && auth) {
        reply.code(401).type("text/html").send(renderLoginPage());
        return reply;
      }
      sendReadAccessError(reply, auth);
      return reply;
    }
  };
  if (!mcpAuth?.oauth && !mcpAuth?.tunnel && process.env.NODE_ENV === "production") {
    app.log.warn("MCP OAuth/tunnel auth is disabled in production; set OAuth env or ACS_AUTH_MODE=tunnel_id");
  }
  if (options.moa !== false) {
    app.register(async (instance) => {
      await registerMoaGateway(instance, {
        dbPath,
        store: workItems,
        authenticate: async (moaRequest) => {
          if (!auth) return null;
          const credential = gatewayCredentialForRequest(moaRequest, auth);
          return credential && gatewayCredentialCanMutate(credential)
            ? { actor: mutationActorForCredential(credential) }
            : null;
        },
        ...(options.moa ? { overrides: options.moa } : {})
      });
    });
  }

  function releaseSseClient(client: ServerResponse): void {
    if (!sseClients.delete(client)) return;
    const principal = sseClientPrincipals.get(client);
    sseClientPrincipals.delete(client);
    if (principal === undefined) return;
    const remaining = (sseClientsPerPrincipal.get(principal) ?? 1) - 1;
    if (remaining > 0) sseClientsPerPrincipal.set(principal, remaining);
    else sseClientsPerPrincipal.delete(principal);
  }

  function broadcast(event: StoredAuditEvent): void {
    metrics.increment("acs_audit_events_total", { event_name: event.name });
    try {
      mcpClients?.ingest(event);
    } catch {
      // The client index is a read model; a bad event must never stop the live stream.
    }
    const frame = `event: ${event.name}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(frame);
        // A false return from write() is ordinary transient backpressure and is
        // not itself interesting. What matters is a subscriber that never
        // drains: its queued frames grow without bound while audit events keep
        // arriving, which exhausts the same memory the connection cap exists to
        // protect. Drop it rather than let one stalled reader take the gateway
        // down for everyone.
        if (client.writableLength > MAX_SSE_BUFFER_BYTES) {
          metrics.increment("acs_sse_clients_dropped_total", { reason: "backpressure" });
          releaseSseClient(client);
          client.destroy();
        }
      } catch {
        releaseSseClient(client);
      }
    }
  }

  // Fastify error handlers are instance-wide; preserve the default path for every non-MCP error.
  app.setErrorHandler((error, request, reply) => {
    if (request.url.split("?")[0] === "/mcp" && request.method === "POST" && isJsonParseError(error)) {
      return reply.code(400).send(jsonRpcError(null, -32700, "parse error"));
    }
    if (isBodyTooLargeError(error)) {
      return reply.code(413).send({ error: "request body is too large", code: "body_too_large" });
    }
    return reply.send(error);
  });

  app.get("/livez", async () => ({ ok: true, status: "alive" }));
  app.get("/healthz", async () => ({ ok: true, status: "alive" }));

  const operationalReadiness = async (_request: FastifyRequest, reply: FastifyReply) => {
    const execution = executionAdmission.snapshot();
    const executionView = {
      saturated: execution.saturated,
      active: execution.global.active,
      capacity: execution.global.capacity,
      queued: execution.global.queued,
      waitActive: execution.wait.active,
      waitCapacity: execution.wait.capacity,
      waitQueued: execution.wait.queued
    };
    const sandboxCheck = evaluateSandboxReadyzCheck(options.sandboxReadiness);
    const health = mergeSandboxReadyzCheck(workItems.readinessHealth(), sandboxCheck);
    // Readiness is a reconciliation boundary: converge capacity accounting first so
    // an orphaned lease is reported as recovered rather than permanently unhealthy.
    if (fenceUnreservedBridgeLeases()) reapAdmissionPermits();
    reconcileAdmissionAccounting();
    if (admissionReconciliationMismatch) {
      return reply.code(503).send({
        ...health,
        ok: false,
        execution: executionView,
        checks: { ...health.checks, executionAdmission: { ok: false, code: "admission_recovery_required" } }
      });
    }
    const nimbleCheck = nimbleRouting.enabled ? await probeNimbleRouting(nimbleRouting) : undefined;
    const nimbleOk = nimbleCheck === undefined || nimbleCheck.ok;
    return reply.code(health.ok && nimbleOk ? 200 : 503).send({
      ...health,
      ok: health.ok && nimbleOk,
      checks: nimbleCheck
        ? {
            ...health.checks,
            nimble: nimbleCheck.ok
              ? { ok: true, latencyMs: nimbleCheck.latencyMs, model: nimbleCheck.model }
              : { ok: false, code: nimbleCheck.code, latencyMs: nimbleCheck.latencyMs }
          }
        : health.checks,
      execution: executionView
    });
  };

  const deepHealth = async (_request: FastifyRequest, reply: FastifyReply) => {
    const execution = executionAdmission.snapshot();
    const executionView = {
      saturated: execution.saturated,
      active: execution.global.active,
      capacity: execution.global.capacity,
      queued: execution.global.queued,
      waitActive: execution.wait.active,
      waitCapacity: execution.wait.capacity,
      waitQueued: execution.wait.queued
    };
    const sandboxCheck = evaluateSandboxReadyzCheck(options.sandboxReadiness);
    const initialHealth = mergeSandboxReadyzCheck(workItems.health(), sandboxCheck);
    const dependencyChecks = Object.entries(initialHealth.checks)
      .filter(([name]) => name !== "liveness")
      .map(([, check]) => check);
    if (!dependencyChecks.every((check) => check.ok)) {
      return reply.code(503).send({ ...initialHealth, execution: executionView });
    }
    try {
      workItems.reconcileStaleTunnelSessions();
      workItems.reconcileStaleAgents();
    } catch {
      const health = mergeSandboxReadyzCheck(workItems.health(), sandboxCheck);
      return reply.code(503).send({
        ...health,
        execution: executionView,
        ok: false,
        checks: { ...health.checks, liveness: { ok: false, code: "liveness_reconciliation_failed" } }
      });
    }
    const health = mergeSandboxReadyzCheck(workItems.health(), sandboxCheck);
    return reply.code(health.ok ? 200 : 503).send({ ...health, execution: executionView });
  };
  app.get("/readyz", operationalReadiness);
  app.get("/health", deepHealth);

  const readAuthority = options.readManagedAuthority ?? (() => observeLiveManagedAuthority());
  const executionModeView = () => {
    workItems.expireAdminModeIfDue();
    const row = workItems.getExecutionMode();
    const mode = readExecutionModeValue(row.raw);
    const observation = readAuthority();
    return {
      authorityOwner: observation.authorityOwner,
      authoritative: mode.state === "ok" && observation.authoritative,
      executionMode: mode.state === "ok" ? mode.mode : mode.state,
      approvalPolicy: mode.approvalPolicy,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
      expiresAt: row.expiresAt,
      executor: {
        lease: {
          active: observation.leaseActive,
          ambiguous: observation.leaseAmbiguous
        }
      },
      breakGlass: {
        active: observation.breakGlassActive,
        ambiguous: observation.breakGlassAmbiguous
      },
      managedRuntime: observation.managedRuntime,
      detail: observation.detail
    };
  };
  app.get(
    "/execution-mode",
    { preHandler: requireRead, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async () => executionModeView()
  );
  app.get(
    "/authority",
    { preHandler: requireRead, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async () => executionModeView()
  );
  app.post(
    "/execution-mode",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      try {
        // Authenticate before looking at the body so an unauthorized caller learns nothing
        // about request validation.
        const actor = requireHumanApprovalActor(request, reply, auth);
        if (!actor) return;
        const body = executionModeBodySchema.parse(requestObject(request.body));
        // Strict is the fail-safe direction. Admin removes human approval, so it also needs
        // the dedicated scope and a stated reason.
        if (body.mode === "admin" && !requireExecutionModeAdminScope(request, reply, auth)) return;
        if (body.mode === "admin" && (body.reason ?? "").trim().length < MIN_ADMIN_MODE_REASON_LENGTH) {
          return reply.code(400).send({
            error: `a reason of at least ${MIN_ADMIN_MODE_REASON_LENGTH} characters is required to enable admin mode`,
            code: "admin_mode_reason_required"
          });
        }
        workItems.setExecutionMode({
          mode: body.mode,
          updatedBy: actor,
          reason: body.reason ?? `operator set ${body.mode}`
        });
        return executionModeView();
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );
  app.get("/metrics", { preHandler: requireRead }, async (_request, reply) => {
    const health = workItems.health();
    metrics.setSqliteReady(health.ok);
    refreshAdmissionMetrics();
    const schedulerMetrics = dcScheduler.metrics();
    metrics.setGauge("scheduler_queue_depth", schedulerMetrics.queueDepth);
    metrics.setGauge("scheduler_active_requests", schedulerMetrics.activeRequests);
    metrics.setGauge("scheduler_completed_total", schedulerMetrics.completedTotal);
    metrics.setGauge("scheduler_failed_total", schedulerMetrics.failedTotal);
    metrics.setGauge("scheduler_cancelled_total", schedulerMetrics.cancelledTotal);
    metrics.setGauge("scheduler_timeout_total", schedulerMetrics.queueTimeoutTotal, { phase: "queue" });
    metrics.setGauge("scheduler_timeout_total", schedulerMetrics.lockTimeoutTotal, { phase: "lock" });
    metrics.setGauge("scheduler_timeout_total", schedulerMetrics.executionTimeoutTotal, { phase: "execution" });
    metrics.setGauge("scheduler_lock_contention_total", schedulerMetrics.lockContentionTotal);
    metrics.setGauge("scheduler_overload_rejected_total", schedulerMetrics.overloadRejectedTotal);
    for (const lane of ["read", "search", "process", "mutation"] as const) {
      metrics.setGauge("scheduler_lane_active", schedulerMetrics.laneActive[lane], { lane });
      metrics.setGauge("scheduler_lane_limit", schedulerMetrics.laneLimit[lane], { lane });
    }
    metrics.clearGauges("scheduler_agent_active");
    metrics.clearGauges("scheduler_agent_queued");
    for (const [agent, value] of Object.entries(schedulerMetrics.agentActive)) {
      metrics.setGauge("scheduler_agent_active", value, { agent });
    }
    for (const [agent, value] of Object.entries(schedulerMetrics.agentQueued)) {
      metrics.setGauge("scheduler_agent_queued", value, { agent });
    }
    metrics.setGauge("scheduler_queue_wait_ms", schedulerMetrics.queueWaitMs.p50, { quantile: "0.50" });
    metrics.setGauge("scheduler_queue_wait_ms", schedulerMetrics.queueWaitMs.p95, { quantile: "0.95" });
    metrics.setGauge("scheduler_queue_wait_ms", schedulerMetrics.queueWaitMs.p99, { quantile: "0.99" });
    metrics.clearGauges("scheduler_lock_wait_ms");
    for (const [resourceType, values] of Object.entries(schedulerMetrics.lockWaitMs)) {
      metrics.setGauge("scheduler_lock_wait_ms", values.p50, { resource_type: resourceType, quantile: "0.50" });
      metrics.setGauge("scheduler_lock_wait_ms", values.p95, { resource_type: resourceType, quantile: "0.95" });
      metrics.setGauge("scheduler_lock_wait_ms", values.p99, { resource_type: resourceType, quantile: "0.99" });
    }
    return reply.type("text/plain; version=0.0.4").send(metrics.render());
  });
  app.get("/internal/execution-admission", { preHandler: requireRead }, async () => {
    reconcileAdmissionAccounting();
    refreshAdmissionMetrics();
    return executionAdmission.snapshot();
  });

  app.get("/api/dc/scheduler", { preHandler: requireRead }, async () => dcScheduler.snapshot());

  app.post("/session/login", async (request, reply) => {
    try {
      if (!auth) {
        return reply.code(503).send({ error: "dashboard auth is not configured" });
      }
      const lockoutKey = `login:ip:${request.ip}`;
      const locked = authLockout.isLocked(lockoutKey);
      if (locked.locked) {
        metrics.increment("acs_auth_lockout_total", { route: "/session/login" });
        return reply.header("retry-after", String(locked.retryAfterSeconds)).code(429).send({
          error: "too many failed login attempts",
          code: "auth_lockout",
          retry_after_seconds: locked.retryAfterSeconds
        });
      }
      const body = sessionLoginBodySchema.parse(request.body);
      const credential = gatewayCredentialForToken(body.token, auth);
      if (!credential) {
        const after = authLockout.recordFailure(lockoutKey);
        if (after.locked) {
          metrics.increment("acs_auth_lockout_total", { route: "/session/login" });
          if (after.justLocked) {
            request.log.warn({ route: "/session/login", code: "auth_lockout" }, "auth lockout triggered");
          }
          return reply.header("retry-after", String(after.retryAfterSeconds)).code(429).send({
            error: "too many failed login attempts",
            code: "auth_lockout",
            retry_after_seconds: after.retryAfterSeconds
          });
        }
        return reply.code(401).send({ error: "unauthorized" });
      }
      authLockout.clear(lockoutKey);
      return reply
        .header("set-cookie", sessionCookie(auth, process.env.NODE_ENV === "production", credential))
        .code(204)
        .send();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  registerDeviceAuthRoutes(app, {
    store: deviceAuthStore,
    auth,
    authLockout,
    rateLimiter,
    onRateLimited: (route, method) => {
      metrics.increment("acs_rate_limit_rejected_total", { method, route });
    },
    onAuthLockout: (route) => {
      metrics.increment("acs_auth_lockout_total", { route });
    },
    publicOriginOverride: process.env.ACS_PUBLIC_URL
  });

  if (acpAdapter) {
    app.addHook("onReady", async () => {
      try {
        await acpAdapter.start();
      } catch (error) {
        app.log.error({ err: error }, "ACP adapter failed to initialize");
        throw error;
      }
    });
  }

  function dashboardExecutionMode(): Pick<MissionControlViewModel, "executionMode" | "executionModeProblem"> {
    const { mode, raw } = workItems.getExecutionMode();
    return mode ? { executionMode: mode } : { executionModeProblem: raw ? "corrupt" : "missing" };
  }

  function missionControlViewModel(request: FastifyRequest): MissionControlViewModel {
    // Every active item, plus only the most recent finished ones: the page
    // stays bounded as history grows. Card counts come from exact per-status
    // counts, so trimming finished items never undercounts failures.
    const { finished } = dashboardQuerySchema.parse(request.query ?? {});
    const dashboard = workItems.listDashboardWorkItems(finished === undefined ? {} : { finishedLimit: finished });
    const workItemList = [...dashboard.active, ...dashboard.finished];
    const ids = workItemList.map((workItem) => workItem.id);
    const attempts = executionReads.listExecutionAttemptsForWorkItems(ids);
    const leases = executionReads.listAttemptLeasesForWorkItems(ids);
    const now = new Date();
    const events = workItems.readEvents(eventReadOptions(request.query));
    const registeredAgents = workItems.listRegistryAgents();
    const projectedAgents = projectAgents(workItemList, events, now, registeredAgents);
    const executors = executorSummaries();
    const connectors = workItems.listConnectors();
    const enabledConnectorIds = new Set(
      connectors.filter((connector) => connector.status === "active").map((connector) => connector.id)
    );
    const tunnelSessions = workItems.listTunnelSessions();
    const admission = executionAdmission.snapshot();
    return {
      workItems: workItemList,
      executionPlansByWorkItem: Object.fromEntries(
        ids.flatMap((id) => {
          const plan = workItems.getCurrentExecutionPlan(id);
          return plan ? [[id, plan]] : [];
        })
      ),
      executionPlanAdmissionsByWorkItem: Object.fromEntries(executionReads.listCurrentPlanAdmissionsForWorkItems(ids)),
      statusCounts: dashboard.statusCounts,
      finishedWorkItems: {
        shown: dashboard.finished.length,
        total: dashboard.finishedTotal,
        limit: dashboard.finishedLimit
      },
      events,
      registeredAgents,
      agents: projectedAgents,
      infrastructure: {
        agents: {
          registered: registeredAgents.length,
          online: projectedAgents.filter((agent) => agent.status === "online").length
        },
        executors: {
          total: executors.length,
          configured: executors.filter((executor) => executor.configured).length,
          attestedRuntimes: executors.filter((executor) => executor.status === "active").length
        },
        connectors: {
          registered: connectors.length,
          enabled: enabledConnectorIds.size,
          activeSessions: tunnelSessions.filter(
            (session) =>
              enabledConnectorIds.has(session.connectorId) &&
              projectTunnelSession(session, heartbeatTtlMs).effectiveStatus === "active"
          ).length
        },
        admission: {
          active: admission.global.active,
          capacity: admission.global.capacity,
          queued: admission.global.queued,
          saturated: admission.saturated
        }
      },
      approvalActionsByWorkItem: approvalActionsByWorkItem(
        policy,
        workItemList,
        gatewayCredentialForRequest(request, auth)?.actor
      ),
      executionAttemptsByWorkItem: Object.fromEntries(ids.map((id) => [id, attempts.get(id) ?? []])),
      attemptLeasesByWorkItem: Object.fromEntries(
        ids.map((id) => [id, (leases.get(id) ?? []).map(toMissionControlAttemptLease)])
      ),
      executionBackend: reportedExecutionBackend(),
      executionTelemetry: executionReads.telemetry(now),
      readiness: mergeSandboxReadyzCheck(
        workItems.readinessHealth(),
        evaluateSandboxReadyzCheck(options.sandboxReadiness)
      ),
      composerActionKinds: [...SUPPORTED_ACTION_KINDS],
      policyDecisionEvents: workItems.readEvents({ name: "policy.decided", limit: POLICY_SUMMARY_WINDOW }),
      now,
      ...dashboardExecutionMode()
    };
  }

  app.get("/", { preHandler: requireRead }, async (request, reply) => {
    try {
      reply.type("text/html").send(renderDashboard(missionControlViewModel(request)));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Dashboard-internal: server-rendered section markup for Mission Control's
  // in-place live updates. Same read guard and data as GET /; not a public API.
  app.get("/dashboard/fragments", { preHandler: requireRead }, async (request, reply) => {
    try {
      reply.header("cache-control", "no-store");
      return { fragments: renderDashboardFragments(missionControlViewModel(request)) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Dashboard-internal: what would policy do with this composer draft? Same
  // contract admission and create-time policy as POST /work-items, evaluated
  // for the caller's requester identity, but nothing is created or audited.
  app.post("/dashboard/policy-preview", { preHandler: requireRead }, async (request, reply) => {
    try {
      const credential = gatewayCredentialForRequest(request, auth);
      const payload = requestObject(request.body);
      validateRegisteredAgentPromptTarget(workItems, payload);
      reply.header("cache-control", "no-store");
      return previewWorkItemPolicy(policy, {
        ...payload,
        requester: credential ? requesterForCredential(credential) : "user"
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Dashboard-internal: operator totals from the same registry /metrics renders.
  app.get("/dashboard/metrics", { preHandler: requireRead }, async (_request, reply) => {
    metrics.setSqliteReady(workItems.health().ok);
    reply.header("cache-control", "no-store");
    return { at: new Date().toISOString(), metrics: metrics.summary() };
  });

  // Dashboard-internal: older audit events for the timeline's "load older".
  app.get("/dashboard/events", { preHandler: requireRead }, async (request, reply) => {
    try {
      const { beforeSequence, limit } = dashboardEventsQuerySchema.parse(request.query ?? {});
      reply.header("cache-control", "no-store");
      return {
        events: workItems.readEvents({
          limit: Math.min(limit ?? DASHBOARD_EVENT_PAGE, MAX_EVENT_LIMIT),
          ...(beforeSequence === undefined ? {} : { beforeSequence })
        })
      };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/mcp/tools", async (request, reply) => {
    const requiredScopes = ["acs:work:read"] as const;
    const authorization = await authorizeMcpRequest({
      headers: request.headers,
      auth: mcpAuth,
      requiredScopes: [...requiredScopes],
      remoteAddress: request.socket.remoteAddress ?? request.ip
    });
    if (!authorization.ok) {
      const error = mcpAuthorizationHttpError(authorization, mcpResourceMetadataUrl(request, mcpAuth?.oauth), [
        ...requiredScopes
      ]);
      if (error.wwwAuthenticate) {
        reply.header("WWW-Authenticate", error.wwwAuthenticate);
      }
      return reply.code(error.statusCode).send({ error: error.error });
    }
    recordAuthenticatedMcpRequest({
      requestId: request.id,
      method: "GET",
      toolName: "tools/list",
      resolvedActor: resolveMcpActorId(workItems, authorization.auth, auth) ?? authorization.auth.subject,
      auth: authorization.auth
    });
    return { tools: workItemToolNames };
  });

  app.get("/api/connectors", { preHandler: requireRead }, async () => {
    const connectors = workItems
      .listConnectors()
      .map((connector) => projectConnector(connector, workItems.listTunnelSessions(connector.id), heartbeatTtlMs));
    return { connectors };
  });

  app.get<{ Params: { id: string } }>("/api/connectors/:id", { preHandler: requireRead }, async (request, reply) => {
    const connector = workItems.getConnector(request.params.id);
    if (!connector) return reply.code(404).send({ error: "connector not found" });
    const sessions = workItems.listTunnelSessions(connector.id);
    return {
      connector: projectConnector(connector, sessions, heartbeatTtlMs),
      sessions: sessions.map((session) => projectTunnelSession(session, heartbeatTtlMs))
    };
  });

  app.post("/connectors", async (request, reply) => {
    try {
      if (!requireMutationActor(request, reply, auth)) {
        return;
      }
      const actorId = requireBoundActorId(request, reply, auth);
      if (!actorId) {
        return;
      }
      const connector = workItems.registerConnector({ ...connectorBodySchema.parse(request.body), actorId });
      return reply.code(201).send({ connector });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/connectors/:id/rotate-key", async (request, reply) => {
    try {
      if (!requireMutationActor(request, reply, auth)) {
        return;
      }
      const actorId = requireBoundActorId(request, reply, auth);
      if (!actorId) {
        return;
      }
      const body = connectorKeyRotationBodySchema.parse(request.body);
      const connector = workItems.rotateConnectorKey({ id: request.params.id, ...body, actorId });
      return { connector };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/connectors/:id/tunnel-sessions", async (request, reply) => {
    try {
      if (!requireMutationActor(request, reply, auth)) {
        return;
      }
      const actorId = requireBoundActorId(request, reply, auth);
      if (!actorId) {
        return;
      }
      const body = tunnelSessionBodySchema.parse(request.body);
      const session = workItems.registerTunnelSession({ ...body, connectorId: request.params.id, actorId });
      return reply.code(201).send({ session });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string; tunnelId: string; sessionId: string } }>(
    "/connectors/:id/tunnels/:tunnelId/sessions/:sessionId/heartbeat",
    async (request, reply) => {
      try {
        if (!requireMutationActor(request, reply, auth)) {
          return;
        }
        const actorId = requireBoundActorId(request, reply, auth);
        if (!actorId) {
          return;
        }
        const session = workItems.heartbeatTunnelSession({
          connectorId: request.params.id,
          tunnelId: request.params.tunnelId,
          sessionId: request.params.sessionId,
          actorId
        });
        return { session };
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.post<{ Params: { id: string; tunnelId: string; sessionId: string } }>(
    "/connectors/:id/tunnels/:tunnelId/sessions/:sessionId/revoke",
    async (request, reply) => {
      try {
        if (!requireMutationActor(request, reply, auth)) {
          return;
        }
        const actorId = requireBoundActorId(request, reply, auth);
        if (!actorId) {
          return;
        }
        const session = workItems.revokeTunnelSession({
          connectorId: request.params.id,
          tunnelId: request.params.tunnelId,
          sessionId: request.params.sessionId,
          actorId
        });
        return { session };
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.get("/mcp", async (_request, reply) => {
    return reply
      .header("allow", "POST")
      .code(405)
      .send(jsonRpcError(null, -32000, "method not allowed"));
  });

  app.post("/mcp", async (request, reply) => {
    if (!isAllowedMcpOrigin(request.headers.origin, mcpAllowedOrigins)) {
      return reply.code(403).send(jsonRpcError(null, -32002, "forbidden origin"));
    }
    const resourceMetadataUrl = mcpResourceMetadataUrl(request, mcpAuth?.oauth);
    const localDevelopmentDirectAgentController = isDevelopmentLoopbackRequest(request)
      ? directAgentController
      : undefined;
    const result = await handleMcpHttpRequest({
      body: request.body,
      headers: request.headers,
      tools,
      store: workItems,
      directAgentController: localDevelopmentDirectAgentController,
      auth: mcpAuth,
      requireAuthentication: requiresMcpAuthentication(request, mcpAuth),
      resourceMetadataUrl,
      requestId: request.id,
      remoteAddress: request.socket.remoteAddress ?? request.ip,
      auditAuthenticatedRequest: recordAuthenticatedMcpRequest,
      auditLocalAgentEvent: recordLocalAgentEvent,
      resolveActorId: (mcpRequest) => resolveMcpActorId(workItems, mcpRequest, auth),
      maxPendingWorkItems,
      portfolioClient,
      toolAllowlist: mcpToolAllowlist,
      shutdownController
    });
    if (result.wwwAuthenticate) {
      reply.header("WWW-Authenticate", result.wwwAuthenticate);
    }
    if (result.body === undefined) {
      return reply.code(result.statusCode).send();
    }
    return reply.code(result.statusCode).send(result.body);
  });

  app.get("/.well-known/oauth-protected-resource", async (_request, reply) => {
    const metadata = protectedResourceMetadata(mcpAuth);
    if (!metadata) {
      return reply.code(404).send({ error: "MCP auth is not configured" });
    }
    return metadata;
  });

  app.get("/.well-known/oauth-protected-resource/mcp", async (_request, reply) => {
    const metadata = protectedResourceMetadata(mcpAuth);
    if (!metadata) {
      return reply.code(404).send({ error: "MCP auth is not configured" });
    }
    return metadata;
  });

  app.get("/work-items", { preHandler: requireRead }, async (request, reply) => {
    try {
      return { workItems: tools.list_work_items(listWorkItemsSchema.parse(request.query)) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/policy/explain", { preHandler: requireRead }, async (request, reply) => {
    try {
      return explainPolicy(request.body);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  const listActorsHandler = async () => ({ actors: workItems.listActors() });
  app.get("/api/actors", { preHandler: requireRead }, listActorsHandler);
  app.get("/actors", { preHandler: requireRead }, listActorsHandler);

  const registerActorHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      if (!requireMutationActor(request, reply, auth)) {
        return;
      }
      const registeredByActorId = requireBoundActorId(request, reply, auth);
      if (!registeredByActorId) {
        return;
      }
      const actor = workItems.registerActor({ ...actorBodySchema.parse(request.body), registeredByActorId });
      return reply.code(201).send({ actor });
    } catch (error) {
      return sendError(reply, error);
    }
  };
  app.post("/api/actors", registerActorHandler);
  app.post("/actors", registerActorHandler);

  app.get("/api/agents", { preHandler: requireRead }, async () => ({
    agents: workItems.listRegistryAgents().map((agent) => projectRegistryFreshness(agent, heartbeatTtlMs))
  }));

  app.get("/api/executors", { preHandler: requireRead }, async () => ({ executors: executorSummaries() }));

  app.get<{ Params: { id: string } }>("/api/executors/:id", { preHandler: requireRead }, async (request, reply) => {
    const executor = executorSummaries().find((candidate) => candidate.id === request.params.id);
    if (!executor) return reply.code(404).send({ error: "executor not found" });
    if (executor.id !== DC_BRIDGE_WORKER_ID) return { executor };
    return {
      executor,
      runtimes: capabilityIssuanceRegistry.listRuntimes().map((runtime) => ({
        runtimeId: runtime.runtimeId,
        status: runtime.status,
        scopes: [...runtime.scopes],
        registeredAt: runtime.registeredAt,
        attestedAt: runtime.attestedAt,
        ...(runtime.revokedAt ? { revokedAt: runtime.revokedAt } : {})
      }))
    };
  });

  app.get<{ Params: { id: string } }>(
    "/api/executors/:id/capabilities",
    { preHandler: requireRead },
    async (request, reply) => {
      if (request.params.id === DC_BRIDGE_WORKER_ID) return { capabilities: desktopExecutorCapabilities() };
      if (request.params.id === JC_BRIDGE_WORKER_ID) return { capabilities: jaceExecutorCapabilities() };
      return reply.code(404).send({ error: "executor not found" });
    }
  );

  app.post("/api/agents", async (request, reply) => {
    try {
      if (!requireMutationActor(request, reply, auth)) {
        return;
      }
      const actorId = requireBoundActorId(request, reply, auth);
      if (!actorId) {
        return;
      }
      const agent = workItems.createRegistryAgent({ ...agentBodySchema.parse(request.body), actorId });
      return reply.code(201).send({ agent });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  registerMcpClientRoutes({
    app,
    service: mcpClientService,
    requireRead,
    requireHumanActor: (request, reply) => requireHumanApprovalActor(request, reply, auth),
    requireBridge: (request, reply) => requireWorkerIdentity(request, reply, auth),
    laneForBridge: (workerId) =>
      workerId === JC_BRIDGE_WORKER_ID ? "jc" : workerId === DC_BRIDGE_WORKER_ID ? "dc" : undefined,
    sendError
  });
  registerMissionDispatchRoutes({
    app,
    store: workItems,
    enabled: options.missionDispatchEnabled ?? process.env.ACS_MISSION_DISPATCH_ENABLED === "1",
    requireRead,
    requireHumanActor: (request, reply) => requireHumanApprovalActor(request, reply, auth),
    sendError
  });
  const agentRuns = new AgentRunService(
    workItems,
    options.agentDispatch ?? agentDispatchConfigFromEnv(),
    options.agentRunNow ? { now: options.agentRunNow } : {}
  );
  agentRuns.reconcile();
  registerAgentRoutes({
    app,
    store: workItems,
    service: agentRuns,
    requireRead,
    requireHumanActor: (request, reply) => requireHumanApprovalActor(request, reply, auth),
    requireRegistryActor: (request, reply) =>
      requireMutationActor(request, reply, auth) ? requireBoundActorId(request, reply, auth) : undefined,
    sendError
  });
  app.addHook("onClose", async () => agentRuns.shutdown());

  app.get<{ Params: { id: string } }>("/api/agents/:id", { preHandler: requireRead }, async (request, reply) => {
    try {
      const agent = workItems.getRegistryAgent(request.params.id);
      if (!agent) {
        return reply.code(404).send({ error: "agent not found" });
      }
      const events = workItems.readEvents(eventReadOptions(request.query, { agentId: request.params.id }));
      const sessions = projectAgentSessions(events);
      return {
        agent: projectRegistryFreshness(agent, heartbeatTtlMs),
        activity: projectAgentActivity(agent, sessions),
        sessions,
        adapterStatus: adapterStatusFor(request.params.id),
        events
      };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/agents/:id", async (request, reply) => {
    try {
      if (!requireMutationActor(request, reply, auth)) {
        return;
      }
      const actorId = requireBoundActorId(request, reply, auth);
      if (!actorId) {
        return;
      }
      const agent = workItems.updateRegistryAgent(request.params.id, {
        ...agentPatchSchema.parse(request.body),
        actorId
      });
      return { agent };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>(
    "/api/agents/:id/capabilities",
    { preHandler: requireRead },
    async (request, reply) => {
      try {
        return { capabilities: workItems.listAgentCapabilities(request.params.id) };
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.put<{ Params: { id: string } }>("/api/agents/:id/capabilities", async (request, reply) => {
    try {
      if (!requireMutationActor(request, reply, auth)) {
        return;
      }
      const actorId = requireBoundActorId(request, reply, auth);
      if (!actorId) {
        return;
      }
      const body = capabilitiesBodySchema.parse(request.body);
      const capabilities = workItems.replaceAgentCapabilities(request.params.id, body.capabilities, actorId);
      return { capabilities };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/heartbeat", async (request, reply) => {
    try {
      if (!requireMutationActor(request, reply, auth)) {
        return;
      }
      const actorId = requireBoundActorId(request, reply, auth);
      if (!actorId) {
        return;
      }
      const result = workItems.recordAgentHeartbeat(request.params.id, {
        ...heartbeatBodySchema.parse(request.body),
        actorId
      });
      return reply.code(201).send(result);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/agents", { preHandler: requireRead }, async (request, reply) => {
    try {
      const events = workItems.readEvents(eventReadOptions(request.query));
      return { agents: projectAgents(workItems.list(), events, new Date(), workItems.listRegistryAgents()) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/agents/:id", { preHandler: requireRead }, async (request, reply) => {
    try {
      const events = workItems.readEvents(eventReadOptions(request.query, { agentId: request.params.id }));
      const agent = projectAgents(workItems.list(), events, new Date(), workItems.listRegistryAgents()).find(
        (candidate) => candidate.id === request.params.id
      );
      if (!agent) {
        return reply.code(404).send({ error: "agent not found" });
      }
      return { agent, adapterStatus: adapterStatusFor(request.params.id), events };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>(
    "/work-items/:id/mission-trace",
    { preHandler: requireRead },
    async (request, reply) => {
      try {
        return workItems.getMissionTrace(request.params.id, missionTraceQuerySchema.parse(request.query));
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.get<{ Params: { id: string } }>("/work-items/:id", { preHandler: requireRead }, async (request, reply) => {
    try {
      const workItem = tools.get_work_item({ id: request.params.id });
      if (!workItem) {
        return reply.code(404).send({ error: "work item not found" });
      }
      return {
        workItem,
        events: workItems.readEvents(eventReadOptions(request.query, { workItemId: request.params.id })),
        executionAttempts: executionReads
          .listExecutionAttempts(request.params.id)
          .map((attempt) => withAttemptPlan(workItems, attempt)),
        attemptLeases: executionReads.listAttemptLeases(request.params.id).map(toMissionControlAttemptLease)
      };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/work-items", async (request, reply) => {
    try {
      const actor = requireMutationActor(request, reply, auth);
      if (!actor) {
        return;
      }
      if (!hasPendingWorkItemCapacity(workItems, maxPendingWorkItems)) {
        return reply.code(429).send({ error: "pending work-item limit reached", code: "work_queue_full" });
      }
      const credential = gatewayCredentialForRequest(request, auth);
      if (!credential) return reply.code(401).send({ error: "unauthorized" });
      const payload = requestObject(request.body);
      validateRegisteredAgentPromptTarget(workItems, payload);
      const workItem = tools.create_work_item(
        createWorkItemSchema.parse({
          ...payload,
          requester: requesterForCredential(credential),
          requesterSubject: actor
        })
      );
      return reply.code(201).send(workItem);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/work-items/:id/change-sets", async (request, reply) => {
    try {
      const actor = requireMutationActor(request, reply, auth);
      if (!actor) return;
      const input = changeSetSubmissionBodySchema.parse(request.body);
      if (input.definition.missionId !== request.params.id) {
        throw new ControlStackError("change_set_input_mismatch", "change set targets a different mission");
      }
      const record = workItems.submitChangeSet({ ...input, createdByActorId: actor });
      return reply.code(201).send(record);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/work-items/:id/authority-grants", async (request, reply) => {
    try {
      const issuedByActorId = requireHumanApprovalActor(request, reply, auth);
      if (!issuedByActorId) return;
      if (issuedByActorId === ACS_ADMIN_APPROVER) return reply.code(403).send({ code: "human_authority_required" });
      const body = issueAutonomousAuthorityBodySchema.parse(request.body);
      for (const resource of body.definition.scope.filter((r) => r.kind === "path" || r.kind === "repository")) {
        for (const runtime of new Set(body.definition.toolClasses.map((tool) => tool.runtime))) {
          const containment =
            runtime === "desktop_commander" ? dcContainment : runtime === "jace_commander" ? jcContainment : undefined;
          if (!containment)
            throw new ControlStackError(
              "autonomous_authority_runtime_unsupported",
              "grant runtime containment is unavailable"
            );
          if (containPath(containment, resource.id).canonical !== resource.id)
            throw new ControlStackError("autonomous_authority_scope_mismatch", "grant path must be canonical");
        }
      }
      const grant = workItems.issueAutonomousAuthority(
        { ...body, missionId: request.params.id, issuedByActorId },
        { via: "policy_gate", actorId: issuedByActorId }
      );
      return reply.code(201).send(grant);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { id: string; grantId: string } }>(
    "/work-items/:id/authority-grants/:grantId",
    { preHandler: requireRead },
    async (request, reply) => {
      try {
        return workItems.withTransaction(() => {
          const grant = workItems.getAutonomousAuthority(request.params.grantId);
          if (!grant || grant.missionId !== request.params.id)
            return reply.code(404).send({ code: "autonomous_authority_not_found" });
          try {
            workItems.requireActiveAutonomousAuthority(
              grant.grantId,
              grant.missionId,
              grant.definition.executingActorId
            );
            return { grant, active: true };
          } catch (error) {
            if (
              !(error instanceof ControlStackError) ||
              ![
                "autonomous_authority_revoked",
                "autonomous_authority_expired",
                "change_set_input_mismatch",
                "change_set_mission_terminal"
              ].includes(error.code)
            )
              throw error;
            return { grant, active: false, code: error.code };
          }
        });
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.post<{ Params: { id: string; grantId: string } }>(
    "/work-items/:id/authority-grants/:grantId/revoke",
    async (request, reply) => {
      try {
        const actorId = requireHumanApprovalActor(request, reply, auth);
        if (!actorId) return;
        const body = changeSetRevocationBodySchema.parse(request.body);
        workItems.withTransaction(() => {
          const grant = workItems.getAutonomousAuthority(request.params.grantId);
          if (!grant || grant.missionId !== request.params.id)
            throw new ControlStackError("autonomous_authority_binding_mismatch", "grant not found in mission");
          workItems.revokeAutonomousAuthority(grant.grantId, actorId, body.reason, { via: "policy_gate", actorId });
        });
        return { revoked: true };
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.post<{ Params: { id: string } }>("/work-items/:id/change-sets/authorize", async (request, reply) => {
    try {
      const actorId = requireMutationActor(request, reply, auth);
      if (!actorId) return;
      const body = grantAuthorizationBodySchema.parse(request.body);
      const authorization = workItems.withTransaction(() => {
        workItems.requireActiveAutonomousAuthority(body.grantId, request.params.id, actorId);
        const mission = workItems.get(request.params.id)!;
        const record = workItems.getChangeSet(mission.id);
        if (!record) throw new ControlStackError("change_set_not_found", "Change Set not found");
        const evaluation = evaluateChangeSetPolicy({
          record,
          mission,
          actorId,
          expectedManifestHash: body.expectedManifestHash,
          resolveOperation: (operation) =>
            resolveChangeSetRuntimePolicy({ operation, mission, actorId, dcContainment, jcContainment })
        });
        if (evaluation.decision.decision === "deny")
          throw new ControlStackError(
            "grant_authorization_policy_mismatch",
            "deterministic policy denies authorization"
          );
        const prior = workItems.getGrantAuthorizationForGrant(body.grantId, body.expectedManifestHash);
        const policyAuditEventId =
          prior?.policyAuditEventId ??
          workItems.recordSystemEvent({
            name: "change_set.policy_evaluated",
            body: { ...evaluation },
            attributes: {
              "work_item.id": mission.id,
              "change_set.hash": record.manifestHash,
              "authority.grant_id": body.grantId
            }
          }).id;
        return workItems.authorizeChangeSetWithGrant(
          {
            grantId: body.grantId,
            missionId: mission.id,
            expectedManifestHash: body.expectedManifestHash,
            executingActorId: actorId,
            policyHash: changeSetPolicyHash(evaluation),
            policyAuditEventId
          },
          { via: "policy_gate", actorId }
        );
      });
      return reply.code(201).send(authorization);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { id: string; authorizationId: string } }>(
    "/work-items/:id/change-set-authorizations/:authorizationId",
    { preHandler: requireRead },
    async (request, reply) => {
      try {
        return workItems.withTransaction(() => {
          const authorization = workItems.getGrantAuthorization(request.params.authorizationId);
          if (!authorization || authorization.missionId !== request.params.id)
            return reply.code(404).send({ code: "grant_authorization_not_found" });
          try {
            workItems.requireActiveGrantAuthorization(
              authorization.authorizationId,
              authorization.manifestHash,
              authorization.executingActorId
            );
            return { authorization, active: true };
          } catch (error) {
            if (
              !(error instanceof ControlStackError) ||
              ![
                "autonomous_authority_revoked",
                "autonomous_authority_expired",
                "change_set_input_mismatch",
                "change_set_mission_terminal",
                "grant_authorization_superseded",
                "grant_authorization_expired"
              ].includes(error.code)
            )
              throw error;
            return { authorization, active: false, code: error.code };
          }
        });
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.post<{ Params: { id: string } }>("/work-items/:id/change-sets/policy", async (request, reply) => {
    try {
      const actorId = requireMutationActor(request, reply, auth);
      if (!actorId) return;
      const body = changeSetPolicyBodySchema.parse(request.body);
      const result = workItems.withTransaction(() => {
        const mission = workItems.get(request.params.id);
        if (!mission) throw new ControlStackError("work_item_not_found", "mission not found");
        const record = workItems.getChangeSet(mission.id);
        if (!record) throw new ControlStackError("change_set_not_found", "change set not found");
        const evaluation = evaluateChangeSetPolicy({
          record,
          mission,
          actorId,
          expectedManifestHash: body.expectedManifestHash,
          resolveOperation: (operation) =>
            resolveChangeSetRuntimePolicy({ operation, mission, actorId, dcContainment, jcContainment })
        });
        const event = workItems.recordSystemEvent({
          name: "change_set.policy_evaluated",
          body: { ...evaluation },
          attributes: { "work_item.id": mission.id, "change_set.hash": record.manifestHash }
        });
        return { ...evaluation, auditEventId: event.id };
      });
      return result;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string; operationId: string } }>(
    "/work-items/:id/change-sets/operations/:operationId/permit",
    async (request, reply) => {
      try {
        const actorId = requireMutationActor(request, reply, auth);
        if (!actorId) return;
        const body = changeSetOperationPermitBodySchema.parse(request.body);
        const permit = workItems.withTransaction(() => {
          const reference =
            "approvalId" in body ? { approvalId: body.approvalId } : { authorizationId: body.authorizationId };
          const approval = workItems.requireActiveChangeSetExecutionAuthority(
            reference,
            body.expectedManifestHash,
            actorId
          );
          if (approval.missionId !== request.params.id)
            throw new ControlStackError("change_set_permit_binding_mismatch", "mission binding mismatch");
          const record = workItems.getChangeSet(approval.missionId)!;
          const mission = workItems.get(approval.missionId)!;
          const resolveOperation = (operation: (typeof record.snapshot.definition.operations)[number]) =>
            resolveChangeSetRuntimePolicy({
              operation,
              mission,
              actorId: approval.policyActorId,
              dcContainment,
              jcContainment
            });
          const evaluation = evaluateChangeSetPolicy({
            record,
            mission,
            actorId: approval.policyActorId,
            expectedManifestHash: body.expectedManifestHash,
            resolveOperation
          });
          if (changeSetPolicyHash(evaluation) !== approval.policyHash)
            throw new ControlStackError(
              "change_set_approval_policy_mismatch",
              "approved policy no longer matches current policy"
            );
          const operation = record.snapshot.definition.operations.find(
            (op) => op.operationId === request.params.operationId
          );
          if (!operation)
            throw new ControlStackError("change_set_operation_not_found", "operation not in approved snapshot");
          const existing = workItems.getChangeSetOperationPermitForOperation(
            mission.id,
            record.manifestHash,
            operation.operationId
          );
          if (existing) {
            if ((existing.approvalId ?? existing.authorizationId) !== approval.authorityId)
              throw new ControlStackError("change_set_permit_conflict", "operation belongs to another approval");
            return existing;
          }
          const jc = operation.runtime === "jace_commander";
          const config = jc ? jcSigningConfig : capabilitySigningConfig;
          if (!config || operation.runtime === "sandbox")
            throw new ControlStackError("change_set_runtime_unsupported", "governed runtime is not configured");
          const facts = resolveOperation(operation);
          if (approval.grant) {
            // Arbitrary commands currently bind cwd, not every filesystem side
            // effect. A broad grant must not turn that into claimed confinement.
            if (
              facts.privileges.some((privilege) => !["fs.read", "fs.write"].includes(privilege)) ||
              facts.resources.length === 0
            )
              throw new ControlStackError(
                "autonomous_authority_runtime_unconfined",
                "runtime cannot enforce this grant's resource boundary"
              );
            const checks = record.snapshot.definition.verification.filter((rule) =>
              rule.operationIds.includes(operation.operationId)
            );
            // Defense in depth: submission already refuses unimplemented kinds, so
            // this can only trigger on tampered persisted state. Same vocabulary.
            if (
              checks.some(
                (rule) => !(IMPLEMENTED_CHANGE_SET_VERIFICATION_KINDS as readonly string[]).includes(rule.kind)
              )
            )
              throw new ControlStackError(
                "verification_adapter_unavailable",
                "grant execution needs implemented verification before mutation"
              );
            for (const check of checks.filter((rule) => rule.kind === "fs_inspect"))
              fileReadbackExpectationSchema.parse(check.expectation);
          }
          const child = tools.create_work_item(
            changeSetExecutionInput({
              record,
              operationId: operation.operationId,
              ...reference,
              facts,
              runtimeId: config.runtimeId,
              ...(!jc && capabilitySigningConfig
                ? { identityConfigFingerprint: capabilitySigningConfig.identityConfigFingerprint }
                : {})
            })
          );
          const evaluations = policy.evaluateWorkItem(child, approval.humanIssuerActorId, "approve");
          if (policy.summarize(evaluations).decision === "deny")
            throw new ControlStackError("change_set_approval_denied", "execution policy denies operation");
          for (const evaluation of evaluations.filter((e) => e.decision.decision === "require_approval")) {
            tools.approve_work_item({
              id: child.id,
              actionHash: evaluation.actionHash,
              approvedBy: approval.humanIssuerActorId,
              reason: `Bound Change Set ${approval.authorityKind} ${approval.authorityId}`
            });
          }
          const workerId = jc ? JC_BRIDGE_WORKER_ID : DC_BRIDGE_WORKER_ID;
          workItems.assignWorkItem(
            {
              workItemId: child.id,
              selectedWorkerId: workerId,
              selectedAgentId: actorId,
              routingDecisionId: record.manifestHash,
              assignedByActorId: actorId
            },
            { via: "policy_gate", actorId }
          );
          return workItems.bindChangeSetOperationPermit(
            {
              missionId: mission.id,
              manifestHash: record.manifestHash,
              operationId: operation.operationId,
              ...reference,
              policyHash: approval.policyHash,
              executionWorkItemId: child.id,
              workerId,
              runtime: jc ? "jace_commander" : "desktop_commander",
              toolName: operation.toolName,
              invocationHash: facts.invocationHash
            },
            { via: "policy_gate", actorId }
          );
        });
        return reply.code(201).send(permit);
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  function changeSetPermitWorkItem(
    permitId: string,
    runtime: "desktop_commander" | "jace_commander",
    actorId: string,
    tool: string,
    invocationHash: string,
    bindingHash: string
  ) {
    return workItems.withTransaction(() => {
      const permit = workItems.getChangeSetOperationPermit(permitId);
      if (
        !permit ||
        permit.runtime !== runtime ||
        permit.executingActorId !== actorId ||
        permit.toolName !== tool ||
        permit.invocationHash !== invocationHash
      )
        throw new ControlStackError(
          "change_set_permit_binding_mismatch",
          "runtime request does not match operation permit"
        );
      workItems.requireActiveChangeSetOperationPermit(permit.executionWorkItemId, permit.workerId);
      const approval = workItems.requireActiveChangeSetExecutionAuthority(
        permit,
        permit.manifestHash,
        permit.executingActorId
      );
      const record = workItems.getChangeSet(permit.missionId)!;
      const mission = workItems.get(permit.missionId)!;
      const evaluation = evaluateChangeSetPolicy({
        record,
        mission,
        actorId: approval.policyActorId,
        expectedManifestHash: permit.manifestHash,
        resolveOperation: (operation) =>
          resolveChangeSetRuntimePolicy({
            operation,
            mission,
            actorId: approval.policyActorId,
            dcContainment,
            jcContainment
          })
      });
      if (changeSetPolicyHash(evaluation) !== permit.policyHash)
        throw new ControlStackError(
          "change_set_approval_policy_mismatch",
          "approved policy no longer matches runtime policy"
        );
      const child = workItems.get(permit.executionWorkItemId)!;
      if (child.requestedActions[0]?.params.bindingHash !== bindingHash || child.status !== "approved")
        throw new ControlStackError(
          "change_set_permit_binding_mismatch",
          "operation already claimed or runtime binding changed"
        );
      return child;
    });
  }

  app.post<{ Params: { id: string } }>("/work-items/:id/change-sets/approve", async (request, reply) => {
    try {
      const actorId = requireHumanApprovalActor(request, reply, auth);
      if (!actorId) return;
      if (actorId === ACS_ADMIN_APPROVER) return reply.code(403).send({ code: "human_authority_required" });
      const body = changeSetApprovalBodySchema.parse(request.body);
      const result = workItems.withTransaction(() => {
        const mission = workItems.get(request.params.id);
        if (!mission) throw new ControlStackError("work_item_not_found", "mission not found");
        const record = workItems.getChangeSet(mission.id);
        if (!record) throw new ControlStackError("change_set_not_found", "change set not found");
        const evaluation = evaluateChangeSetPolicy({
          record,
          mission,
          actorId,
          expectedManifestHash: body.expectedManifestHash,
          resolveOperation: (operation) =>
            resolveChangeSetRuntimePolicy({ operation, mission, actorId, dcContainment, jcContainment })
        });
        if (evaluation.decision.decision === "deny")
          throw new ControlStackError("change_set_approval_denied", "bundle policy denies approval");
        const replay = workItems.getChangeSetApprovalByRequest(mission.id, body.requestId);
        const policyAuditEventId =
          replay?.policyAuditEventId ??
          workItems.recordSystemEvent({
            name: "change_set.policy_evaluated",
            body: { ...evaluation },
            attributes: { "work_item.id": mission.id, "change_set.hash": record.manifestHash }
          }).id;
        return workItems.grantChangeSetApproval(
          {
            missionId: mission.id,
            expectedManifestHash: body.expectedManifestHash,
            requestId: body.requestId,
            approvedByActorId: actorId,
            reason: body.reason,
            expiresAt: body.expiresAt ?? record.snapshot.definition.expiresAt,
            policyHash: changeSetPolicyHash(evaluation),
            policyAuditEventId
          },
          { via: "policy_gate", actorId }
        );
      });
      return reply.code(201).send(result);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { id: string; approvalId: string } }>(
    "/work-items/:id/change-set-approvals/:approvalId",
    { preHandler: requireRead },
    async (request, reply) => {
      try {
        return workItems.withTransaction(() => {
          const approval = workItems.getChangeSetApproval(request.params.approvalId);
          if (!approval || approval.missionId !== request.params.id)
            return reply.code(404).send({ code: "change_set_approval_not_found" });
          try {
            workItems.requireActiveChangeSetApproval(
              approval.approvalId,
              approval.manifestHash,
              approval.executingActorId
            );
            return { approval, active: true };
          } catch (error) {
            if (
              !(error instanceof ControlStackError) ||
              ![
                "change_set_approval_revoked",
                "change_set_approval_expired",
                "change_set_approval_superseded",
                "change_set_mission_terminal",
                "change_set_input_mismatch"
              ].includes(error.code)
            )
              throw error;
            return { approval, active: false, code: error.code };
          }
        });
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.post<{ Params: { id: string; approvalId: string } }>(
    "/work-items/:id/change-set-approvals/:approvalId/revoke",
    async (request, reply) => {
      try {
        const actorId = requireHumanApprovalActor(request, reply, auth);
        if (!actorId) return;
        const body = changeSetRevocationBodySchema.parse(request.body);
        return workItems.withTransaction(() => {
          const approval = workItems.getChangeSetApproval(request.params.approvalId);
          if (!approval || approval.missionId !== request.params.id)
            return reply.code(404).send({ code: "change_set_approval_not_found" });
          workItems.revokeChangeSetApproval(approval.approvalId, actorId, body.reason, { via: "policy_gate", actorId });
          return { revoked: true };
        });
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.get<{ Params: { id: string } }>(
    "/work-items/:id/change-sets",
    { preHandler: requireRead },
    async (request, reply) => {
      try {
        const query = changeSetQuerySchema.parse(request.query);
        if (!workItems.get(request.params.id)) return reply.code(404).send({ code: "work_item_not_found" });
        const record = workItems.getChangeSet(request.params.id, query.revision);
        if (!record) return reply.code(404).send({ code: "change_set_not_found" });
        return record;
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.get<{ Params: { id: string } }>(
    "/work-items/:id/change-sets/progress",
    { preHandler: requireRead },
    async (request, reply) => {
      try {
        const query = changeSetPolicyBodySchema.parse(request.query);
        return workItems.getChangeSetProgress(request.params.id, query.expectedManifestHash);
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.post<{ Params: { id: string } }>("/work-items/:id/change-sets/complete", async (request, reply) => {
    try {
      const actorId = requireMutationActor(request, reply, auth);
      if (!actorId) return;
      const body = changeSetOperationPermitBodySchema.parse(request.body);
      return workItems.completeChangeSetMission(
        {
          missionId: request.params.id,
          executingActorId: actorId,
          ...body
        },
        { via: "policy_gate", actorId }
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/coding-missions", async (request, reply) => {
    try {
      const actor = requireMutationActor(request, reply, auth);
      if (!actor) return;
      if (!codingMissions) {
        return reply
          .code(503)
          .send({ error: "coding mission ports are not configured", code: "coding_mission_unconfigured" });
      }
      const body = codingMissionCreateBodySchema.parse(request.body);
      codingMissions.create(body);
      await codingMissions.runUntilStable(body.missionId);
      return reply.code(201).send(codingMissions.approvalView(body.missionId));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/coding-missions", async (request, reply) => {
    try {
      const credential = gatewayCredentialForRequest(request, auth);
      if (!credential?.scopes.includes("acs:read")) return reply.code(401).send({ error: "unauthorized" });
      if (!codingMissions) {
        return reply
          .code(503)
          .send({ error: "coding mission ports are not configured", code: "coding_mission_unconfigured" });
      }
      return { missions: codingMissions.listRecent() };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/coding-missions/:id", async (request, reply) => {
    try {
      const credential = gatewayCredentialForRequest(request, auth);
      if (!credential?.scopes.includes("acs:read")) return reply.code(401).send({ error: "unauthorized" });
      if (!codingMissions) {
        return reply
          .code(503)
          .send({ error: "coding mission ports are not configured", code: "coding_mission_unconfigured" });
      }
      return codingMissions.approvalView(request.params.id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/coding-missions/:id/approve", async (request, reply) => {
    try {
      const actor = requireMutationActor(request, reply, auth, "acs:approve");
      if (!actor) return;
      if (!codingMissions) {
        return reply
          .code(503)
          .send({ error: "coding mission ports are not configured", code: "coding_mission_unconfigured" });
      }
      const body = codingMissionApprovalBodySchema.parse(request.body);
      await codingMissions.approve(request.params.id, {
        approverId: actor,
        expectedChangeSetHash: body.expectedChangeSetHash
      });
      return codingMissions.approvalView(request.params.id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // External webhook ingest: Hermes (or any upstream) -> ACS control plane.
  // The webhook is a DETERMINISTIC RECEIVER boundary. It does NOT call the
  // downstream system directly. It authenticates the caller (same fail-closed
  // gateway auth as every mutation), enforces idempotency, and creates a
  // governed work item through the exact same policy-gate + audit path as a
  // manual item. ACS's own worker later claims and executes it under lease
  // fencing. The caller-supplied body may not set requester/status/source.
  app.post<{ Params: { source: string } }>("/webhooks/:source", async (request, reply) => {
    reply.header("x-request-id", request.id);
    try {
      const actor = requireMutationActor(request, reply, auth);
      if (!actor) {
        return;
      }
      const source = request.params.source;
      if (!source || !/^[a-z0-9_-]{1,64}$/i.test(source)) {
        return reply.code(400).send({ error: "invalid webhook source", code: "invalid_webhook_source" });
      }
      const body = webhookIngestSchema.parse(requestObject(request.body));
      const idempotencyKey = firstHeader(request.headers["idempotency-key"]);
      if (idempotencyKey && !/^[A-Za-z0-9._:-]{1,256}$/.test(idempotencyKey)) {
        return reply.code(400).send({ error: "invalid idempotency-key", code: "invalid_idempotency_key" });
      }

      const workItemInput = {
        title: body.title,
        intent: body.intent,
        requester: "agent" as const,
        requesterSubject: `${source}:${actor}`,
        target: body.target ?? { cwd: process.cwd() },
        requestedActions: body.requestedActions ?? [{ kind: "manual", description: body.intent }],
        risk: body.risk ?? "medium",
        ...(body.correlationId ? { metadata: { webhookSource: source, correlationId: body.correlationId } } : {})
      };

      // Idempotency: atomic reservation prevents concurrent requests from creating duplicate work items.
      const idemKey = idempotencyKey ? `webhook:${source}:${idempotencyKey}` : undefined;
      if (idemKey) {
        const reservation = await workItemIdempotency.tryReserve(idemKey);
        if (!reservation.reserved) {
          if (reservation.existing !== undefined) {
            const replayed = reservation.existing as { workItemId: string; status: string; approvalRequired: boolean };
            request.log.info(
              { requestId: request.id, source, workItemId: replayed.workItemId },
              "webhook replay (idempotent)"
            );
            workItems.recordConnectorRequest({
              actor,
              source: `webhook:${source}`,
              route: `/webhooks/${source}`,
              toolName: "ingest_webhook",
              workItemId: replayed.workItemId,
              requestId: request.id,
              authMethod: "gateway_bearer",
              authSubject: actor
            });
            return reply.code(200).send({ ...replayed, replayed: true });
          }
          return reply
            .code(409)
            .send({ error: "concurrent webhook request in progress", code: "concurrent_idempotency_conflict" });
        }
      }

      if (!hasPendingWorkItemCapacity(workItems, maxPendingWorkItems)) {
        if (idemKey) await workItemIdempotency.remove(idemKey);
        return reply.code(429).send({ error: "pending work-item limit reached", code: "work_queue_full" });
      }

      let workItem;
      try {
        workItem = tools.create_work_item(createWorkItemSchema.parse(workItemInput));
      } catch (createError) {
        if (idemKey) {
          await workItemIdempotency.remove(idemKey);
        }
        throw createError;
      }

      const approvalRequired = workItem.status === "needs_approval";
      const response = {
        workItemId: workItem.id,
        status: workItem.status,
        approvalRequired
      };
      if (idemKey) {
        try {
          await workItemIdempotency.put(idemKey, response);
        } catch (idemError) {
          request.log.warn({ requestId: request.id, err: idemError }, "webhook idempotency write failed (non-fatal)");
        }
      }
      request.log.info({ requestId: request.id, source, workItemId: workItem.id }, "webhook accepted");
      return reply.code(201).send(response);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // ACS-issued Desktop Commander capability issuance (lease-bound, per call).
  //
  // Only the dedicated managed bridge may mint capabilities. The bridge sends
  // the exact current tool arguments, which are validated and canonicalized in
  // memory before ACS creates policy, approval, attempt, or lease state. Raw
  // arguments are never persisted in work-item or audit-visible fields.
  app.post(
    "/dc/capability/issue",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      let authenticatedBridge = false;
      try {
        const workerId = requireWorkerIdentity(request, reply, auth);
        if (!workerId) {
          return;
        }
        if (workerId !== DC_BRIDGE_WORKER_ID) {
          return reply.code(403).send({
            error: "dedicated Desktop Commander bridge identity is required",
            code: "dc_bridge_identity_required"
          });
        }
        authenticatedBridge = true;
        const dcActor = firstHeader(request.headers["x-dc-actor"]);
        if (!dcActor || !/^[A-Za-z0-9._:@-]{1,128}$/u.test(dcActor)) {
          return reply.code(400).send({ error: "x-dc-actor header is required", code: "dc_actor_invalid" });
        }
        const body = dcCapabilityIssueSchema.parse(requestObject(request.body));
        const dcAdmission = admitMcpCaller("dc", request, body.client_id);
        if (!dcAdmission.ok) {
          recordDcCapabilityAudit(workerId, request.id, body.tool, dcActor, "denied");
          return reply.code(403).send({
            decision: "deny",
            reason: "mcp_client_unlabelled",
            code: "mcp_client_unlabelled",
            detail: dcAdmission.detail
          });
        }
        if (!capabilitySigningConfig || !dcContainment) {
          return reply
            .code(503)
            .send({ error: "capability issuance not configured", code: "capability_issuance_unconfigured" });
        }
        try {
          validateCapabilitySigningConfig(capabilitySigningConfig);
        } catch {
          return reply
            .code(503)
            .send({ error: "capability signing key is invalid", code: "capability_signing_key_invalid" });
        }
        if (dcSchedulerNeedsRuntimeReconciliation) {
          return reply.code(503).send({
            error: "managed Desktop Commander runtime must re-attest after gateway restart before scheduling resumes",
            code: "scheduler_runtime_reconciliation_required",
            retryable: true
          });
        }

        const dcPolicy = desktopCommanderToolPolicy(body.tool);
        if (!dcPolicy) {
          recordDcCapabilityAudit(workerId, request.id, body.tool, dcActor, "denied");
          const disposition = desktopCommanderManagedToolDisposition(body.tool);
          if (disposition?.managed === "unsupported") {
            // A registered Desktop Commander tool with an explicit managed-mode
            // disposition of "unsupported": deterministic, non-retryable.
            return reply.code(403).send({
              decision: "deny",
              reason: "managed_tool_unsupported",
              code: "managed_tool_unsupported",
              detail: `${body.tool} (${disposition.toolClass}) is not supported through managed mode: ${disposition.reason}`
            });
          }
          return reply.code(403).send({ decision: "deny", reason: "unknown_tool", code: "unknown_tool" });
        }

        let requestArguments: Record<string, unknown>;
        let invocation;
        try {
          requestArguments = parseDcArgsSummary(body.argsSummary);
          invocation = normalizeInvocation(body.tool, requestArguments, dcContainment);
        } catch (error) {
          recordDcCapabilityAudit(workerId, request.id, body.tool, dcActor, "denied");
          return reply.code(400).send({
            decision: "deny",
            reason: "invalid_arguments",
            code: error instanceof ControlStackError ? error.code : "desktop_commander_argument_invalid",
            // The validation message only echoes the caller's own argument
            // shape (key names, schema bounds, requested path); never secrets.
            ...(error instanceof ControlStackError ? { detail: error.message.slice(0, 512) } : {})
          });
        }

        const invocationHash = desktopCommanderInvocationFingerprint(invocation);
        const requiredScopes = desktopCommanderRequiredScopes(body.tool);
        const targetCwd =
          typeof invocation.validatedArguments.cwd === "string"
            ? invocation.validatedArguments.cwd
            : (containmentRootForPaths(dcContainment, invocation.canonicalPaths) ?? process.cwd());
        const policyPaths = invocation.canonicalPaths.length > 0 ? invocation.canonicalPaths : [targetCwd];
        const riskByClass: Record<typeof dcPolicy.riskClass, "low" | "medium" | "high" | "critical"> = {
          read_only: "low",
          safe_mutation: "medium",
          requires_approval: "high",
          destructive: "critical"
        };
        const bindingHash = stableHash({
          tool: body.tool,
          invocationHash,
          runtimeId: capabilitySigningConfig.runtimeId,
          identityConfigFingerprint: capabilitySigningConfig.identityConfigFingerprint,
          requiredScopes,
          requesterSubject: dcActor
        });

        const modeBeforeLookup = readExecutionModeValue(workItems.getExecutionMode().raw);
        const existing = body.changeSetPermitId
          ? changeSetPermitWorkItem(
              body.changeSetPermitId,
              "desktop_commander",
              dcActor,
              body.tool,
              invocationHash,
              bindingHash
            )
          : workItems
              .list()
              .filter((candidate) => {
                const params = candidate.requestedActions[0]?.params as Record<string, unknown> | undefined;
                return (
                  !params?.changeSetBinding &&
                  candidate.requesterSubject === dcActor &&
                  params?.tool === body.tool &&
                  params?.bindingHash === bindingHash &&
                  ["needs_approval", "approved"].includes(candidate.status) &&
                  (modeBeforeLookup.state === "ok" && modeBeforeLookup.mode === "admin"
                    ? true
                    : !workItems.hasGrantedApprovalBy(candidate.id, ACS_ADMIN_APPROVER))
                );
              })
              .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];

        if (!existing && !hasPendingWorkItemCapacity(workItems, maxPendingWorkItems)) {
          return reply.code(429).send({ error: "pending work-item limit reached", code: "work_queue_full" });
        }

        const approvalSummary = dcApprovalSummary(body.tool, invocation.validatedArguments, invocationHash);

        let workItem =
          existing ??
          tools.create_work_item(
            createWorkItemSchema.parse({
              title: `Desktop Commander capability: ${body.tool}`,
              intent: `ACS-issued capability for Desktop Commander tool ${body.tool} requested by ${dcActor}`,
              requester: "agent",
              requesterSubject: dcActor,
              target: {
                cwd: targetCwd,
                files: policyPaths
              },
              requestedActions: [
                {
                  kind: dcWorkItemActionKind(dcPolicy),
                  description: `Desktop Commander tool ${body.tool}`,
                  params: {
                    tool: body.tool,
                    invocationHash,
                    bindingHash,
                    runtimeId: capabilitySigningConfig.runtimeId,
                    identityConfigFingerprint: capabilitySigningConfig.identityConfigFingerprint,
                    requiredScopes,
                    requesterSubject: dcActor,
                    approvalSummary,
                    write: dcPolicy.mutating,
                    network: dcPolicy.network,
                    destructive: dcPolicy.destructive,
                    cwd: targetCwd,
                    paths: policyPaths
                  }
                }
              ],
              risk: riskByClass[dcPolicy.riskClass],
              ...(body.correlationId ? { metadata: { correlationId: body.correlationId } } : {})
            })
          );

        const evaluations = policy.evaluateWorkItem(workItem, workerId, "approve");
        const required = evaluations.filter((evaluation) => evaluation.decision.decision === "require_approval");
        const actionHash = required[0]?.actionHash ?? executionActionHash(workItem);

        if (workItem.status === "blocked") {
          recordDcCapabilityAudit(workerId, request.id, body.tool, dcActor, "denied", workItem.id);
          return reply.code(403).send({
            decision: "deny",
            reason: "policy_denied",
            workItemId: workItem.id,
            detail: policy.summarize(evaluations).reason
          });
        }
        const mode = readExecutionModeValue(workItems.getExecutionMode().raw);
        if (mode.state !== "ok") {
          recordDcCapabilityAudit(workerId, request.id, body.tool, dcActor, "denied", workItem.id);
          return reply.code(403).send({
            decision: "deny",
            code: mode.state === "missing" ? "execution_mode_missing" : "execution_mode_corrupt",
            reason: "canonical execution mode is not usable",
            workItemId: workItem.id
          });
        }

        // Set only in the admin-mode case where policy already allows every action and no
        // approval record exists (see the admin auto-authorization block below).
        let adminAuthorizedWithoutApproval = false;
        if (mode.mode === "admin" && !body.changeSetPermitId) {
          const gate = adminExecutionGate(readAuthority(), true);
          if (!gate.ok) {
            recordDcCapabilityAudit(workerId, request.id, body.tool, dcActor, "denied", workItem.id);
            workItems.recordSystemEvent({
              name: "execution_mode.auto_authorization_denied",
              body: {
                code: gate.code,
                tool: body.tool,
                workItemId: workItem.id,
                correlationId: body.correlationId ?? null
              },
              attributes: { "work_item.id": workItem.id, "execution_mode.mode": "admin" }
            });
            return reply.code(403).send({
              decision: "deny",
              code: gate.code,
              reason: gate.detail,
              workItemId: workItem.id
            });
          }
          // Same rule as the JC lane: when policy asked for no approval record, an
          // "approved" status carries no approval authority, so admin evaluation must
          // still run or admin mode falls through to the require_approval gate for an
          // action policy already allows.
          const needsAdminAuthorization = workItem.status !== "approved" || required.length === 0;
          if (needsAdminAuthorization) {
            try {
              const adminEvaluations = policy.evaluateWorkItem(workItem, ACS_ADMIN_APPROVER, "approve");
              const adminSummary = policy.summarize(adminEvaluations);
              if (adminSummary.decision === "deny") {
                recordDcCapabilityAudit(workerId, request.id, body.tool, dcActor, "denied", workItem.id);
                return reply.code(403).send({
                  decision: "deny",
                  code: "admin_authorization_failed",
                  reason: adminSummary.reason,
                  workItemId: workItem.id
                });
              }
              const adminRequired = adminEvaluations.filter(
                (evaluation) => evaluation.decision.decision === "require_approval"
              );
              const adminActionHash = adminRequired[0]?.actionHash;
              if (adminSummary.decision === "allow") {
                // Policy already authorizes every action for the admin approver, so there is
                // no approval record to create: there is no actionHash to approve and nothing
                // to approve. Treating that absence as a failure would deny with the allow reason.
                //
                // See the JC lane: admin authorization lets the ORDINARY admission path
                // continue - approved status, normal execution-plan admission with
                // requiresApproval=false, normal lease + fencing + ownership - with no
                // approval record fabricated and no parallel admin-only authority model.
                adminAuthorizedWithoutApproval = true;
                // Record the authorizing evaluation itself, so the audit chain carries
                // the action hash and matched policy rules rather than only a mode event.
                for (const evaluation of adminEvaluations) {
                  workItems.recordPolicyDecision({
                    workItemId: workItem.id,
                    actionHash: evaluation.actionHash,
                    context: policyContextAuditReceipt(evaluation.context),
                    ...evaluation.decision
                  });
                }
                if (workItem.status !== "approved") {
                  workItem = workItems.approveWorkItem(workItem.id, { via: "policy_gate" });
                }
              } else if (adminActionHash) {
                const approved = tools.approve_work_item({
                  id: workItem.id,
                  actionHash: adminActionHash,
                  approvedBy: ACS_ADMIN_APPROVER,
                  reason: ACS_ADMIN_APPROVAL_REASON
                });
                if (approved.decision.decision === "deny" || approved.workItem.status !== "approved") {
                  recordDcCapabilityAudit(workerId, request.id, body.tool, dcActor, "denied", workItem.id);
                  return reply.code(403).send({
                    decision: "deny",
                    code: "admin_authorization_failed",
                    reason: approved.decision.reason,
                    workItemId: workItem.id
                  });
                }
                workItem = approved.workItem;
              } else {
                // require_approval with no approval record to satisfy: fail closed.
                recordDcCapabilityAudit(workerId, request.id, body.tool, dcActor, "denied", workItem.id);
                return reply.code(403).send({
                  decision: "deny",
                  code: "admin_authorization_failed",
                  reason: adminSummary.reason,
                  workItemId: workItem.id
                });
              }
              workItems.recordSystemEvent({
                name: "execution_mode.auto_authorized",
                body: {
                  workItemId: workItem.id,
                  tool: body.tool,
                  correlationId: body.correlationId ?? null,
                  // Mirror the JC lane: an approval-free authorization must not be
                  // reported as an acs:admin approval when no approval record backs it.
                  approvalPolicy: adminAuthorizedWithoutApproval ? "auto_policy_allowed" : "auto",
                  approvalRecord: adminAuthorizedWithoutApproval ? null : "acs:admin",
                  approvedBy: adminAuthorizedWithoutApproval ? null : ACS_ADMIN_APPROVER
                },
                attributes: { "work_item.id": workItem.id, "execution_mode.mode": "admin" }
              });
            } catch (error) {
              recordDcCapabilityAudit(workerId, request.id, body.tool, dcActor, "denied", workItem.id);
              return reply.code(403).send({
                decision: "deny",
                code: error instanceof ControlStackError ? error.code : "admin_authorization_failed",
                reason: "acs admin auto-authorization failed closed",
                workItemId: workItem.id
              });
            }
          }
        }

        if (
          !adminAuthorizedWithoutApproval &&
          (workItem.status !== "approved" || (dcPolicy.requiresApproval && required.length === 0))
        ) {
          recordDcCapabilityAudit(workerId, request.id, body.tool, dcActor, "denied", workItem.id);
          return reply.code(409).send({
            decision: "require_approval",
            workItemId: workItem.id,
            actionHash,
            approvalInstructions: `POST /work-items/${workItem.id}/approve with actionHash ${actionHash}`
          });
        }

        if (dcSchedulerNeedsRuntimeReconciliation) {
          recordDcCapabilityAudit(workerId, request.id, body.tool, dcActor, "denied", workItem.id);
          return reply.code(503).send({
            error: "Desktop Commander scheduler requires fresh managed-runtime reconciliation",
            code: "scheduler_runtime_reconciliation_required",
            retryable: true,
            workItemId: workItem.id
          });
        }

        const schedulerIntent = classifyDesktopCommanderExecution({
          requestId: workItem.id,
          agentId: dcActor,
          sessionId: body.client_id,
          invocation,
          containment: dcContainment,
          priority: "normal"
        });
        workItems.recordSystemEvent({
          name: "desktop_commander.scheduler_queued",
          body: {
            workItemId: workItem.id,
            requestId: request.id,
            agentId: dcActor,
            lane: schedulerIntent.lane,
            priority: schedulerIntent.priority,
            resourceCount: schedulerIntent.resources.length
          },
          attributes: {
            "work_item.id": workItem.id,
            "scheduler.request_id": schedulerIntent.requestId,
            "scheduler.agent_id": schedulerIntent.agentId,
            "scheduler.lane": schedulerIntent.lane
          }
        });

        let schedulerAdmission: ExecutionAdmission;
        const queueAbort = new AbortController();
        const abortQueuedRequest = () => queueAbort.abort();
        request.raw.once("aborted", abortQueuedRequest);
        try {
          schedulerAdmission = await dcScheduler.enqueue(schedulerIntent, { signal: queueAbort.signal });
        } catch (error) {
          const code = error instanceof ControlStackError ? error.code : "scheduler_unavailable";
          try {
            workItems.recordSystemEvent({
              name: "desktop_commander.scheduler_denied",
              body: { workItemId: workItem.id, requestId: request.id, code },
              attributes: {
                "work_item.id": workItem.id,
                "scheduler.request_id": schedulerIntent.requestId,
                "scheduler.agent_id": schedulerIntent.agentId,
                "scheduler.lane": schedulerIntent.lane,
                "scheduler.deny_code": code
              }
            });
          } catch {
            // Scheduling remains denied even if secondary observability is unavailable.
          }
          recordDcCapabilityAudit(workerId, request.id, body.tool, dcActor, "denied", workItem.id);
          const retryAfterMs = error instanceof ExecutionSchedulerError ? error.retryAfterMs : undefined;
          if (retryAfterMs) {
            reply.header("retry-after", String(Math.max(1, Math.ceil(retryAfterMs / 1_000))));
          }
          return reply.code(503).send({
            error: "Desktop Commander execution scheduler did not admit the request",
            code,
            retryable: error instanceof ExecutionSchedulerError ? error.retryable : true,
            ...(retryAfterMs ? { retryAfterMs } : {}),
            workItemId: workItem.id
          });
        } finally {
          request.raw.off("aborted", abortQueuedRequest);
        }

        let keepSchedulerAdmission = false;
        try {
          const modeAfterAdmission = readExecutionModeValue(workItems.getExecutionMode().raw);
          if (modeAfterAdmission.state !== "ok" || modeAfterAdmission.mode !== mode.mode) {
            return reply.code(409).send({
              decision: "deny",
              code: "execution_mode_changed",
              reason: "execution mode changed while waiting for scheduler admission",
              workItemId: workItem.id
            });
          }
          if (modeAfterAdmission.mode === "admin") {
            const gateAfterAdmission = adminExecutionGate(readAuthority(), true);
            if (!gateAfterAdmission.ok) {
              return reply.code(403).send({
                decision: "deny",
                code: gateAfterAdmission.code,
                reason: gateAfterAdmission.detail,
                workItemId: workItem.id
              });
            }
          }

          const admissionPermit = await acquireExecutionPermit({
            request,
            reply,
            lane: "dc",
            executorId: DC_BRIDGE_WORKER_ID,
            actorId: `${dcActor}:${body.client_id}`,
            toolName: body.tool
          });
          const dcRecheck = recheckMcpCaller(request);
          if (!dcRecheck.ok) {
            admissionPermit.release();
            recordDcCapabilityAudit(workerId, request.id, body.tool, dcActor, "denied", workItem.id);
            return reply.code(403).send({
              decision: "deny",
              reason: "mcp_client_unlabelled",
              code: "mcp_client_unlabelled",
              detail: dcRecheck.detail
            });
          }
          let admissionBound = false;
          // DC capability issuance is direct-addressed: the calling bridge IS the
          // provider. Same reasoning as the JC lane - persist the routing decision
          // so the authoritative-routing gate is satisfied by real evidence.
          recordDirectLaneRoutingDecision(workItems, {
            workItemId: workItem.id,
            workerId,
            lane: "dc",
            toolName: body.tool
          });

          try {
            const claimed = claimWithAdmissionPermit({
              id: workItem.id,
              workerId,
              leaseMs: DC_BRIDGE_LEASE_MS,
              lane: "dc",
              toolName: body.tool,
              permit: admissionPermit,
              ...(body.changeSetPermitId
                ? {
                    validateAuthority: () => {
                      changeSetPermitWorkItem(
                        body.changeSetPermitId!,
                        "desktop_commander",
                        dcActor,
                        body.tool,
                        invocationHash,
                        bindingHash
                      );
                    }
                  }
                : {})
            });
            admissionBound =
              !!claimed?.attemptId && claimed.fencingEpoch !== undefined && !!claimed.planHash && !!claimed.inputHash;
            if (!claimed?.attemptId || claimed.fencingEpoch === undefined || !claimed.planHash || !claimed.inputHash) {
              recordDcCapabilityAudit(workerId, request.id, body.tool, dcActor, "denied", workItem.id);
              return reply.code(409).send({
                decision: "require_approval",
                workItemId: workItem.id,
                actionHash,
                approvalInstructions: `POST /work-items/${workItem.id}/approve with actionHash ${actionHash}`
              });
            }

            const trustedWorkItem = workItems.get(workItem.id);
            const lease = trustedWorkItem ? workItems.getActiveLeaseForAttempt(claimed.attemptId) : undefined;
            if (!trustedWorkItem || !lease) {
              recordDcCapabilityAudit(workerId, request.id, body.tool, dcActor, "denied", workItem.id);
              return reply
                .code(503)
                .send({ error: "canonical execution authority unavailable", code: "execution_authority_unavailable" });
            }

            let authorization: ExecutionAuthorization;
            try {
              authorization = authorizeDesktopCommanderExecution({
                claimed,
                trustedWorkItem,
                lease,
                workerId,
                containment: dcContainment,
                requestId: request.id,
                invocation
              });
            } catch (error) {
              const code = error instanceof ControlStackError ? error.code : "authorization_failed";
              try {
                recordLeaseAuthorizedExecutionEvent(
                  {
                    workItemId: claimed.id,
                    attemptId: claimed.attemptId,
                    leaseId: claimed.leaseId,
                    workerId,
                    fencingEpoch: claimed.fencingEpoch
                  },
                  authorizationDeniedEvent({
                    workItemId: workItem.id,
                    workerId,
                    requestId: request.id,
                    toolName: body.tool,
                    attemptId: claimed.attemptId,
                    leaseId: claimed.leaseId,
                    fencingEpoch: claimed.fencingEpoch,
                    code,
                    reason: error instanceof Error ? error.message : String(error)
                  })
                );
              } catch {
                // Lease authority may already have lapsed.
              }
              recordDcCapabilityAudit(workerId, request.id, body.tool, dcActor, "denied", workItem.id);
              return reply
                .code(403)
                .send({ decision: "deny", reason: "authorization_failed", code, workItemId: workItem.id });
            }

            let approvalActionHash: string | undefined;
            if (dcPolicy.requiresApproval) {
              const approval = lease.approvalId ? workItems.getExecutionPlanApprovalById(lease.approvalId) : undefined;
              if (!approval) {
                recordLeaseAuthorizedExecutionEvent(
                  authorization,
                  capabilityDeniedEvent({
                    auth: authorization,
                    runtimeId: capabilitySigningConfig.runtimeId,
                    code: "desktop_commander_approval_rejected"
                  })
                );
                recordDcCapabilityAudit(workerId, request.id, body.tool, dcActor, "denied", workItem.id);
                return reply.code(403).send({
                  decision: "deny",
                  reason: "issuance_rejected",
                  code: "approval_binding_missing",
                  workItemId: workItem.id
                });
              }
              approvalActionHash = approval.actionHash;
            }
            if (approvalActionHash !== undefined) {
              authorization = { ...authorization, approvalActionHash } as ExecutionAuthorization;
            }

            recordLeaseAuthorizedExecutionEvent(authorization, {
              name: "desktop_commander.scheduler_admitted",
              body: {
                workItemId: workItem.id,
                requestId: request.id,
                admissionId: schedulerAdmission.admissionId,
                lane: schedulerIntent.lane,
                waitMs: schedulerAdmission.waitMs,
                resources: schedulerIntent.resources
              },
              attributes: {
                "scheduler.request_id": schedulerIntent.requestId,
                "scheduler.admission_id": schedulerAdmission.admissionId,
                "scheduler.agent_id": schedulerIntent.agentId,
                "scheduler.lane": schedulerIntent.lane,
                "scheduler.wait_ms": schedulerAdmission.waitMs
              }
            });
            if (!dcScheduler.armExecutionTimeout(workItem.id)) {
              return reply.code(503).send({
                error: "scheduler admission disappeared before capability issuance",
                code: "scheduler_admission_lost",
                workItemId: workItem.id
              });
            }

            const payloadActionHash = approvalActionHash ?? claimed.actionHash;
            const requestHash = executionPlanApprovalRequestHash({
              workItemId: workItem.id,
              planHash: claimed.planHash,
              actionHash: payloadActionHash
            });
            const payload = prepareDesktopCommanderCapability(authorization, requestHash, capabilitySigningConfig);
            const capabilityId = desktopCommanderCapabilityId(payload);

            try {
              const recorded = capabilityIssuanceRegistry.recordIssuance({
                runtimeId: payload.runtimeId,
                identityConfigFingerprint: capabilitySigningConfig.identityConfigFingerprint,
                leaseId: payload.leaseId,
                attemptId: payload.attemptId,
                workItemId: payload.workItemId,
                workerId,
                fencingEpoch: payload.leaseEpoch,
                planHash: payload.planHash,
                actionHash: payload.actionHash,
                invocationHash: payload.invocationHash,
                requiredScopes: payload.scopes,
                approvalRequired: dcPolicy.requiresApproval,
                approvalId: payload.approvalId,
                keyId: capabilitySigningConfig.keyId,
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
            } catch (error) {
              const code =
                error instanceof ControlStackError ? error.code : "desktop_commander_capability_issuance_rejected";
              try {
                recordLeaseAuthorizedExecutionEvent(
                  authorization,
                  capabilityDeniedEvent({ auth: authorization, runtimeId: payload.runtimeId, code })
                );
              } catch {
                // Lease authority may already have lapsed.
              }
              recordDcCapabilityAudit(workerId, request.id, body.tool, dcActor, "denied", workItem.id);
              return reply
                .code(403)
                .send({ decision: "deny", reason: "issuance_rejected", code, workItemId: workItem.id });
            }

            try {
              const issuanceEvent = capabilityIssuedEvent({
                auth: authorization,
                capabilityId,
                runtimeId: payload.runtimeId,
                keyId: capabilitySigningConfig.keyId,
                requestHash: payload.requestHash,
                expiresAt: payload.expiresAt
              });
              recordLeaseAuthorizedExecutionEvent(authorization, issuanceEvent);
            } catch (error) {
              return reply.code(503).send({
                error: "capability evidence could not be committed",
                code: "capability_evidence_unavailable",
                detail: error instanceof Error ? error.message : String(error)
              });
            }

            const capability = signPreparedDesktopCommanderCapability(payload, capabilitySigningConfig);
            recordDcCapabilityAudit(workerId, request.id, body.tool, dcActor, "issued", workItem.id);
            keepSchedulerAdmission = true;

            return {
              decision: "allow",
              capability,
              workItemId: workItem.id,
              attemptId: payload.attemptId,
              leaseId: payload.leaseId,
              leaseEpoch: payload.leaseEpoch,
              planHash: payload.planHash,
              actionHash: payload.actionHash,
              claimActionHash: claimed.actionHash,
              inputHash: claimed.inputHash,
              invocationHash: payload.invocationHash,
              workerId
            };
          } finally {
            if (!admissionBound) admissionPermit.release();
          }
        } finally {
          if (!keepSchedulerAdmission) schedulerAdmission.release("abandoned");
        }
      } catch (error) {
        if (authenticatedBridge) recordFailedChangeSetDispatch(request, error, "desktop_commander");
        return sendError(reply, error);
      }
    }
  );

  // ACS-issued Jace Commander capability issuance (acs.jc.v1, lease-bound, per call).
  //
  // Mirrors /dc/capability/issue with a separate worker identity, signing key,
  // tool table and issuance table. Canonical admin mode auto-authorizes
  // every approval-gated JC mutation through the normal approval record,
  // lease, capability and audit path, including privileged_exec. Requester
  // self-approval remains denied.
  app.post(
    "/jc/capability/issue",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      let authenticatedBridge = false;
      try {
        const workerId = requireWorkerIdentity(request, reply, auth);
        if (!workerId) {
          return;
        }
        if (workerId !== JC_BRIDGE_WORKER_ID) {
          return reply.code(403).send({
            error: "dedicated Jace Commander bridge identity is required",
            code: "jc_bridge_identity_required"
          });
        }
        authenticatedBridge = true;
        // The edge's /jc/mcp lane attests the requester as `x-jc-actor`
        // (apps/dc-mcp-gateway/managed.js); `x-dc-actor` is still accepted for
        // older callers. Both are honored only from the authenticated
        // acs-jc-bridge identity checked above; if both are sent they must agree.
        const jcActorHeader = firstHeader(request.headers["x-jc-actor"]);
        const legacyActorHeader = firstHeader(request.headers["x-dc-actor"]);
        if (jcActorHeader && legacyActorHeader && jcActorHeader !== legacyActorHeader) {
          return reply.code(400).send({ error: "conflicting actor headers", code: "jc_actor_invalid" });
        }
        const jcActor = jcActorHeader ?? legacyActorHeader;
        if (!jcActor || !/^[A-Za-z0-9._:@-]{1,128}$/u.test(jcActor)) {
          return reply.code(400).send({ error: "x-jc-actor header is required", code: "jc_actor_invalid" });
        }
        const body = dcCapabilityIssueSchema.parse(requestObject(request.body));
        const jcAdmission = admitMcpCaller("jc", request, body.client_id);
        if (!jcAdmission.ok) {
          recordJcCapabilityAudit(workerId, request.id, body.tool, jcActor, "denied");
          return reply.code(403).send({
            decision: "deny",
            reason: "mcp_client_unlabelled",
            code: "mcp_client_unlabelled",
            detail: jcAdmission.detail
          });
        }
        if (!jcSigningConfig) {
          return reply.code(503).send({
            error: "jace-commander capability issuance not configured",
            code: "capability_issuance_unconfigured"
          });
        }
        try {
          validateJaceCommanderSigningConfig(jcSigningConfig);
        } catch {
          return reply
            .code(503)
            .send({ error: "capability signing key is invalid", code: "capability_signing_key_invalid" });
        }

        let invocation: JaceCommanderInvocation;
        try {
          invocation = validateJaceCommanderInvocation(body.tool, parseDcArgsSummary(body.argsSummary));
        } catch (error) {
          recordJcCapabilityAudit(workerId, request.id, body.tool, jcActor, "denied");
          const code = error instanceof ControlStackError ? error.code : "jace_commander_argument_invalid";
          const unknownTool = code === "jace_commander_tool_not_allowlisted";
          return reply.code(unknownTool ? 403 : 400).send({
            decision: "deny",
            reason: unknownTool ? "unknown_tool" : "invalid_arguments",
            code,
            ...(error instanceof ControlStackError ? { detail: error.message.slice(0, 512) } : {})
          });
        }

        const toolPolicy = invocation.policy;
        if (toolPolicy.pathArguments.length > 0) {
          // ACS is the containment authority for filesystem tools: no roots
          // configured means no filesystem capability is ever signed.
          if (!jcContainment) {
            recordJcCapabilityAudit(workerId, request.id, invocation.toolName, jcActor, "denied");
            return reply.code(503).send({
              error: "jace-commander filesystem containment not configured",
              code: "jace_commander_containment_unconfigured"
            });
          }
          try {
            containJaceCommanderInvocation(invocation, jcContainment);
          } catch (error) {
            recordJcCapabilityAudit(workerId, request.id, invocation.toolName, jcActor, "denied");
            return reply.code(403).send({
              decision: "deny",
              reason: "path_not_allowed",
              code: error instanceof ControlStackError ? error.code : "jace_commander_path_invalid",
              ...(error instanceof ControlStackError ? { detail: error.message.slice(0, 512) } : {})
            });
          }
        }
        const bindingHash = stableHash({
          contract: "acs.jc.v1",
          tool: invocation.toolName,
          invocationHash: invocation.invocationHash,
          runtimeId: jcSigningConfig.runtimeId,
          requiredScopes: toolPolicy.scopes,
          requesterSubject: jcActor
        });

        const existing = body.changeSetPermitId
          ? changeSetPermitWorkItem(
              body.changeSetPermitId,
              "jace_commander",
              jcActor,
              invocation.toolName,
              invocation.invocationHash,
              bindingHash
            )
          : workItems
              .list()
              .filter((candidate) => {
                const params = candidate.requestedActions[0]?.params as Record<string, unknown> | undefined;
                return (
                  !params?.changeSetBinding &&
                  candidate.requesterSubject === jcActor &&
                  params?.tool === invocation.toolName &&
                  params?.bindingHash === bindingHash &&
                  ["needs_approval", "approved"].includes(candidate.status)
                );
              })
              .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];

        if (!existing && !hasPendingWorkItemCapacity(workItems, maxPendingWorkItems)) {
          return reply.code(429).send({ error: "pending work-item limit reached", code: "work_queue_full" });
        }

        let workItem =
          existing ??
          tools.create_work_item(
            createWorkItemSchema.parse({
              // Approvers see what they approve: title and intent carry the
              // bounded, redacted argument summary for approval-gated tools.
              title: jaceCommanderWorkItemTitle(invocation),
              intent: jaceCommanderWorkItemIntent(invocation, jcActor),
              requester: "agent",
              requesterSubject: jcActor,
              target: {},
              requestedActions: [
                {
                  kind: toolPolicy.actionKind,
                  description: `Jace Commander tool ${invocation.toolName}`,
                  params: {
                    tool: invocation.toolName,
                    contract: "acs.jc.v1",
                    invocationHash: invocation.invocationHash,
                    bindingHash,
                    runtimeId: jcSigningConfig.runtimeId,
                    requiredScopes: [...toolPolicy.scopes],
                    requesterSubject: jcActor,
                    approvalSummary: jaceCommanderApprovalSummary(invocation),
                    write:
                      toolPolicy.actionKind === "privileged.exec" || toolPolicy.actionKind === "jc.integration.write",
                    network: false
                  }
                }
              ],
              risk: toolPolicy.risk,
              ...(body.correlationId ? { metadata: { correlationId: body.correlationId } } : {})
            })
          );

        const evaluations = policy.evaluateWorkItem(workItem, workerId, "approve");
        const required = evaluations.filter((evaluation) => evaluation.decision.decision === "require_approval");
        const actionHash = required[0]?.actionHash ?? executionActionHash(workItem);

        if (workItem.status === "blocked" || policy.summarize(evaluations).decision === "deny") {
          recordJcCapabilityAudit(workerId, request.id, invocation.toolName, jcActor, "denied", workItem.id);
          return reply.code(403).send({
            decision: "deny",
            reason: "policy_denied",
            workItemId: workItem.id,
            detail: policy.summarize(evaluations).reason
          });
        }

        const mode = readExecutionModeValue(workItems.getExecutionMode().raw);
        if (mode.state !== "ok") {
          recordJcCapabilityAudit(workerId, request.id, invocation.toolName, jcActor, "denied", workItem.id);
          return reply.code(403).send({
            decision: "deny",
            code: mode.state === "missing" ? "execution_mode_missing" : "execution_mode_corrupt",
            reason: "canonical execution mode is not usable",
            workItemId: workItem.id
          });
        }

        // Set only in the admin-mode case where policy already allows every action and no
        // approval record exists (see the admin auto-authorization block below).
        let adminAuthorizedWithoutApproval = false;
        if (mode.mode === "admin") {
          const gate = adminExecutionGate(readAuthority(), true);
          if (!gate.ok) {
            recordJcCapabilityAudit(workerId, request.id, invocation.toolName, jcActor, "denied", workItem.id);
            workItems.recordSystemEvent({
              name: "execution_mode.auto_authorization_denied",
              body: {
                code: gate.code,
                tool: invocation.toolName,
                workItemId: workItem.id,
                correlationId: body.correlationId ?? null
              },
              attributes: { "work_item.id": workItem.id, "execution_mode.mode": "admin", "execution_mode.lane": "jc" }
            });
            return reply.code(403).send({
              decision: "deny",
              code: gate.code,
              reason: gate.detail,
              workItemId: workItem.id
            });
          }
          const currentPlan = workItems.getCurrentExecutionPlan(workItem.id);
          const hasCurrentApproval =
            required.length > 0 &&
            currentPlan !== undefined &&
            required.every(
              (evaluation) =>
                workItems.hasApproval(workItem.id, evaluation.actionHash) &&
                workItems.hasExecutionPlanApproval(workItem.id, currentPlan.planHash, evaluation.actionHash)
            );
          // `required.length === 0` means policy asked for no approval record, so an
          // "approved" status carries no approval authority and there is nothing for
          // hasCurrentApproval to confirm. That case still has to run the admin
          // evaluation below, otherwise admin mode silently falls through to the
          // require_approval gate for an action policy already allows.
          const needsAdminAuthorization =
            workItem.status !== "approved" || !hasCurrentApproval || required.length === 0;
          if (needsAdminAuthorization) {
            try {
              const adminEvaluations = policy.evaluateWorkItem(workItem, ACS_ADMIN_APPROVER, "approve");
              const adminSummary = policy.summarize(adminEvaluations);
              if (adminSummary.decision === "deny") {
                recordJcCapabilityAudit(workerId, request.id, invocation.toolName, jcActor, "denied", workItem.id);
                return reply.code(403).send({
                  decision: "deny",
                  code: "admin_authorization_failed",
                  reason: adminSummary.reason,
                  workItemId: workItem.id
                });
              }
              const adminRequired = adminEvaluations.filter(
                (evaluation) => evaluation.decision.decision === "require_approval"
              );
              const adminActionHash = adminRequired[0]?.actionHash;
              if (adminSummary.decision === "allow") {
                // Policy already authorizes every action for the admin approver, so there is
                // no approval record to create: there is no actionHash to approve and nothing
                // to approve. Treating that absence as a failure would deny with the allow reason.
                //
                // See the JC lane: admin authorization lets the ORDINARY admission path
                // continue - approved status, normal execution-plan admission with
                // requiresApproval=false, normal lease + fencing + ownership - with no
                // approval record fabricated and no parallel admin-only authority model.
                adminAuthorizedWithoutApproval = true;
                // Record the authorizing evaluation itself, so the audit chain carries
                // the action hash and matched policy rules rather than only a mode event.
                for (const evaluation of adminEvaluations) {
                  workItems.recordPolicyDecision({
                    workItemId: workItem.id,
                    actionHash: evaluation.actionHash,
                    context: policyContextAuditReceipt(evaluation.context),
                    ...evaluation.decision
                  });
                }
                if (workItem.status !== "approved") {
                  workItem = workItems.approveWorkItem(workItem.id, { via: "policy_gate" });
                }
              } else if (adminActionHash) {
                const approved = tools.approve_work_item({
                  id: workItem.id,
                  actionHash: adminActionHash,
                  approvedBy: ACS_ADMIN_APPROVER,
                  reason: ACS_ADMIN_APPROVAL_REASON
                });
                if (approved.decision.decision === "deny" || approved.workItem.status !== "approved") {
                  recordJcCapabilityAudit(workerId, request.id, invocation.toolName, jcActor, "denied", workItem.id);
                  return reply.code(403).send({
                    decision: "deny",
                    code: "admin_authorization_failed",
                    reason: approved.decision.reason,
                    workItemId: workItem.id
                  });
                }
                workItem = approved.workItem;
              } else {
                // require_approval with no approval record to satisfy: fail closed.
                recordJcCapabilityAudit(workerId, request.id, invocation.toolName, jcActor, "denied", workItem.id);
                return reply.code(403).send({
                  decision: "deny",
                  code: "admin_authorization_failed",
                  reason: adminSummary.reason,
                  workItemId: workItem.id
                });
              }
            } catch (error) {
              recordJcCapabilityAudit(workerId, request.id, invocation.toolName, jcActor, "denied", workItem.id);
              return reply.code(403).send({
                decision: "deny",
                code: error instanceof ControlStackError ? error.code : "admin_authorization_failed",
                reason: "acs admin auto-authorization failed closed",
                workItemId: workItem.id
              });
            }
          }
          // Both admin-authorized outcomes must leave mode attribution in the audit chain:
          // one backed by an approval record, and one where policy already allowed the
          // action so no approval record was needed. Gating this solely on an approval
          // record existing would leave the approval-free case unattributed.
          if (adminAuthorizedWithoutApproval || workItems.hasGrantedApprovalBy(workItem.id, ACS_ADMIN_APPROVER)) {
            try {
              workItems.recordSystemEventOnceForWorkItem({
                name: "execution_mode.auto_authorized",
                workItemId: workItem.id,
                body: {
                  workItemId: workItem.id,
                  tool: invocation.toolName,
                  correlationId: body.correlationId ?? null,
                  approvalPolicy: adminAuthorizedWithoutApproval ? "auto_policy_allowed" : "auto",
                  // An approval-free authorization must not be reported as an approval by
                  // acs:admin when no approval record backs it.
                  approvalRecord: adminAuthorizedWithoutApproval ? null : "acs:admin",
                  approvedBy: adminAuthorizedWithoutApproval ? null : ACS_ADMIN_APPROVER,
                  lane: "jc"
                },
                attributes: { "execution_mode.mode": "admin", "execution_mode.lane": "jc" }
              });
            } catch (error) {
              recordJcCapabilityAudit(workerId, request.id, invocation.toolName, jcActor, "denied", workItem.id);
              return reply.code(403).send({
                decision: "deny",
                code: error instanceof ControlStackError ? error.code : "admin_authorization_failed",
                reason: "acs admin auto-authorization failed closed",
                workItemId: workItem.id
              });
            }
          }
        }
        if (
          !adminAuthorizedWithoutApproval &&
          (workItem.status !== "approved" || (toolPolicy.requiresApproval && required.length === 0))
        ) {
          recordJcCapabilityAudit(workerId, request.id, invocation.toolName, jcActor, "denied", workItem.id);
          return reply.code(409).send({
            decision: "require_approval",
            workItemId: workItem.id,
            actionHash,
            approvalSummary: jaceCommanderApprovalSummary(invocation),
            approvalInstructions: `A human must POST /work-items/${workItem.id}/approve with actionHash ${actionHash}, then retry the identical call`
          });
        }

        const admissionPermit = await acquireExecutionPermit({
          request,
          reply,
          lane: "jc",
          executorId: JC_BRIDGE_WORKER_ID,
          actorId: `${jcActor}:${body.client_id}`,
          toolName: invocation.toolName
        });
        const jcRecheck = recheckMcpCaller(request);
        if (!jcRecheck.ok) {
          admissionPermit.release();
          recordJcCapabilityAudit(workerId, request.id, invocation.toolName, jcActor, "denied", workItem.id);
          return reply.code(403).send({
            decision: "deny",
            reason: "mcp_client_unlabelled",
            code: "mcp_client_unlabelled",
            detail: jcRecheck.detail
          });
        }
        // JC capability issuance is direct-addressed: the calling bridge IS the
        // provider, so the executor is authoritatively known here. Record that
        // decision so the authoritative-routing gate (enabled with
        // ACS_NIMBLE_ROUTING_ENABLED=1) is satisfied by persisted, worker-matching
        // evidence rather than rejecting every direct-lane claim. No model is
        // consulted and no gate is bypassed.
        recordDirectLaneRoutingDecision(workItems, {
          workItemId: workItem.id,
          workerId,
          lane: "jc",
          toolName: invocation.toolName
        });
        let admissionBound = false;
        try {
          const adminApprovalWouldBeConsumed =
            workItems.hasGrantedApprovalBy(workItem.id, ACS_ADMIN_APPROVER) ||
            workItems.hasGrantedExecutionPlanApprovalBy(workItem.id, ACS_ADMIN_APPROVER);
          const validateAuthority = () => {
            if (body.changeSetPermitId) {
              changeSetPermitWorkItem(
                body.changeSetPermitId,
                "jace_commander",
                jcActor,
                invocation.toolName,
                invocation.invocationHash,
                bindingHash
              );
            }
            // Re-validate for ANY admin-authorized claim, not only approval-backed
            // ones. The approval-free admin branch fabricates no approval record, so
            // adminApprovalWouldBeConsumed is false exactly there; returning early on
            // that condition would skip the check this callback exists to perform.
            if (!adminApprovalWouldBeConsumed && !adminAuthorizedWithoutApproval) return;
            const mode = readExecutionModeValue(workItems.getExecutionMode().raw);
            if (mode.state !== "ok" || mode.mode !== "admin") {
              workItems.recordSystemEvent({
                name: "execution_mode.admin_approval_claim_denied",
                body: { workItemId: workItem.id, code: "execution_mode_fence_mismatch" },
                attributes: { "work_item.id": workItem.id }
              });
              throw new ControlStackError(
                "execution_mode_fence_mismatch",
                "ACS admin approval requires canonical admin mode"
              );
            }
            const gate = adminExecutionGate(readAuthority(), true);
            if (!gate.ok) {
              workItems.recordSystemEvent({
                name: "execution_mode.admin_approval_claim_denied",
                body: { workItemId: workItem.id, code: gate.code },
                attributes: { "work_item.id": workItem.id, "execution_mode.mode": "admin" }
              });
              throw new ControlStackError(gate.code, gate.detail);
            }
          };
          const claimed = claimWithAdmissionPermit({
            id: workItem.id,
            workerId,
            leaseMs: JC_BRIDGE_LEASE_MS,
            lane: "jc",
            toolName: invocation.toolName,
            permit: admissionPermit,
            // The approval-free admin branch fabricates no approval record, so
            // adminApprovalWouldBeConsumed is false for exactly that case. Fence and
            // re-validate the mode/authority at claim time for it too, otherwise a flip
            // to strict (or ambiguous authority) during the permit window would be
            // caught for approval-backed calls but missed for approval-free ones.
            ...(body.changeSetPermitId || adminApprovalWouldBeConsumed || adminAuthorizedWithoutApproval
              ? { validateAuthority }
              : {}),
            ...(adminApprovalWouldBeConsumed || adminAuthorizedWithoutApproval
              ? { executionModeFence: "admin" as const }
              : {})
          });
          admissionBound =
            !!claimed?.attemptId && claimed.fencingEpoch !== undefined && !!claimed.planHash && !!claimed.inputHash;
          if (!claimed?.attemptId || claimed.fencingEpoch === undefined || !claimed.planHash || !claimed.inputHash) {
            recordJcCapabilityAudit(workerId, request.id, invocation.toolName, jcActor, "denied", workItem.id);
            return reply.code(409).send({
              decision: "require_approval",
              workItemId: workItem.id,
              actionHash,
              approvalSummary: jaceCommanderApprovalSummary(invocation),
              approvalInstructions: `A human must POST /work-items/${workItem.id}/approve with actionHash ${actionHash}, then retry the identical call`
            });
          }
          workItem = workItems.get(workItem.id) ?? workItem;
          const lease = workItems.getActiveLeaseForAttempt(claimed.attemptId);
          if (!lease) {
            recordJcCapabilityAudit(workerId, request.id, invocation.toolName, jcActor, "denied", workItem.id);
            return reply
              .code(503)
              .send({ error: "canonical execution authority unavailable", code: "execution_authority_unavailable" });
          }

          const authority = {
            workItemId: claimed.id,
            attemptId: claimed.attemptId,
            leaseId: claimed.leaseId,
            workerId,
            fencingEpoch: claimed.fencingEpoch
          };
          const deny = (code: string, status = 403) => {
            try {
              recordLeaseAuthorizedExecutionEvent(authority, {
                name: "jace_commander.capability_denied",
                body: { tool: invocation.toolName, code, requestId: request.id },
                attributes: {
                  "jace_commander.tool": invocation.toolName,
                  "jace_commander.invocation_hash": invocation.invocationHash,
                  "jace_commander.denial_code": code
                }
              });
            } catch {
              // Lease authority may already have lapsed.
            }
            recordJcCapabilityAudit(workerId, request.id, invocation.toolName, jcActor, "denied", workItem.id);
            return reply
              .code(status)
              .send({ decision: "deny", reason: "issuance_rejected", code, workItemId: workItem.id });
          };

          let authorization: JaceCommanderExecutionAuthorization;
          try {
            authorization = authorizeJaceCommanderExecution({
              claimed,
              trustedWorkItem: workItem,
              lease,
              workerId,
              invocation
            });
          } catch (error) {
            return deny(error instanceof ControlStackError ? error.code : "authorization_failed");
          }
          if (toolPolicy.requiresApproval) {
            const approval = lease.approvalId ? workItems.getExecutionPlanApprovalById(lease.approvalId) : undefined;
            if (!approval) return deny("approval_binding_missing");
            authorization = {
              ...authorization,
              approvalActionHash: approval.actionHash
            } as JaceCommanderExecutionAuthorization;
          }

          const payload = prepareJaceCommanderCapability(authorization, jcSigningConfig);
          const capabilityId = jaceCommanderCapabilityId(payload);
          try {
            const recorded = jcIssuanceRegistry.recordIssuance({
              runtimeId: payload.runtimeId,
              toolName: payload.toolName,
              leaseId: payload.leaseId,
              attemptId: payload.attemptId,
              workItemId: payload.workItemId,
              workerId,
              fencingEpoch: payload.leaseEpoch,
              planHash: payload.planHash,
              actionHash: payload.actionHash,
              invocationHash: payload.invocationHash,
              approvalId: payload.approvalId,
              requesterSubject: jcActor,
              keyId: jcSigningConfig.keyId,
              nonce: payload.nonce,
              issuedAt: payload.issuedAt,
              expiresAt: payload.expiresAt
            });
            if (recorded.requestHash !== payload.requestHash || recorded.approvalId !== payload.approvalId) {
              throw new ControlStackError(
                "jace_commander_capability_issuance_rejected",
                "issuance binding does not match capability payload"
              );
            }
          } catch (error) {
            return deny(
              error instanceof ControlStackError ? error.code : "jace_commander_capability_issuance_rejected"
            );
          }

          try {
            recordLeaseAuthorizedExecutionEvent(authority, {
              name: "jace_commander.capability_issued",
              body: {
                capabilityId,
                tool: payload.toolName,
                runtimeId: payload.runtimeId,
                keyId: jcSigningConfig.keyId,
                requestHash: payload.requestHash,
                expiresAt: payload.expiresAt,
                ...(payload.approvalId ? { approvalId: payload.approvalId } : {})
              },
              attributes: {
                "capability.id": capabilityId,
                "jace_commander.tool": payload.toolName,
                "jace_commander.invocation_hash": payload.invocationHash,
                "jace_commander.runtime_id": payload.runtimeId,
                "execution.request_hash": payload.requestHash,
                ...(payload.approvalId ? { "approval.id": payload.approvalId } : {})
              }
            });
          } catch (error) {
            return reply.code(503).send({
              error: "capability evidence could not be committed",
              code: "capability_evidence_unavailable",
              detail: error instanceof Error ? error.message : String(error)
            });
          }

          const capability = signPreparedJaceCommanderCapability(payload, jcSigningConfig);
          recordJcCapabilityAudit(workerId, request.id, invocation.toolName, jcActor, "issued", workItem.id);

          return {
            decision: "allow",
            capability,
            workItemId: workItem.id,
            attemptId: payload.attemptId,
            leaseId: payload.leaseId,
            leaseEpoch: payload.leaseEpoch,
            planHash: payload.planHash,
            actionHash: payload.actionHash,
            claimActionHash: claimed.actionHash,
            inputHash: claimed.inputHash,
            invocationHash: payload.invocationHash,
            workerId
          };
        } finally {
          if (!admissionBound) admissionPermit.release();
        }
      } catch (error) {
        if (authenticatedBridge) recordFailedChangeSetDispatch(request, error, "jace_commander");
        return sendError(reply, error);
      }
    }
  );

  // Managed-runtime bootstrap: only the dedicated bridge can issue or
  // complete a challenge. Completion must include the exact identity metadata
  // echoed by the managed Desktop Commander child during MCP initialize.
  app.post(
    "/dc/runtime/bootstrap",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      try {
        const workerId = requireWorkerIdentity(request, reply, auth);
        if (!workerId) {
          return;
        }
        if (workerId !== DC_BRIDGE_WORKER_ID) {
          return reply.code(403).send({
            error: "dedicated Desktop Commander bridge identity is required",
            code: "dc_bridge_identity_required"
          });
        }
        const body = dcRuntimeBootstrapSchema.parse(requestObject(request.body));
        const challenge = capabilityIssuanceRegistry.issueBootstrap(
          {
            runtimeId: body.runtimeId,
            identityConfigFingerprint: body.identityConfigFingerprint,
            scopes: [...body.scopes]
          },
          new Date()
        );
        return reply.code(201).send({
          runtimeId: challenge.runtimeId,
          challenge: challenge.challenge,
          scopes: challenge.scopes,
          expiresAt: challenge.expiresAt
        });
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.post(
    "/dc/runtime/bootstrap/complete",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      try {
        const workerId = requireWorkerIdentity(request, reply, auth);
        if (!workerId) {
          return;
        }
        if (workerId !== DC_BRIDGE_WORKER_ID) {
          return reply.code(403).send({
            error: "dedicated Desktop Commander bridge identity is required",
            code: "dc_bridge_identity_required"
          });
        }
        const body = dcRuntimeBootstrapCompleteSchema.parse(requestObject(request.body));
        const proof = body.runtimeIdentity;
        const proofMatches =
          proof.runtimeId === body.runtimeId &&
          proof.challenge === body.challenge &&
          proof.scopes.length === body.scopes.length &&
          proof.scopes.every((scope, index) => scope === body.scopes[index]);
        if (!proofMatches) {
          return reply.code(403).send({
            error: "managed runtime identity proof does not match the ACS challenge",
            code: "desktop_commander_runtime_attestation_rejected"
          });
        }
        capabilityIssuanceRegistry.completeBootstrap(
          {
            runtimeId: body.runtimeId,
            identityConfigFingerprint: body.identityConfigFingerprint,
            scopes: [...body.scopes],
            challenge: proof.challenge
          },
          new Date()
        );
        if (
          capabilitySigningConfig &&
          body.runtimeId === capabilitySigningConfig.runtimeId &&
          body.identityConfigFingerprint === capabilitySigningConfig.identityConfigFingerprint
        ) {
          dcSchedulerRuntimeReattestedSinceStart = true;
          maybeCompleteDcSchedulerReconciliation("runtime_attested");
        }
        workItems.recordSystemEvent({
          name: "desktop_commander.runtime_activated",
          body: {
            runtimeId: body.runtimeId,
            identityConfigFingerprint: body.identityConfigFingerprint,
            scopes: [...body.scopes],
            workerId
          },
          attributes: {
            "desktop_commander.runtime_id": body.runtimeId,
            "desktop_commander.worker_id": workerId
          }
        });
        return reply.code(204).send();
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.post<{ Params: { id: string } }>("/work-items/:id/approve", async (request, reply) => {
    try {
      const actor = requireMutationActor(request, reply, auth, "acs:approve");
      if (!actor) {
        return;
      }
      const bodyObject = requestObject(request.body);
      requireApprovalActionHash(bodyObject);
      const body = approvalBodySchema.parse(bodyObject);
      const workItem = tools.get_work_item({ id: request.params.id });
      if (!workItem) {
        return reply.code(404).send({ error: "work item not found" });
      }
      const toolParams = workItem.requestedActions[0]?.params;
      const dcTool = typeof toolParams?.tool === "string" ? toolParams.tool : undefined;
      // Jace Commander (acs.jc.v1) items carry their contract; every tool the
      // JC manifest marks requiresApproval is covered, not only the tools that
      // also happen to have a Desktop Commander policy.
      const approvalGatedTool =
        dcTool !== undefined &&
        (toolParams?.contract === "acs.jc.v1"
          ? jaceCommanderToolPolicy(dcTool)?.requiresApproval === true
          : desktopCommanderToolPolicy(dcTool)?.requiresApproval === true);
      if (workItem.requesterSubject === actor && approvalGatedTool) {
        return reply.code(403).send({
          error:
            toolParams?.contract === "acs.jc.v1"
              ? "requester cannot approve its own Jace Commander operation"
              : "requester cannot approve its own Desktop Commander operation",
          code: "approval_self_denied"
        });
      }
      const result = tools.approve_work_item({ ...body, id: request.params.id, approvedBy: actor });
      return reply.code(result.decision.decision === "deny" ? 403 : 200).send(result);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/work-items/:id/cancel", async (request, reply) => {
    try {
      const actor = requireMutationActor(request, reply, auth);
      if (!actor) {
        return;
      }
      const body = cancelBodySchema.parse(requestObject(request.body));
      const schedulerState = dcScheduler.cancel(request.params.id);
      if (schedulerState !== "missing") {
        try {
          workItems.recordSystemEvent({
            name: "desktop_commander.scheduler_cancel_requested",
            body: { workItemId: request.params.id, schedulerState },
            attributes: {
              "work_item.id": request.params.id,
              "scheduler.cancel_state": schedulerState
            }
          });
        } catch (error) {
          request.log.warn({ error, workItemId: request.params.id }, "scheduler cancel audit failed");
        }
      }
      if (schedulerState === "active") {
        return reply.code(409).send({
          error: "active Desktop Commander execution requires executor stop confirmation before cancellation",
          code: "scheduler_active_cancellation_unconfirmed",
          workItemId: request.params.id
        });
      }
      const cancelled = tools.cancel_work_item({ ...body, id: request.params.id, actor });
      return { workItem: cancelled };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/work-items/:id/reject", async (request, reply) => {
    try {
      const actor = requireMutationActor(request, reply, auth);
      if (!actor) {
        return;
      }
      const body = cancelBodySchema.parse(requestObject(request.body));
      const rejected = tools.reject_work_item({ ...body, id: request.params.id, actor });
      return { workItem: rejected };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/work-items/:id/unblock", async (request, reply) => {
    try {
      const actor = requireMutationActor(request, reply, auth);
      if (!actor) {
        return;
      }
      unblockBodySchema.parse(requestObject(request.body));
      const result = tools.unblock_work_item({ actor, id: request.params.id });
      return reply.code(result.decision.decision === "deny" ? 403 : 200).send(result);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>(
    "/work-items/:id/change-set-review",
    { preHandler: requireRead },
    async (request, reply) => {
      try {
        const child = workItems.get(request.params.id);
        const binding = z
          .object({ missionId: z.string(), manifestHash: z.string(), operationId: z.string() })
          .passthrough()
          .parse(child?.requestedActions[0]?.params.changeSetBinding);
        const progress = workItems.getChangeSetProgress(binding.missionId, binding.manifestHash);
        const operation = progress.operations.find((entry) => entry.executionWorkItemId === request.params.id);
        if (!operation || !operation.attemptId || !operation.resultId)
          throw new ControlStackError("change_set_review_result_missing", "no durably observed result to review");
        return {
          operation,
          evidence: operation.evidenceManifestHash
            ? workItems.getEvidenceManifest(operation.evidenceManifestHash)
            : undefined,
          requirement: workItems.getVerificationRequirement(operation.attemptId),
          result: workItems.getExecutionResult(operation.resultId),
          reviews: workItems.listReviewFindings(operation.attemptId),
          decision: workItems.getVerificationDecision(operation.attemptId)
        };
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.post<{ Params: { id: string } }>("/work-items/:id/change-set-review", async (request, reply) => {
    try {
      const credential = auth ? gatewayCredentialForRequest(request, auth) : undefined;
      if (!credential) return reply.code(401).send({ code: "unauthorized", error: "authenticated reviewer required" });
      if (
        !credential.scopes.includes("acs:review") ||
        credential.roles.includes("worker") ||
        (!credential.roles.includes("service") && !credential.roles.includes("operator"))
      )
        return reply
          .code(403)
          .send({ code: "independent_reviewer_required", error: "dedicated reviewer authority required" });
      return workItems.reviewChangeSetOperation(request.params.id, changeSetReviewBodySchema.parse(request.body), {
        via: "policy_gate",
        actorId: credential.actorId
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/worker/claim", async (request, reply) => {
    try {
      const workerId = requireWorkerIdentity(request, reply, auth);
      if (!workerId) return;
      const body = z
        .object({ leaseMs: z.number().int().positive().max(3_600_000).optional() })
        .strict()
        .parse(requestObject(request.body));
      let claimed;
      if (nimbleRouting.enabled) {
        const routed = await claimNextAuthoritativeWorkItem({
          store: workItems,
          policy,
          workerId,
          config: nimbleRouting,
          ...body
        });
        claimed = routed.claimed ? routed.running : undefined;
      } else {
        claimed = tools.claim_next_approved_work_item({ workerId, ...body });
      }
      if (claimed && claimed.status !== "running") {
        return reply
          .code(409)
          .send({ error: "claim was rejected by policy or approval binding", code: "worker_claim_blocked" });
      }
      return claimed ? { claimed: true, workItem: claimed } : { claimed: false };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>(
    "/work-items/:id/results",
    { bodyLimit: MAX_RESULT_BODY_BYTES },
    async (request, reply) => {
      reply.header("x-request-id", request.id);
      try {
        const workerId = requireWorkerIdentity(request, reply, auth);
        if (!workerId) {
          return;
        }
        const body = submitWorkResultSchema.parse(request.body);
        if (body.workItemId !== request.params.id) {
          return reply.code(400).send({ error: "result work item id does not match route id", code: "result_invalid" });
        }
        if (body.workerId !== workerId) {
          return reply
            .code(403)
            .send({ error: "worker identity is not authorized for this result", code: "forbidden" });
        }
        if (body.outcome === "blocked" || body.outcome === "lease_expired") {
          return reply.code(403).send({ error: "ACS-derived outcomes are not worker-submittable", code: "forbidden" });
        }
        const admissionBinding = body.attemptId ? admissionPermits.get(body.attemptId) : undefined;
        const releasesAdmission = Boolean(
          admissionBinding &&
          admissionBinding.workItemId === body.workItemId &&
          admissionBinding.leaseId === body.leaseId &&
          admissionBinding.workerId === body.workerId &&
          admissionBinding.fencingEpoch === body.fencingEpoch &&
          admissionBinding.actionHash === body.actionHash &&
          admissionBinding.planHash === body.planHash &&
          admissionBinding.inputHash === body.inputHash
        );
        try {
          const replay = workItems.getExecutionResultForIdempotency(body.idempotencyKey);
          const workItem = workItems.withTransaction(() => {
            const accepted = workItems.submitWorkResult(body);
            if (!replay)
              verifyChangeSetResult(
                workItems,
                body,
                body.simulationMetadata.executionMode === "jace_commander" ? jcContainment : dcContainment
              );
            return accepted;
          });
          const resultId = typeof workItem.result?.resultId === "string" ? workItem.result.resultId : undefined;
          const result = resultId ? workItems.getExecutionResult(resultId) : undefined;
          if (!result) {
            throw new ControlStackError("result_persistence_failed", "accepted result could not be read back");
          }
          const schedulerReleased = dcScheduler.releaseRequest(
            body.workItemId,
            body.outcome === "succeeded" ? "completed" : "failed"
          );
          if (schedulerReleased) {
            try {
              workItems.recordSystemEvent({
                name: "desktop_commander.scheduler_released",
                body: {
                  workItemId: body.workItemId,
                  attemptId: body.attemptId,
                  outcome: body.outcome
                },
                attributes: {
                  "work_item.id": body.workItemId,
                  ...(body.attemptId === undefined ? {} : { "attempt.id": body.attemptId }),
                  "scheduler.release_reason": "terminal_result"
                }
              });
            } catch (error) {
              request.log.warn({ error, workItemId: body.workItemId }, "scheduler release audit failed");
            }
          }
          if (dcSchedulerNeedsRuntimeReconciliation && dcSchedulerRuntimeReattestedSinceStart) {
            try {
              maybeCompleteDcSchedulerReconciliation("terminal_result");
            } catch (error) {
              request.log.warn({ error, workItemId: body.workItemId }, "scheduler reconciliation audit failed");
            }
          }
          request.log.info(
            { requestId: request.id, workItemId: body.workItemId, workerId: body.workerId, resultId: result.resultId },
            "worker result accepted"
          );
          return reply.code(replay ? 200 : 201).send({ result, workItem });
        } finally {
          if (releasesAdmission && body.attemptId) releaseAdmissionPermit(body.attemptId);
        }
      } catch (error) {
        request.log.warn(
          {
            requestId: request.id,
            workItemId: request.params.id,
            code:
              error instanceof ControlStackError
                ? error.code
                : error instanceof ZodError
                  ? "invalid_request"
                  : "internal_error"
          },
          "worker result rejected"
        );
        return sendError(reply, error);
      }
    }
  );

  app.post<{ Params: { id: string } }>("/work-items/:id/retry", async (request, reply) => {
    try {
      const actor = requireMutationActor(request, reply, auth);
      if (!actor) return;
      if (!hasPendingWorkItemCapacity(workItems, maxPendingWorkItems)) {
        return reply.code(429).send({ error: "pending work-item limit reached", code: "work_queue_full" });
      }
      const body = retryBodySchema.parse(requestObject(request.body));
      const workItem = tools.retry_work_item({ ...body, id: request.params.id, actor });
      return reply.code(201).send({ workItem });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/work-items/:id/clone", async (request, reply) => {
    try {
      const actor = requireMutationActor(request, reply, auth);
      if (!actor) return;
      if (!hasPendingWorkItemCapacity(workItems, maxPendingWorkItems)) {
        return reply.code(429).send({ error: "pending work-item limit reached", code: "work_queue_full" });
      }
      const body = cloneBodySchema.parse(requestObject(request.body));
      const workItem = tools.clone_work_item({ ...body, id: request.params.id, actor });
      return reply.code(201).send({ workItem });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Read-only JSON projection of the audit event log, unscoped by work item
  // or agent (unlike the `events` fields on GET /work-items/:id and
  // GET /api/agents/:id). Reuses the exact same workItems.readEvents() +
  // eventReadOptions() pagination already used internally by the HTML
  // dashboard (GET /) and GET /agents -- this route only exposes that
  // existing read path as JSON for API consumers that need the full,
  // unscoped ledger (e.g. building an incidents/approvals view) without
  // holding open the /events SSE stream.
  app.get("/api/events", { preHandler: requireRead }, async (request, reply) => {
    try {
      return { events: workItems.readEvents(eventReadOptions(request.query)) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/events", { preHandler: requireRead }, (request, reply) => {
    // Each stream pins a socket and its buffered writes for as long as the
    // client holds it. Unbounded, an authenticated client can open sockets
    // until the process runs out of memory, so refuse past the cap rather than
    // degrade every existing subscriber.
    //
    // The process-wide ceiling alone is not enough: one principal holding every
    // slot locks every other credential out of the live audit channel, which is
    // a denial of service against exactly the people who need to watch during
    // an incident. The per-principal limit is what keeps the channel fair; the
    // global one is the safety ceiling.
    const principal = ssePrincipalKey(request, auth);
    const principalStreams = sseClientsPerPrincipal.get(principal) ?? 0;
    if (sseClients.size >= maxSseClients || principalStreams >= maxSseClientsPerPrincipal) {
      const reason = principalStreams >= maxSseClientsPerPrincipal ? "per_principal" : "global";
      metrics.increment("acs_sse_connections_rejected_total", { reason });
      return reply
        .header("retry-after", "5")
        .code(503)
        .send({ error: "event stream capacity reached", code: "sse_capacity_reached" });
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    reply.raw.write(`event: ready\ndata: {}\n\n`);
    sseClients.add(reply.raw);
    sseClientPrincipals.set(reply.raw, principal);
    sseClientsPerPrincipal.set(principal, principalStreams + 1);
    request.raw.on("close", () => {
      releaseSseClient(reply.raw);
    });
  });

  const actorDiscoveryConfig = options.actorDiscovery;
  if (actorDiscoveryConfig && actorDiscoveryConfig.intervalMs > 0) {
    let sweeping = false;
    let closing = false;
    const sweep = async () => {
      if (sweeping || closing) return;
      sweeping = true;
      try {
        await discoverLocalActors({ store: workItems, ...actorDiscoveryConfig });
        workItems.reconcileStaleAgents();
      } catch (error) {
        app.log.warn({ err: error }, "actor discovery sweep failed");
      } finally {
        sweeping = false;
      }
    };
    const timer = setInterval(() => void sweep(), actorDiscoveryConfig.intervalMs);
    timer.unref();
    app.addHook("onReady", async () => {
      void sweep();
    });
    app.addHook("onClose", async () => {
      closing = true;
      clearInterval(timer);
    });
  }

  const adminExpirySweep = setInterval(() => {
    try {
      workItems.expireAdminModeIfDue();
    } catch {
      // Reads already treat an expired row as strict; the sweep only records the lapse.
    }
  }, 30_000);
  adminExpirySweep.unref();
  app.addHook("onClose", async () => {
    clearInterval(adminExpirySweep);
    if (ownsDcScheduler) dcScheduler.close();
    executionAdmission.shutdown();
    // Active durable reservations survive shutdown and are restored by the next gateway.
    await observationWorker?.stop();
    await acpAdapter?.stop();
    executionReads.close();
    deviceAuthStore.close();
    capabilityIssuanceRegistry.close();
    jcIssuanceRegistry.close();
    workItems.close();
  });

  function recordAuthenticatedMcpRequest(event: AuthenticatedMcpRequestAudit): void {
    workItems.recordConnectorRequest({
      actor: event.resolvedActor,
      source: "mcp",
      route: "/mcp",
      toolName: event.toolName ?? event.method,
      workItemId: event.workItemId,
      requestId: event.requestId,
      authMethod: event.auth.method,
      authSubject: event.auth.subject,
      authIssuer: event.auth.issuer,
      authConnectorId: event.auth.connectorId,
      authTunnelId: event.auth.tunnelId,
      authSessionId: event.auth.sessionId,
      authScopes: event.auth.scopes
    });
  }

  function recordLocalAgentEvent(event: LocalAgentAuditEvent): void {
    workItems.recordLocalAgentEvent({
      eventType: event.eventType,
      actor: event.actor,
      agentId: event.agentId,
      requestId: event.requestId,
      requestHash: event.requestHash,
      scope: event.scope,
      outcome: event.outcome,
      reason: event.reason,
      outputBytes: event.outputBytes,
      exitCode: event.exitCode
    });
  }

  /** Hash-chained audit evidence for /dc/capability/issue (issued vs denied). */
  function recordFailedChangeSetDispatch(
    request: FastifyRequest,
    error: unknown,
    runtime: "desktop_commander" | "jace_commander"
  ) {
    try {
      const parsed = dcCapabilityIssueSchema.safeParse(request.body);
      if (!parsed.success || !parsed.data.changeSetPermitId) return;
      const permit = workItems.getChangeSetOperationPermit(parsed.data.changeSetPermitId);
      if (!permit) return; // An untrusted identifier does not establish a mission relationship.
      workItems.recordSystemEvent({
        name: "change_set.dispatch_denied",
        body: {
          missionId: permit.missionId,
          manifestHash: permit.manifestHash,
          operationId: permit.operationId,
          permitId: permit.permitId,
          executionWorkItemId: permit.executionWorkItemId,
          runtime,
          requestId: request.id,
          code: error instanceof ControlStackError ? error.code : "dispatch_rejected"
        },
        attributes: {
          "work_item.id": permit.missionId,
          "execution.work_item_id": permit.executionWorkItemId,
          "worker.id": runtime === "desktop_commander" ? DC_BRIDGE_WORKER_ID : JC_BRIDGE_WORKER_ID
        }
      });
    } catch {
      request.log.warn(
        { requestId: request.id, code: "dispatch_denial_audit_unavailable" },
        "mission dispatch denial audit unavailable"
      );
    }
  }

  /**
   * Who the edge says is calling, kept per request so every audit helper can attach it without changing
   * its call sites. `clientId` is the verified OAuth client; the claim fields are self-declared.
   */
  const mcpCallContexts = new Map<
    string,
    { clientId: string; lane: McpLane; name?: string; version?: string; userAgent?: string }
  >();
  function mcpCallAttribution(requestId: string) {
    const context = mcpCallContexts.get(requestId);
    if (!context) return {};
    return {
      mcpClientId: context.clientId,
      mcpLane: context.lane,
      ...(context.name ? { mcpClientName: context.name } : {}),
      ...(context.version ? { mcpClientVersion: context.version } : {}),
      ...(context.userAgent ? { mcpUserAgent: context.userAgent } : {})
    };
  }
  /** Record the caller for this request and apply the optional require_label policy. Only ever denies. */
  function admitMcpCaller(
    lane: McpLane,
    request: FastifyRequest,
    clientId: string
  ): { ok: true } | { ok: false; detail: string } {
    // The id the index, labels and audit use. A client id the audit redactor would alter is replaced by a stable
    // digest so it keeps one identity everywhere instead of collapsing into "[redacted]".
    const canonicalId = canonicalClientId(clientId) ?? clientId;
    mcpCallContexts.set(request.id, {
      clientId: canonicalId,
      lane,
      ...(sanitizeClaim(firstHeader(request.headers["x-mcp-client-name"]))
        ? { name: sanitizeClaim(firstHeader(request.headers["x-mcp-client-name"]))! }
        : {}),
      ...(sanitizeClaim(firstHeader(request.headers["x-mcp-client-version"]), 64)
        ? { version: sanitizeClaim(firstHeader(request.headers["x-mcp-client-version"]), 64)! }
        : {}),
      ...(sanitizeClaim(firstHeader(request.headers["x-mcp-user-agent"]), 200)
        ? { userAgent: sanitizeClaim(firstHeader(request.headers["x-mcp-user-agent"]), 200)! }
        : {})
    });
    const gate = mcpClientService.gate(canonicalId);
    return gate.ok ? { ok: true } : { ok: false, detail: gate.detail };
  }
  /**
   * Check the label again after a request has waited for execution admission. An operator may have cleared it
   * while the call was queued; a cleared label must not still sign a capability. Only ever denies.
   */
  function recheckMcpCaller(request: FastifyRequest): { ok: true } | { ok: false; detail: string } {
    const context = mcpCallContexts.get(request.id);
    if (!context) return { ok: true };
    const gate = mcpClientService.gate(context.clientId);
    return gate.ok ? { ok: true } : { ok: false, detail: gate.detail };
  }

  function recordJcCapabilityAudit(
    actor: string,
    requestId: string,
    toolName: string,
    jcActor: string,
    outcome: "issued" | "denied",
    workItemId?: string
  ): void {
    workItems.recordConnectorRequest({
      actor,
      source: `jc-capability-${outcome}`,
      route: "/jc/capability/issue",
      toolName,
      workItemId,
      requestId,
      authMethod: "gateway_bearer",
      authSubject: jcActor,
      ...mcpCallAttribution(requestId)
    });
  }

  function recordDcCapabilityAudit(
    actor: string,
    requestId: string,
    toolName: string,
    dcActor: string,
    outcome: "issued" | "denied",
    workItemId?: string
  ): void {
    workItems.recordConnectorRequest({
      actor,
      source: `dc-capability-${outcome}`,
      route: "/dc/capability/issue",
      toolName,
      workItemId,
      requestId,
      authMethod: "gateway_bearer",
      authSubject: dcActor,
      ...mcpCallAttribution(requestId)
    });
  }

  function adapterStatusFor(agentId: string) {
    const status = acpAdapter?.getStatus();
    return status?.agentId === agentId ? status : undefined;
  }

  function recordShutdownDrain(phase: "start" | "finish" | "timeout", details: DrainStartInfo | DrainFinishInfo): void {
    metrics.increment(SHUTDOWN_DRAIN_METRIC, { phase });
    try {
      workItems.recordSystemEvent({
        name: phase === "start" ? "gateway.shutdown_drain.started" : "gateway.shutdown_drain.finished",
        body: { phase, ...details },
        attributes: {
          "gateway.shutdown_phase": phase,
          "gateway.active_leases": details.activeLeases
        }
      });
    } catch (error) {
      app.log.warn({ error, phase }, "failed to record shutdown drain audit event");
    }
  }

  app.decorate("acsShutdown", {
    controller: shutdownController,
    countActiveLeases: () => workItems.countActiveAttemptLeases(),
    failExpiredLeases: () => {
      workItems.failExpiredLeases();
    },
    recordDrainStart: (details: DrainStartInfo) => recordShutdownDrain("start", details),
    recordDrainFinish: (details: DrainFinishInfo) =>
      recordShutdownDrain(details.timedOut ? "timeout" : "finish", details)
  });

  return app;
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof ZodError) {
    return reply.code(400).send({ error: "invalid request" });
  }
  if (error instanceof AdmissionError) {
    const status = error.code === "queue_full" ? 429 : 503;
    if (error.retryAfterMs !== undefined) {
      reply.header("retry-after", String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))));
    }
    return reply.code(status).send({
      error: error.message,
      code: error.code,
      ...(error.retryAfterMs !== undefined ? { retry_after_ms: error.retryAfterMs } : {})
    });
  }
  if (error instanceof ControlStackError) {
    if (error.code === "admission_recovery_required")
      return reply.code(503).send({ error: "admission recovery requires reconciliation", code: error.code });
    const status =
      error.code === GATEWAY_SHUTTING_DOWN_CODE
        ? 503
        : error.code === "work_item_not_found" || error.code === "agent_not_found"
          ? 404
          : error.code === "worker_lease_expired"
            ? 410
            : error.code === "worker_lease_mismatch" ||
                error.code === "worker_action_hash_mismatch" ||
                error.code === "result_outcome_forbidden"
              ? 403
              : error.code === "actor_not_found" ||
                  error.code === "invalid_agent_registration" ||
                  error.code === "invalid_event_query" ||
                  error.code === "approval_action_hash_required" ||
                  error.code === "result_invalid" ||
                  error.code === "invalid_retry_request"
                ? 400
                : 409;
    const safeMessages: Record<string, string> = {
      gateway_shutting_down: "gateway is shutting down",
      worker_lease_missing: "active worker lease is required",
      worker_lease_conflict: "worker lease changed while accepting the result",
      lease_state_inconsistent: "worker lease state is invalid",
      result_conflict: "result conflicts with an accepted result",
      result_persistence_failed: "result could not be persisted",
      work_item_not_running: "work item is not accepting a result",
      worker_action_hash_mismatch: "worker action hash does not match the active lease",
      worker_lease_mismatch: "worker lease does not match the submitted result",
      result_outcome_forbidden: "ACS-derived outcomes are not worker-submittable"
    };
    return reply.code(status).send({ error: safeMessages[error.code] ?? error.message, code: error.code });
  }
  throw error;
}

function requestObject(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function validateRegisteredAgentPromptTarget(store: SqliteWorkItemStore, input: Record<string, unknown>): void {
  const actions = Array.isArray(input.requestedActions) ? input.requestedActions : [];
  if (!actions.some((value) => requestObject(value).kind === "agent.prompt")) return;
  const services = requestObject(input.target).services;
  if (!Array.isArray(services)) return;
  for (const service of services) {
    if (typeof service !== "string" || !store.getRegistryAgent(service)) {
      throw new ControlStackError("agent_target_not_registered", "agent.prompt targets must name registered agents");
    }
  }
}

/** Parse a bridge argument summary without persisting it. Invalid JSON fails closed. */
function parseDcArgsSummary(argsSummary: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsSummary);
  } catch {
    throw new ControlStackError("desktop_commander_argument_invalid", "Desktop Commander arguments must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ControlStackError("desktop_commander_argument_invalid", "Desktop Commander arguments must be an object");
  }
  return parsed as Record<string, unknown>;
}

function dcApprovalSummary(toolName: string, args: Record<string, unknown>, invocationHash: string): string {
  const paths = ["path", "file_path", "source", "destination", "cwd", "repoPath"]
    .map((key) => (typeof args[key] === "string" ? `${key}=${String(args[key])}` : undefined))
    .filter((value): value is string => Boolean(value));
  const details: string[] = [...paths];
  if (typeof args.content === "string") {
    details.push(`content_bytes=${Buffer.byteLength(args.content, "utf8")}`);
  }
  if (typeof args.old_string === "string") {
    details.push(`old_bytes=${Buffer.byteLength(args.old_string, "utf8")}`);
  }
  if (typeof args.new_string === "string") {
    details.push(`new_bytes=${Buffer.byteLength(args.new_string, "utf8")}`);
  }
  if (typeof args.command === "string") {
    const executable = args.command.trim().split(/\s+/u)[0] ?? "<unknown>";
    details.push(`command_executable=${executable}`);
  }
  if (Array.isArray(args.argv) && typeof args.argv[0] === "string") {
    details.push(`argv_executable=${args.argv[0]}`, `argv_count=${args.argv.length}`);
  }
  if (typeof args.patch === "string") {
    details.push(`patch_bytes=${Buffer.byteLength(args.patch, "utf8")}`);
  }
  for (const key of ["expectedSha256", "expectedHeadSha", "expectedCurrentSha256", "snapshotId"]) {
    if (typeof args[key] === "string") details.push(`${key}=${String(args[key])}`);
  }
  if (typeof args.pid === "number") {
    details.push(`pid=${args.pid}`);
  }
  details.push(`invocation_sha256=${invocationHash}`);
  return `${toolName}: ${details.join(" · ")}`;
}

function containmentRootForPaths(containment: ContainmentConfig, paths: readonly string[]): string | undefined {
  if (paths.length === 0) {
    return containment.allowedRoots[0];
  }
  return containment.allowedRoots.find((root) => paths.every((path) => path === root || path.startsWith(`${root}/`)));
}

/** Signing material plus the durable-issuance runtime identity binding. */
type DcCapabilitySigningConfig = CapabilitySigningConfig & {
  identityConfigFingerprint: string;
  runtimeScopes: readonly string[];
};

function resolveJaceCommanderSigningConfig(
  override: GatewayOptions["jaceCommanderCapability"]
): JaceCommanderSigningConfig | undefined {
  if (override === false) return undefined;
  if (override) return { ...override, ttlMs: override.ttlMs ?? 29_000 };
  try {
    return jaceCommanderSigningConfigFromEnv(process.env);
  } catch {
    // Incomplete/invalid env: the route answers 503 rather than issuing.
    return undefined;
  }
}

function resolveCapabilitySigningConfig(
  override: GatewayOptions["desktopCommanderCapability"],
  dbPath: string
): DcCapabilitySigningConfig | undefined {
  if (override) {
    if (!override.identityConfigFingerprint || !override.runtimeScopes) return undefined;
    return {
      runtimeId: override.runtimeId,
      keyId: override.keyId,
      privateKey: override.privateKey,
      ttlMs: override.ttlMs ?? 29_000,
      identityConfigFingerprint: override.identityConfigFingerprint,
      runtimeScopes: override.runtimeScopes
    };
  }
  try {
    const config = desktopCommanderAdapterConfigFromEnv(process.env, dbPath);
    return config?.capability
      ? {
          runtimeId: config.capability.runtimeId,
          keyId: config.capability.keyId,
          privateKey: config.capability.privateKey,
          ttlMs: 29_000,
          identityConfigFingerprint: config.capability.runtimeIdentityConfigFingerprint,
          runtimeScopes: config.capability.runtimeScopes
        }
      : undefined;
  } catch {
    // Partially/incorrectly configured Desktop Commander capability env must
    // not crash gateway startup; the endpoint fails closed with 503 instead.
    return undefined;
  }
}

function resolveJcContainment(override: ContainmentConfig | false | undefined): ContainmentConfig | undefined {
  if (override === false) return undefined;
  if (override) return override;
  try {
    return jaceCommanderContainmentFromEnv();
  } catch {
    // Invalid roots: fail closed for filesystem tools, keep the rest serving.
    return undefined;
  }
}

function resolveDcContainment(override: ContainmentConfig | undefined): ContainmentConfig | undefined {
  if (override) return override;
  try {
    return desktopCommanderContainmentFromEnv();
  } catch {
    // Fail closed at request time: without containment roots the gateway
    // cannot run the Phase 6-8 re-authorization, so no capability is issued.
    return undefined;
  }
}

function requireApprovalActionHash(input: Record<string, unknown>): void {
  if (typeof input.actionHash !== "string" || input.actionHash.trim().length === 0) {
    throw new ControlStackError(
      "approval_action_hash_required",
      "approval_action_hash_required: actionHash is required"
    );
  }
}

function approvalActionsByWorkItem(
  policy: ReturnType<typeof createPolicyEngine>,
  workItems: WorkItem[],
  actor: string | undefined
): Record<string, ApprovalActionOption[]> {
  if (!actor) {
    return {};
  }
  return Object.fromEntries(
    workItems
      .filter((workItem) => workItem.status === "needs_approval")
      .map((workItem) => [
        workItem.id,
        policy
          .evaluateWorkItem(workItem, actor, "approve")
          .filter((evaluation) => evaluation.decision.decision === "require_approval")
          .map((evaluation) => ({
            actionHash: evaluation.actionHash,
            kind: evaluation.action.kind,
            description: evaluation.action.description
          }))
      ])
      .filter(([, hashes]) => hashes.length > 0)
  );
}

function reportedExecutionBackend(): "dry_run" | "desktop_commander" | undefined {
  const raw = process.env.ACS_EXECUTION_BACKEND?.trim();
  if (raw === undefined || raw === "" || raw === "dry_run") return "dry_run";
  if (raw === "desktop_commander") return "desktop_commander";
  return undefined;
}

const DASHBOARD_EVENT_PAGE = 50;
/** Most recent policy decisions summarized on the Policy panel. */
const POLICY_SUMMARY_WINDOW = 500;
const dashboardQuerySchema = z
  .object({ finished: z.coerce.number().int().min(0).max(MAX_DASHBOARD_FINISHED_LIMIT).optional() })
  .passthrough();
const dashboardEventsQuerySchema = z.object({
  beforeSequence: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional()
});

function eventReadOptions(
  query: unknown,
  filters: Pick<ReadEventsOptions, "workItemId" | "agentId"> = {}
): ReadEventsOptions {
  const parsed = eventQuerySchema.parse(query ?? {});
  return {
    ...filters,
    limit: parsed.limit === undefined ? DEFAULT_EVENT_LIMIT : Math.min(parsed.limit, MAX_EVENT_LIMIT),
    ...(parsed.afterSequence === undefined ? {} : { afterSequence: parsed.afterSequence })
  };
}

interface AgentSessionProjection {
  sessionId: string;
  status: "active" | "closed" | "error";
  startedAt: string;
  lastEventAt: string;
  lastEventType: string;
  workItemId?: string;
}

function projectAgentSessions(events: StoredAuditEvent[]): AgentSessionProjection[] {
  const sessions = new Map<string, AgentSessionProjection>();
  for (const event of events) {
    if (!event.name.startsWith("acp.")) continue;
    const sessionId =
      typeof event.attributes["acp.session_id"] === "string"
        ? event.attributes["acp.session_id"]
        : typeof event.body.sessionId === "string"
          ? event.body.sessionId
          : undefined;
    if (!sessionId) continue;

    const observedAt = auditEventIso(event);
    const eventType =
      typeof event.attributes["acp.event_type"] === "string"
        ? event.attributes["acp.event_type"]
        : event.name.slice("acp.".length);
    const status: AgentSessionProjection["status"] =
      eventType === "error" ? "error" : eventType === "stop" || eventType === "disconnected" ? "closed" : "active";
    const workItemId =
      typeof event.attributes["work_item.id"] === "string"
        ? event.attributes["work_item.id"]
        : typeof event.body.workItemId === "string"
          ? event.body.workItemId
          : undefined;
    const current = sessions.get(sessionId);
    sessions.set(sessionId, {
      sessionId,
      status,
      startedAt: current?.startedAt ?? observedAt,
      lastEventAt: observedAt,
      lastEventType: eventType,
      ...(workItemId ? { workItemId } : current?.workItemId ? { workItemId: current.workItemId } : {})
    });
  }
  return [...sessions.values()].sort((left, right) => right.lastEventAt.localeCompare(left.lastEventAt));
}

function projectAgentActivity(agent: RegistryAgentDetail, sessions: AgentSessionProjection[]) {
  const activeSessions = sessions.filter((session) => session.status === "active");
  const currentSession = activeSessions[0];
  const lastActivityAt = [agent.lastHeartbeatAt, sessions[0]?.lastEventAt]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  return {
    ...(agent.latestHeartbeat?.currentTask ? { currentTask: agent.latestHeartbeat.currentTask } : {}),
    ...(currentSession?.workItemId ? { currentWorkItemId: currentSession.workItemId } : {}),
    ...(currentSession ? { currentSessionId: currentSession.sessionId } : {}),
    activeSessionCount: activeSessions.length,
    recentSessionCount: sessions.length,
    ...(lastActivityAt ? { lastActivityAt } : {})
  };
}

function auditEventIso(event: StoredAuditEvent): string {
  const millis = Number(BigInt(event.timeUnixNano) / 1_000_000n);
  return new Date(millis).toISOString();
}

function projectTunnelSession(session: RegisteredTunnelSession, heartbeatTtlMs: number) {
  const now = new Date();
  const sessionExpired =
    !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= now.getTime();
  const heartbeatExpired =
    session.status === "active" && isHeartbeatExpired(session.lastHeartbeatAt, session.issuedAt, now, heartbeatTtlMs);
  return {
    ...session,
    effectiveStatus: session.status === "revoked" || sessionExpired || heartbeatExpired ? "inactive" : "active",
    staleReason:
      session.status === "revoked"
        ? "revoked"
        : sessionExpired
          ? "session_expired"
          : heartbeatExpired
            ? "heartbeat_expired"
            : undefined
  };
}

function projectConnector(connector: RegisteredConnector, sessions: RegisteredTunnelSession[], heartbeatTtlMs: number) {
  const projectedSessions = sessions.map((session) => projectTunnelSession(session, heartbeatTtlMs));
  const activeSessions = projectedSessions.filter((session) => session.effectiveStatus === "active");
  const lastHeartbeatAt = sessions
    .map((session) => session.lastHeartbeatAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  const nextSessionExpiryAt = activeSessions
    .map((session) => session.expiresAt)
    .sort()
    .at(0);
  return {
    id: connector.id,
    displayName: connector.displayName,
    allowedScopes: [...connector.allowedScopes],
    status: connector.status,
    publicKeyFingerprint: createHash("sha256").update(connector.publicKeyPem).digest("base64url"),
    createdAt: connector.createdAt,
    updatedAt: connector.updatedAt,
    sessionCount: sessions.length,
    activeSessionCount: activeSessions.length,
    ...(lastHeartbeatAt ? { lastHeartbeatAt } : {}),
    ...(nextSessionExpiryAt ? { nextSessionExpiryAt } : {})
  };
}

function projectRegistryFreshness(
  agent: RegistryAgentDetail,
  heartbeatTtlMs: number
): RegistryAgentDetail & {
  effectiveStatus: RegistryStatus;
  heartbeatAgeMs: number | null;
  isStale: boolean;
} {
  const heartbeatTime = agent.lastHeartbeatAt ? Date.parse(agent.lastHeartbeatAt) : Number.NaN;
  const heartbeatAgeMs = Number.isFinite(heartbeatTime) ? Math.max(0, Date.now() - heartbeatTime) : null;
  const freshnessStatus = agent.status === "AVAILABLE" || agent.status === "BUSY" || agent.status === "DEGRADED";
  const isStale =
    freshnessStatus && isHeartbeatExpired(agent.lastHeartbeatAt, agent.updatedAt, new Date(), heartbeatTtlMs);
  return {
    ...agent,
    effectiveStatus: isStale ? "OFFLINE" : agent.status,
    heartbeatAgeMs,
    isStale
  };
}

function resolveAuth(options: GatewayOptions): GatewayAuthOptions | undefined {
  if (options.auth) {
    return options.auth;
  }

  const token = process.env.ACS_GATEWAY_TOKEN;
  const actor = requesterSchema.parse(process.env.ACS_GATEWAY_ACTOR ?? "user");
  const actorId = process.env.ACS_GATEWAY_ACTOR_ID;
  const credentialsJson = process.env.ACS_GATEWAY_CREDENTIALS_JSON;
  let credentials: GatewayCredential[] | undefined;

  if (credentialsJson) {
    credentials = gatewayCredentialSchema.array().parse(JSON.parse(credentialsJson));
    const ids = new Set<string>();
    for (const credential of credentials) {
      if (ids.has(credential.id)) throw new Error(`duplicate gateway credential id: ${credential.id}`);
      ids.add(credential.id);
    }
    if (credentials.length === 0) throw new Error("ACS_GATEWAY_CREDENTIALS_JSON must contain at least one credential");
  }

  if (!token && !credentials) {
    return undefined;
  }

  return {
    token: token ?? "",
    actor: token ? actor : "",
    ...(token && actorId ? { actorId } : {}),
    ...(credentials ? { credentials } : {})
  };
}

function resolveDirectAgentController(options: GatewayOptions): GatewayDirectAgentController | undefined {
  const enabled =
    options.enableTestAgentRunForLocalDevelopment ??
    process.env.ACS_ENABLE_TEST_AGENT_RUN_FOR_LOCAL_DEVELOPMENT === "1";
  if (!enabled) return undefined;
  if (process.env.NODE_ENV === "production") {
    throw new ControlStackError(
      "direct_agent_production_forbidden",
      "test.agent.run local-development opt-in is forbidden in production"
    );
  }
  if (options.directAgentController) return options.directAgentController;
  const configPath = options.machineControllerConfigPath ?? process.env.ACS_MACHINE_CONTROLLER_CONFIG;
  if (!configPath) return undefined;
  return new MachineController(loadMachineControllerConfig(configPath), {
    directAgentRunner: options.directAgentRunner,
    enableTestAgentRunForLocalDevelopment: true
  });
}

function resolveMcpAuth(options: GatewayOptions, workItems: SqliteWorkItemStore): McpAuthOptions | undefined {
  const resolved = resolveMcpAuthOptions({
    localBearerToken: options.mcpAuth?.localBearerToken,
    oauth: options.mcpAuth?.oauth ?? options.mcpOAuth,
    tunnel: options.mcpAuth?.tunnel
  });
  if (resolved?.tunnel && !resolved.tunnel.resolveSession && !resolved.tunnel.connectors?.length) {
    return {
      ...resolved,
      tunnel: {
        ...resolved.tunnel,
        resolveSession: (lookup) => workItems.getTunnelSession(lookup)
      }
    };
  }
  return resolved;
}

function resolveMcpAllowedOrigins(options: GatewayOptions): string[] {
  if (options.mcpAllowedOrigins) {
    return options.mcpAllowedOrigins;
  }
  return (process.env.ACS_MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function resolveRateLimitFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimitOptions {
  return {
    windowMs: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(3_600_000)
      .parse(env.ACS_RATE_LIMIT_WINDOW_MS ?? 60_000),
    maxRequests: z.coerce
      .number()
      .int()
      .min(1)
      .max(100_000)
      .parse(env.ACS_RATE_LIMIT_MAX_REQUESTS ?? 120)
  };
}

function resolveAuthLockoutFromEnv(env: NodeJS.ProcessEnv = process.env): AuthLockoutOptions {
  return {
    windowMs: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(3_600_000)
      .parse(env.ACS_AUTH_LOCKOUT_WINDOW_MS ?? DEFAULT_AUTH_LOCKOUT_WINDOW_MS),
    maxFailures: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000)
      .parse(env.ACS_AUTH_LOCKOUT_MAX_FAILURES ?? DEFAULT_AUTH_LOCKOUT_MAX_FAILURES)
  };
}

function resolveMaxSseClientsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return z.coerce
    .number()
    .int()
    .min(1)
    .max(100_000)
    .parse(env.ACS_MAX_SSE_CLIENTS ?? 100);
}

function resolveMaxSseClientsPerPrincipalFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return z.coerce
    .number()
    .int()
    .min(1)
    .max(100_000)
    .parse(env.ACS_MAX_SSE_CLIENTS_PER_PRINCIPAL ?? 10);
}

/**
 * The fairness guarantee is that no single principal can occupy every stream
 * slot. The two caps are configured independently, so an operator who lowers
 * ACS_MAX_SSE_CLIENTS below the per-principal default would otherwise void that
 * guarantee silently — with a global cap of 5 and the default 10, the
 * per-principal branch can never fire. Derive the effective limit from both
 * rather than trusting them to be coherent.
 *
 * One slot below the global ceiling is the minimum that actually enforces the
 * promise, and it leaves an explicit per-principal setting alone whenever that
 * setting is already consistent. A global cap of 1 has no fairness to give;
 * the floor of 1 keeps that degenerate case working rather than unservable.
 */
export function effectiveMaxSseClientsPerPrincipal(configured: number, globalMax: number): number {
  return Math.max(1, Math.min(configured, globalMax - 1));
}

/**
 * Shares the credential-or-IP identity the rate limiter uses, minus the
 * method/route prefix: the same operator across two browser tabs must land in
 * one bucket, or the per-principal cap is trivially sidestepped.
 */
function ssePrincipalKey(request: FastifyRequest, auth: GatewayAuthOptions | undefined): string {
  const credential = gatewayCredentialForRequest(request, auth);
  return credential ? `credential:${credential.id}` : `ip:${request.ip}`;
}

function resolveMaxPendingWorkItemsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .parse(env.ACS_MAX_PENDING_WORK_ITEMS ?? 1_000);
}

function hasPendingWorkItemCapacity(store: { list: () => WorkItem[] }, maxPendingWorkItems: number): boolean {
  const pending = store
    .list()
    .filter((workItem) =>
      ["draft", "pending_policy", "needs_approval", "approved", "running"].includes(workItem.status)
    ).length;
  return pending < maxPendingWorkItems;
}

function isRateLimitedRoute(url: string): boolean {
  const path = url.split("?", 1)[0];
  return (
    path === "/mcp" ||
    path === "/execution-mode" ||
    path === "/authority" ||
    path === "/session/login" ||
    path === "/oauth/device/code" ||
    path === "/oauth/token" ||
    path === "/work-items" ||
    // Worker claim polling is deliberately rate limited. It is authenticated, but an
    // unbounded poll loop from a leaked worker credential is still a workload
    // amplifier. The limiter keys by method, route and credential, so each worker
    // identity gets its own budget rather than sharing a global one.
    path === "/worker/claim" ||
    path === "/dc/capability/issue" ||
    path === "/jc/capability/issue" ||
    path === "/dc/runtime/bootstrap" ||
    path === "/dc/runtime/bootstrap/complete" ||
    path === "/policy/explain" ||
    path === "/dashboard/policy-preview" ||
    // MCP client visibility: bridge reports and operator labelling write audit events, so they are limited too.
    path === "/mcp-clients/observe" ||
    path.startsWith("/api/mission-dispatch") ||
    path === "/api/mcp-clients" ||
    path === "/api/mcp-clients/label" ||
    path === "/api/mcp-clients/label/clear" ||
    path.startsWith("/work-items/") ||
    path.startsWith("/webhooks/")
  );
}

function isRateLimitedGetRoute(url: string): boolean {
  // /device/verify rate limiting is enforced in-handler (see registerDeviceAuthRoutes).
  const path = url.split("?", 1)[0];
  return (
    path === "/execution-mode" ||
    path === "/authority" ||
    path === "/api/mcp-clients" ||
    path === "/api/mission-dispatch"
  );
}

function rateLimitKey(request: FastifyRequest, auth: GatewayAuthOptions | undefined): string {
  const credential = gatewayCredentialForRequest(request, auth);
  const principal = credential
    ? `credential:${credential.id}`
    : (bearerPrincipal(request.headers.authorization) ?? `ip:${request.ip}`);
  return `${request.method}:${request.routeOptions.url ?? "<unmatched>"}:${principal}`;
}

function bearerPrincipal(authorization: string | string[] | undefined): string | undefined {
  if (Array.isArray(authorization)) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (!match) return undefined;
  const digest = createHash("sha256").update(match[1]).digest("hex").slice(0, 16);
  return `bearer:${digest}`;
}

function jsonRpcRequestId(body: unknown): string | number | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const id = (body as Record<string, unknown>).id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function isAllowedMcpOrigin(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) {
    return true;
  }
  return allowedOrigins.includes(origin);
}

function isJsonParseError(error: unknown): boolean {
  return (error as { code?: string }).code === "FST_ERR_CTP_INVALID_JSON_BODY";
}

function isBodyTooLargeError(error: unknown): boolean {
  return (error as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE";
}

function jsonRpcError(id: string | number | null, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data })
    }
  };
}

function resolveMcpActorId(
  workItems: SqliteWorkItemStore,
  request: McpAuthenticatedRequest,
  gatewayAuth: GatewayAuthOptions | undefined
): string | undefined {
  const candidates = [
    request.connectorId,
    request.subject,
    `${request.method}:${request.connectorId ?? request.subject}`,
    request.method === "local_bearer" ? gatewayAuth?.actorId : undefined
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
  return workItems.resolveActorId(candidates);
}

function mcpResourceMetadataUrl(_request: FastifyRequest, oauth: McpOAuthOptions | undefined): string | undefined {
  if (!oauth) return undefined;
  const configured = process.env.ACS_MCP_RESOURCE_METADATA_URL;
  if (configured) return configured;
  try {
    const resource = new URL(oauth.resource ?? oauth.audience);
    const resourcePath = resource.pathname === "/" ? "" : resource.pathname;
    resource.pathname = `/.well-known/oauth-protected-resource${resourcePath}`;
    resource.search = "";
    resource.hash = "";
    return resource.toString();
  } catch {
    return undefined;
  }
}

function protectedResourceMetadata(auth: McpAuthOptions | undefined) {
  return auth?.oauth ? createProtectedResourceMetadata(auth.oauth) : undefined;
}

function requiresMcpAuthentication(request: FastifyRequest, auth: McpAuthOptions | undefined): boolean {
  return Boolean(auth) || !isDevelopmentLoopbackRequest(request);
}

function adminModeTtlFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.ACS_ADMIN_MODE_TTL_MS?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error("ACS_ADMIN_MODE_TTL_MS must be an integer number of milliseconds");
  return value;
}

export function renderLoginPage(redirectTo = "/"): string {
  const safeRedirect = redirectTo.startsWith("/") && !redirectTo.startsWith("//") ? redirectTo : "/";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AgentOS Mission Control Login</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #071019; color: #d7e0ea; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #071019; }
      form { width: min(360px, calc(100vw - 32px)); display: grid; gap: 12px; border: 1px solid #17283a; background: #0a1522; padding: 18px; border-radius: 8px; }
      h1 { margin: 0 0 4px; font-size: 20px; }
      label { display: grid; gap: 6px; color: #91a6bd; font-size: 13px; }
      input { background: #07111d; color: #dbeafe; border: 1px solid #1c3148; border-radius: 8px; padding: 10px; }
      button { background: #2563eb; color: white; border: 0; border-radius: 8px; padding: 10px 12px; font-weight: 700; cursor: pointer; }
      output { min-height: 20px; color: #fca5a5; }
    </style>
  </head>
  <body>
    <form id="login-form">
      <h1>Mission Control</h1>
      <label>Operator token<input name="token" type="password" autocomplete="off" autofocus /></label>
      <button type="submit">Sign in</button>
      <output></output>
    </form>
    <script>
      const redirectTo = ${JSON.stringify(safeRedirect)};
      document.querySelector('#login-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const res = await fetch('/session/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: String(form.get('token') || '') })
        });
        if (res.ok) location.assign(redirectTo);
        else document.querySelector('output').textContent = 'Unauthorized';
      });
    </script>
  </body>
</html>`;
}

export async function startGateway(
  startOptions: Pick<GatewayOptions, "actorDiscovery"> = {}
): Promise<FastifyInstance> {
  validateProductionConfig();
  const listen = gatewayListenConfig();
  const dbPath = process.env.ACS_DB_PATH ?? "storage/local.db";
  const codingMissionPorts = codingMissionPortsFromEnv(process.env, { dbPath });
  const app = buildGateway({
    dbPath,
    ...(codingMissionPorts ? { codingMissionPorts } : {}),
    ...(startOptions.actorDiscovery ? { actorDiscovery: startOptions.actorDiscovery } : {})
  });
  await app.listen(listen);
  return app;
}
