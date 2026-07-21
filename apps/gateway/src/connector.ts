import { isAbsolute } from "node:path";
import {
  connectorActionRegistry,
  getRegisteredConfigTarget,
  getRegisteredCommand,
  requireRegisteredService,
  registeredFilesystemRoots
} from "@agent-control-stack/machine-controller";
import { createPolicyEngine, createWorkItemTools, type PolicyEngine } from "@agent-control-stack/policy-gate";
import { ControlStackError } from "@agent-control-stack/shared";
import {
  evidenceRecordSchema,
  type EvidenceRecord,
  type WorkItem,
  type WorkItemStore
} from "@agent-control-stack/work-items";
import { z } from "zod";

export const connectorToolNames = [
  "work_item.create",
  "work_item.get",
  "work_item.approve",
  "work_item.reject",
  "work_item.cancel",
  "work_item.unblock",
  "command.preview",
  "command.run",
  "filesystem.read_text",
  "filesystem.stat",
  "agent.preview",
  "agent.run",
  "result.get",
  "evidence.list",
  "evidence.get",
  "service.restart.preview",
  "service.restart",
  "config.change.preview",
  "config.change"
] as const;

export type ConnectorToolName = (typeof connectorToolNames)[number];
export type ConnectorToolHandler = (input: unknown) => unknown;
export type ConnectorToolMap = Record<ConnectorToolName, ConnectorToolHandler>;

interface ConnectorToolOptions {
  store: WorkItemStore;
  policy?: PolicyEngine;
  workItemTools?: ReturnType<typeof createWorkItemTools>;
  cwd?: string;
}

const actorSchema = z.object({ actor: z.string().min(1) });
const commandRequestSchema = actorSchema.extend({ commandId: z.string().min(1) }).strict();
const filesystemPathSchema = z
  .string()
  .min(1)
  .max(1_000)
  .refine((value) => !isAbsolute(value), "relativePath must not be absolute")
  .refine((value) => !value.split(/[\\/]/u).includes(".."), "relativePath must not escape the named root");
const filesystemReadRequestSchema = actorSchema
  .extend({
    rootId: z.string().min(1),
    relativePath: filesystemPathSchema,
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional()
  })
  .strict();
const filesystemStatRequestSchema = actorSchema
  .extend({ rootId: z.string().min(1), relativePath: filesystemPathSchema })
  .strict();
const agentRequestSchema = actorSchema
  .extend({
    agentId: z.literal("codex-cli").default("codex-cli"),
    prompt: z.string().min(1).max(20_000),
    rootId: z.literal("acs-repo").default("acs-repo"),
    timeoutMs: z.number().int().positive().max(900_000).default(900_000),
    expectedOutputs: z.array(z.string().min(1).max(1_000)).max(50).default([])
  })
  .strict();
const serviceRequestSchema = actorSchema
  .extend({ serviceId: z.string().min(1), reason: z.string().min(1).max(2_000) })
  .strict();
const configPatchSchema = z
  .object({
    op: z.enum(["add", "replace", "remove"]),
    path: z.string().regex(/^\/[a-z][a-z0-9_]*$/),
    value: z.unknown().optional()
  })
  .strict()
  .superRefine((patch, context) => {
    if (patch.op !== "remove" && patch.value === undefined) {
      context.addIssue({ code: "custom", message: "add and replace patches require value", path: ["value"] });
    }
  });
const configRequestSchema = actorSchema
  .extend({
    targetId: z.string().min(1),
    patch: z.array(configPatchSchema).min(1).max(20),
    reason: z.string().min(1).max(2_000)
  })
  .strict();
const createRequestSchema = actorSchema
  .extend({
    title: z.string().min(1).max(256),
    intent: z.string().min(1).max(2_000),
    target: z.record(z.string(), z.unknown()).default({}),
    requestedActions: z.array(z.object({ kind: z.string().min(1), description: z.string().min(1), params: z.record(z.string(), z.unknown()).default({}) }).strict()).min(1).max(20),
    risk: z.enum(["low", "medium", "high", "critical"]).default("medium")
  })
  .strict();
const idRequestSchema = actorSchema.extend({ id: z.string().min(1) }).strict();
const approveRequestSchema = actorSchema
  .extend({ id: z.string().min(1), actionHash: z.string().regex(/^[a-f0-9]{64}$/i), reason: z.string().min(1).optional() })
  .strict();
const evidenceGetRequestSchema = actorSchema.extend({ id: z.string().min(1), evidenceId: z.string().min(1) }).strict();

export function createConnectorTools(options: ConnectorToolOptions): ConnectorToolMap {
  const policy = options.policy ?? createPolicyEngine();
  const workItemTools = options.workItemTools ?? createWorkItemTools(options.store, policy);
  const defaultCwd = options.cwd ?? process.cwd();

  const create = (input: unknown, definition: {
    title: string;
    intent: string;
    target?: Record<string, unknown>;
    kind: string;
    description: string;
    params: Record<string, unknown>;
    risk: "low" | "medium" | "high" | "critical";
  }) => {
    const actor = actorSchema.parse(input).actor;
    const workItem = workItemTools.create_work_item({
      title: definition.title,
      requester: "agent",
      requesterSubject: actor,
      intent: definition.intent,
      target: definition.target ?? { cwd: defaultCwd },
      requestedActions: [
        {
          kind: definition.kind,
          description: definition.description,
          params: {
            ...definition.params,
            registryActionId: definition.params.registryActionId,
            registryVersion: definition.params.registryVersion
          }
        }
      ],
      risk: definition.risk
    });
    return workItemEnvelope(options.store, policy, workItem, actor);
  };

  return {
    "work_item.create": (input) => {
      const parsed = createRequestSchema.parse(input);
      validateRegisteredActionRequest(parsed.requestedActions);
      const workItem = workItemTools.create_work_item({
        title: parsed.title,
        requester: "agent",
        requesterSubject: parsed.actor,
        intent: parsed.intent,
        target: parsed.target,
        requestedActions: parsed.requestedActions,
        risk: parsed.risk
      });
      return workItemEnvelope(options.store, policy, workItem, parsed.actor);
    },
    "work_item.get": (input) => {
      const parsed = idRequestSchema.parse(input);
      return getWorkItemEnvelope(options.store, policy, parsed.id, parsed.actor);
    },
    "work_item.approve": (input) => {
      const parsed = approveRequestSchema.parse(input);
      requireHumanActor(options.store, parsed.actor);
      const result = workItemTools.approve_work_item({
        id: parsed.id,
        approvedBy: parsed.actor,
        actionHash: parsed.actionHash,
        ...(parsed.reason ? { reason: parsed.reason } : {})
      });
      return {
        ...result,
        workItem: getWorkItemEnvelope(options.store, policy, parsed.id, parsed.actor).workItem
      };
    },
    "work_item.reject": (input) => {
      const parsed = idRequestSchema.parse(input);
      return { workItem: workItemTools.reject_work_item({ id: parsed.id, actor: parsed.actor }) };
    },
    "work_item.cancel": (input) => {
      const parsed = idRequestSchema.parse(input);
      return { workItem: workItemTools.cancel_work_item({ id: parsed.id, actor: parsed.actor }) };
    },
    "work_item.unblock": (input) => {
      const parsed = idRequestSchema.parse(input);
      return workItemTools.unblock_work_item({ id: parsed.id, actor: parsed.actor });
    },
    "command.preview": (input) => {
      const parsed = commandRequestSchema.parse(input);
      assertRegisteredCommand(parsed.commandId);
      return create(input, {
        title: `Preview diagnostic ${parsed.commandId}`,
        intent: `Preview the registered ACS diagnostic ${parsed.commandId}`,
        kind: "cmd.preview",
        description: `Preview registered command ${parsed.commandId}`,
        params: {
          commandId: parsed.commandId,
          readOnly: true,
          registryActionId: "acs.command.preview",
          registryVersion: "1.0"
        },
        risk: "low"
      });
    },
    "command.run": (input) => {
      const parsed = commandRequestSchema.parse(input);
      assertRegisteredCommand(parsed.commandId);
      return create(input, {
        title: `Run diagnostic ${parsed.commandId}`,
        intent: `Run the registered ACS diagnostic ${parsed.commandId}`,
        kind: "cmd.run",
        description: `Run registered command ${parsed.commandId}`,
        params: {
          commandId: parsed.commandId,
          readOnly: true,
          registryActionId: "acs.command.run",
          registryVersion: "1.0"
        },
        risk: "low"
      });
    },
    "filesystem.read_text": (input) => {
      const parsed = parseConnector(filesystemReadRequestSchema, input, "filesystem read request is invalid");
      assertRegisteredRoot(parsed.rootId);
      return create(input, {
        title: `Read ${parsed.relativePath}`,
        intent: `Read an allowlisted ACS file under ${parsed.rootId}`,
        kind: "fs.read",
        description: `Read text file ${parsed.relativePath}`,
        params: {
          rootId: parsed.rootId,
          relativePath: parsed.relativePath,
          paths: [parsed.relativePath],
          ...(parsed.startLine === undefined ? {} : { startLine: parsed.startLine }),
          ...(parsed.endLine === undefined ? {} : { endLine: parsed.endLine }),
          registryActionId: "acs.filesystem.read_text",
          registryVersion: "1.0"
        },
        risk: "low"
      });
    },
    "filesystem.stat": (input) => {
      const parsed = parseConnector(filesystemStatRequestSchema, input, "filesystem stat request is invalid");
      assertRegisteredRoot(parsed.rootId);
      return create(input, {
        title: `Stat ${parsed.relativePath}`,
        intent: `Read allowlisted ACS file metadata under ${parsed.rootId}`,
        kind: "fs.stat",
        description: `Stat file ${parsed.relativePath}`,
        params: {
          rootId: parsed.rootId,
          relativePath: parsed.relativePath,
          paths: [parsed.relativePath],
          registryActionId: "acs.filesystem.stat",
          registryVersion: "1.0"
        },
        risk: "low"
      });
    },
    "agent.preview": (input) => {
      const parsed = agentRequestSchema.parse(input);
      return create(input, {
        title: "Preview Codex dispatch",
        intent: "Preview a bounded Codex inspection without execution",
        kind: "agent.preview",
        description: "Preview Codex read-only dispatch",
        params: agentParams(parsed, "acs.agent.codex.preview"),
        risk: "low"
      });
    },
    "agent.run": (input) => {
      const parsed = agentRequestSchema.parse(input);
      return create(input, {
        title: "Run bounded Codex inspection",
        intent: "Run a bounded Codex inspection through the ACS worker",
        kind: "agent.prompt",
        description: "Dispatch Codex through the worker sandbox",
        params: agentParams(parsed, "acs.agent.codex.run"),
        risk: "high"
      });
    },
    "result.get": (input) => {
      const parsed = idRequestSchema.parse(input);
      return getWorkItemEnvelope(options.store, policy, parsed.id, parsed.actor);
    },
    "evidence.list": (input) => {
      const parsed = idRequestSchema.parse(input);
      const envelope = getWorkItemEnvelope(options.store, policy, parsed.id, parsed.actor);
      return {
        workItemId: parsed.id,
        evidence: envelope.evidence.map(({ content: _content, ...metadata }) => metadata)
      };
    },
    "evidence.get": (input) => {
      const parsed = evidenceGetRequestSchema.parse(input);
      const envelope = getWorkItemEnvelope(options.store, policy, parsed.id, parsed.actor);
      const evidence = envelope.evidence.find((entry) => entry.evidence_id === parsed.evidenceId);
      if (!evidence) {
        throw new ControlStackError("evidence_not_found", `evidence not found: ${parsed.evidenceId}`);
      }
      options.store.recordEvidenceAccess({ workItemId: parsed.id, evidenceId: parsed.evidenceId, actor: parsed.actor });
      return evidence;
    },
    "service.restart.preview": (input) => {
      const parsed = serviceRequestSchema.parse(input);
      requireRegisteredService(parsed.serviceId);
      return create(input, {
        title: `Preview restart ${parsed.serviceId}`,
        intent: `Preview a restart of the registered ACS service ${parsed.serviceId}`,
        target: { cwd: defaultCwd, services: [parsed.serviceId] },
        kind: "service.restart.preview",
        description: `Preview restart of ${parsed.serviceId}`,
        params: {
          serviceId: parsed.serviceId,
          reason: parsed.reason,
          registryActionId: "acs.service.restart",
          registryVersion: "1.0"
        },
        risk: "low"
      });
    },
    "service.restart": (input) => {
      const parsed = serviceRequestSchema.parse(input);
      requireRegisteredService(parsed.serviceId);
      return create(input, {
        title: `Restart ${parsed.serviceId}`,
        intent: `Restart the registered ACS service ${parsed.serviceId}`,
        target: { cwd: defaultCwd, services: [parsed.serviceId] },
        kind: "service.restart",
        description: `Restart registered service ${parsed.serviceId}`,
        params: {
          serviceId: parsed.serviceId,
          reason: parsed.reason,
          command: ["systemctl", "--user", "restart", `${parsed.serviceId}.service`],
          registryActionId: "acs.service.restart",
          registryVersion: "1.0"
        },
        risk: "high"
      });
    },
    "config.change.preview": (input) => {
      const parsed = configRequestSchema.parse(input);
      requireRegisteredConfigTarget(parsed.targetId);
      return create(input, {
        title: `Preview config change ${parsed.targetId}`,
        intent: `Preview a structured change to the registered ACS config target ${parsed.targetId}`,
        target: { cwd: defaultCwd, files: [parsed.targetId] },
        kind: "config.change.preview",
        description: `Preview config change ${parsed.targetId}`,
        params: {
          targetId: parsed.targetId,
          patch: parsed.patch,
          reason: parsed.reason,
          registryActionId: "acs.config.change",
          registryVersion: "1.0"
        },
        risk: "low"
      });
    },
    "config.change": (input) => {
      const parsed = configRequestSchema.parse(input);
      requireRegisteredConfigTarget(parsed.targetId);
      return create(input, {
        title: `Change config ${parsed.targetId}`,
        intent: `Apply a structured change to the registered ACS config target ${parsed.targetId}`,
        target: { cwd: defaultCwd, files: [parsed.targetId] },
        kind: "config.change",
        description: `Change config ${parsed.targetId}`,
        params: {
          targetId: parsed.targetId,
          patch: parsed.patch,
          reason: parsed.reason,
          registryActionId: "acs.config.change",
          registryVersion: "1.0"
        },
        risk: "high"
      });
    }
  };
}

function agentParams(
  input: z.infer<typeof agentRequestSchema>,
  registryActionId: "acs.agent.codex.preview" | "acs.agent.codex.run"
): Record<string, unknown> {
  return {
    agent: "codex",
    provider: "codex-cli",
    model: "gpt-5-codex",
    prompt: input.prompt,
    rootId: input.rootId,
    permissionMode: "read-only",
    timeoutMs: input.timeoutMs,
    networkAccess: "none",
    expectedOutputs: input.expectedOutputs,
    registryActionId,
    registryVersion: "1.0"
  };
}

function workItemEnvelope(store: WorkItemStore, policy: PolicyEngine, workItem: WorkItem, actor: string) {
  const evaluations = policy.evaluateWorkItem(workItem, actor, "approve");
  const events = store.readEvents({ workItemId: workItem.id });
  const evidence = evidenceFor(workItem);
  const approvalHashes = evaluations
    .filter((evaluation) => evaluation.decision.decision === "require_approval")
    .map((evaluation) => evaluation.actionHash);
  return {
    workItem,
    policy: evaluations.map((evaluation) => ({
      actionHash: evaluation.actionHash,
      kind: evaluation.action.kind,
      decision: evaluation.decision
    })),
    approvalHashes,
    approvals: events.filter((event) => event.name === "approval.granted").map((event) => event.body),
    lease: leaseFromEvents(events),
    evidence
  };
}

function getWorkItemEnvelope(store: WorkItemStore, policy: PolicyEngine, id: string, actor: string) {
  const workItem = store.get(id);
  if (!workItem) {
    throw new ControlStackError("work_item_not_found", `work item not found: ${id}`);
  }
  assertWorkItemAccess(store, workItem, actor);
  return workItemEnvelope(store, policy, workItem, actor);
}

function assertWorkItemAccess(store: WorkItemStore, workItem: WorkItem, actorId: string): void {
  const actor = store.listActors().find((entry) => entry.id === actorId);
  if (actor?.actorType === "HUMAN" || workItem.requesterSubject === actorId) return;
  throw new ControlStackError("work_item_access_denied", "work-item access is not authorized for this actor");
}

function evidenceFor(workItem: WorkItem): EvidenceRecord[] {
  const parsed = z.array(evidenceRecordSchema).safeParse(workItem.result?.evidence ?? []);
  return parsed.success ? parsed.data : [];
}

function leaseFromEvents(events: Array<{ name: string; body: Record<string, unknown> }>): Record<string, unknown> | undefined {
  const running = [...events].reverse().find((event) => event.name === "work_item.running");
  if (!running) return undefined;
  const terminal = [...events]
    .reverse()
    .find((event) => ["work_item.succeeded", "work_item.failed", "work_item.blocked", "work_item.cancelled"].includes(event.name));
  return {
    workerId: running.body.workerId,
    leaseExpiresAt: running.body.leaseExpiresAt,
    status: terminal ? terminal.name.replace("work_item.", "") : "running",
    ...(terminal ? { released: true } : {})
  };
}

function validateRegisteredActionRequest(actions: Array<{ kind: string; params: Record<string, unknown> }>): void {
  for (const action of actions) {
    const actionId = action.params.registryActionId;
    const version = action.params.registryVersion;
    if (typeof actionId !== "string" || typeof version !== "string") {
      throw new ControlStackError("action_registry_required", "connector actions require a registryActionId and registryVersion");
    }
    if (!connectorActionRegistry.some((entry) => entry.id === actionId && entry.version === version && entry.kind === action.kind)) {
      throw new ControlStackError("action_registry_mismatch", `connector action is not registered: ${actionId}@${version}`);
    }
  }
}

function assertRegisteredCommand(commandId: string): void {
  if (!getRegisteredCommand(commandId)) {
    throw new ControlStackError("command_not_registered", `registered command is unknown: ${commandId}`);
  }
}

function assertRegisteredRoot(rootId: string): void {
  if (!registeredFilesystemRoots.some((entry) => entry.id === rootId)) {
    throw new ControlStackError("filesystem_root_not_registered", `filesystem root is unknown: ${rootId}`);
  }
}

function requireRegisteredConfigTarget(targetId: string): void {
  if (!getRegisteredConfigTarget(targetId)) {
    throw new ControlStackError("config_target_not_registered", `config target is unknown: ${targetId}`);
  }
}

function requireHumanActor(store: WorkItemStore, actorId: string): void {
  const actor = store.listActors().find((entry) => entry.id === actorId);
  if (actor?.actorType !== "HUMAN") {
    throw new ControlStackError("human_approval_required", "human approval is required for this action");
  }
}

function parseConnector<T extends z.ZodType>(schema: T, input: unknown, message: string): z.infer<T> {
  try {
    return schema.parse(input);
  } catch {
    throw new ControlStackError("connector_input_invalid", message);
  }
}
