import { isAbsolute } from "node:path";
import {
  connectorActionRegistry,
  getRegisteredConfigTarget,
  getRegisteredCommand,
  requireRegisteredService,
  registeredFilesystemRoots
} from "@agent-control-stack/machine-controller";
import { createPolicyEngine, createWorkItemTools, type PolicyEngine } from "@agent-control-stack/policy-gate";
import { ControlStackError, redactValue } from "@agent-control-stack/shared";
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
  "config.change",
  "create_directory",
  "edit_block",
  "force_terminate",
  "get_config",
  "get_file_info",
  "get_more_search_results",
  "get_prompts",
  "get_recent_tool_calls",
  "get_usage_stats",
  "give_feedback_to_desktop_commander",
  "interact_with_process",
  "kill_process",
  "list_devices",
  "list_directory",
  "list_processes",
  "list_searches",
  "list_sessions",
  "move_file",
  "ping",
  "read_file",
  "read_multiple_files",
  "read_process_output",
  "set_config_value",
  "shutdown",
  "start_process",
  "start_search",
  "stop_search",
  "who_am_i",
  "write_file",
  "write_pdf"
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

const actorSchema = z.object({ actor: z.string().min(1), deviceId: z.string().optional() });
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
    requestedActions: z
      .array(
        z
          .object({
            kind: z.string().min(1),
            description: z.string().min(1),
            params: z.record(z.string(), z.unknown()).default({})
          })
          .strict()
      )
      .min(1)
      .max(20),
    risk: z.enum(["low", "medium", "high", "critical"]).default("medium")
  })
  .strict();
const idRequestSchema = actorSchema.extend({ id: z.string().min(1) }).strict();
const approveRequestSchema = actorSchema
  .extend({
    id: z.string().min(1),
    actionHash: z.string().regex(/^[a-f0-9]{64}$/i),
    reason: z.string().min(1).optional()
  })
  .strict();
const evidenceGetRequestSchema = actorSchema.extend({ id: z.string().min(1), evidenceId: z.string().min(1) }).strict();
const desktopPathSchema = actorSchema
  .extend({ rootId: z.string().min(1).default("acs-repo"), path: filesystemPathSchema })
  .strict();
const desktopReadSchema = desktopPathSchema
  .extend({
    offset: z.number().int().default(0),
    length: z.number().int().positive().max(1_000).default(1_000)
  })
  .strict();
const desktopMultipleReadSchema = actorSchema
  .extend({
    rootId: z.string().min(1).default("acs-repo"),
    paths: z.array(filesystemPathSchema).min(1).max(100),
    offset: z.number().int().default(0),
    length: z.number().int().positive().max(1_000).default(1_000)
  })
  .strict();
const desktopDirectorySchema = actorSchema
  .extend({
    rootId: z.string().min(1).default("acs-repo"),
    path: filesystemPathSchema.default("."),
    depth: z.number().int().min(0).max(5).default(2)
  })
  .strict();
const desktopWriteSchema = actorSchema
  .extend({
    rootId: z.string().min(1).default("acs-repo"),
    path: filesystemPathSchema,
    content: z.string().max(20_000),
    mode: z.enum(["rewrite", "append"]).default("rewrite")
  })
  .strict();
const desktopEditSchema = actorSchema
  .extend({
    rootId: z.string().min(1).default("acs-repo"),
    file_path: filesystemPathSchema,
    old_string: z.string().min(1).max(20_000),
    new_string: z.string().max(20_000),
    expected_replacements: z.number().int().positive().max(100).default(1)
  })
  .strict();
const desktopMoveSchema = actorSchema
  .extend({
    rootId: z.string().min(1).default("acs-repo"),
    source: filesystemPathSchema,
    destination: filesystemPathSchema,
    overwrite: z.boolean().default(false)
  })
  .strict();
const desktopPdfSchema = actorSchema
  .extend({
    rootId: z.string().min(1).default("acs-repo"),
    path: filesystemPathSchema,
    outputPath: filesystemPathSchema.optional(),
    content: z.union([z.string().max(20_000), z.array(z.unknown()).max(100)])
  })
  .strict();
const desktopSearchSchema = actorSchema
  .extend({
    rootId: z.string().min(1).default("acs-repo"),
    path: filesystemPathSchema.default("."),
    pattern: z.string().min(1).max(500),
    searchType: z.enum(["files", "content"]).default("files"),
    filePattern: z.string().max(200).optional(),
    ignoreCase: z.boolean().default(true),
    maxResults: z.number().int().positive().max(200).default(100),
    includeHidden: z.boolean().default(false),
    contextLines: z.number().int().min(0).max(20).default(5),
    timeout_ms: z.number().int().positive().max(120_000).default(30_000),
    literalSearch: z.boolean().default(false)
  })
  .strict();
const searchPageSchema = actorSchema
  .extend({
    sessionId: z.string().min(1),
    offset: z.number().int().min(0).default(0),
    length: z.number().int().positive().max(1_000).default(100)
  })
  .strict();
const processStartSchema = actorSchema
  .extend({
    command: z.string().min(1),
    timeout_ms: z.number().int().positive().max(120_000).default(30_000),
    shell: z.string().optional(),
    verbose_timing: z.boolean().default(false)
  })
  .strict();
const processPidSchema = actorSchema
  .extend({
    pid: z.number().int().positive(),
    deviceId: z.string().optional()
  })
  .strict();
const processInputSchema = processPidSchema
  .extend({
    input: z.string().max(20_000),
    timeout_ms: z.number().int().positive().max(30_000).default(8_000),
    wait_for_prompt: z.boolean().default(true),
    verbose_timing: z.boolean().default(false)
  })
  .strict();
const processOutputSchema = processPidSchema
  .extend({
    offset: z.number().int().min(0).default(0),
    length: z.number().int().positive().max(1_000).default(1_000),
    timeout_ms: z.number().int().positive().max(30_000).default(8_000),
    verbose_timing: z.boolean().default(false)
  })
  .strict();
const configValueSchema = actorSchema
  .extend({
    key: z.enum(["worker_poll_interval_ms", "max_evidence_bytes"]),
    value: z.number().int(),
    reason: z.string().min(1).max(2_000).default("Desktop Commander compatibility request")
  })
  .strict();
const promptSchema = actorSchema.extend({ action: z.literal("get_prompt"), promptId: z.string().min(1) }).strict();
const recentCallsSchema = actorSchema
  .extend({ maxResults: z.number().int().positive().max(1000).default(50), since: z.string().datetime().optional() })
  .strict();

export function createConnectorTools(options: ConnectorToolOptions): ConnectorToolMap {
  const policy = options.policy ?? createPolicyEngine();
  const workItemTools = options.workItemTools ?? createWorkItemTools(options.store, policy);
  const defaultCwd = options.cwd ?? process.cwd();

  const create = (
    input: unknown,
    definition: {
      title: string;
      intent: string;
      target?: Record<string, unknown>;
      kind: string;
      description: string;
      params: Record<string, unknown>;
      risk: "low" | "medium" | "high" | "critical";
    }
  ) => {
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
  const createReadOnlyCommandWorkItem = (input: unknown, commandId: string, description: string) => {
    actorSchema.parse(input);
    assertRegisteredCommand(commandId);
    return create(input, {
      title: description,
      intent: description,
      kind: "cmd.run",
      description,
      params: {
        commandId,
        readOnly: true,
        registryActionId: "acs.command.run",
        registryVersion: "1.0"
      },
      risk: "low"
    });
  };
  const createProcessWorkItem = (
    input: unknown,
    kind: "process.interact" | "process.output" | "process.kill" | "process.force_terminate" | "system.shutdown",
    registryActionId: string,
    description: string,
    risk: "low" | "high" | "critical"
  ) => {
    const parsed =
      kind === "process.interact"
        ? processInputSchema.parse(input)
        : kind === "process.output"
          ? processOutputSchema.parse(input)
          : kind === "system.shutdown"
            ? actorSchema.extend({ deviceId: z.string().optional() }).strict().parse(input)
            : processPidSchema.parse(input);
    const { actor: _actor, ...params } = parsed;
    return create(input, {
      title: description,
      intent: description,
      kind,
      description,
      params: {
        ...params,
        ...(kind === "system.shutdown" ? { rollbackCheckpoint: "acs-shutdown-disabled" } : {}),
        registryActionId,
        registryVersion: "1.0"
      },
      risk
    });
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
    },
    create_directory: (input) => {
      const parsed = desktopPathSchema.parse(input);
      assertRegisteredRoot(parsed.rootId);
      return create(input, {
        title: "Create directory " + parsed.path,
        intent: "Create a directory inside the registered ACS filesystem root",
        kind: "fs.write",
        description: "Create directory " + parsed.path,
        params: {
          rootId: parsed.rootId,
          relativePath: parsed.path,
          paths: [parsed.path],
          operation: "create_directory",
          registryActionId: "acs.filesystem.create_directory",
          registryVersion: "1.0"
        },
        risk: "high"
      });
    },
    edit_block: (input) => {
      const parsed = desktopEditSchema.parse(input);
      assertRegisteredRoot(parsed.rootId);
      return create(input, {
        title: "Edit " + parsed.file_path,
        intent: "Apply an exact surgical edit inside the registered ACS filesystem root",
        kind: "fs.patch",
        description: "Edit file block " + parsed.file_path,
        params: {
          rootId: parsed.rootId,
          relativePath: parsed.file_path,
          paths: [parsed.file_path],
          oldString: parsed.old_string,
          newString: parsed.new_string,
          expectedReplacements: parsed.expected_replacements,
          registryActionId: "acs.filesystem.edit_block",
          registryVersion: "1.0"
        },
        risk: "high"
      });
    },
    force_terminate: (input) =>
      createProcessWorkItem(
        input,
        "process.force_terminate",
        "acs.process.force_terminate",
        "Force terminate ACS-started process",
        "critical"
      ),
    get_config: (input) => {
      const parsed = actorSchema.parse(input);
      return {
        actor: parsed.actor,
        product: "agent-control-stack",
        compatibility: "desktop-commander-governed-equivalent",
        policy: { default: "deny", mutationApproval: "human", secrets: "redacted" },
        filesystemRoots: registeredFilesystemRoots,
        commands: ["registered-only"],
        services: ["acs-gateway", "acs-worker", "acs-tunnel", "acs-connector-test"],
        devices: [{ deviceId: "acs-local", online: true, executionBoundary: "acs-worker" }]
      };
    },
    get_file_info: (input) => {
      const parsed = desktopPathSchema.parse(input);
      assertRegisteredRoot(parsed.rootId);
      return create(input, {
        title: "Get file info " + parsed.path,
        intent: "Read metadata for a file inside the registered ACS filesystem root",
        kind: "fs.stat",
        description: "Stat file " + parsed.path,
        params: {
          rootId: parsed.rootId,
          relativePath: parsed.path,
          paths: [parsed.path],
          registryActionId: "acs.filesystem.stat",
          registryVersion: "1.0"
        },
        risk: "low"
      });
    },
    get_more_search_results: (input) => {
      const parsed = searchPageSchema.parse(input);
      const envelope = getWorkItemEnvelope(options.store, policy, parsed.sessionId, parsed.actor);
      return paginateSearchResult(envelope, parsed.sessionId, parsed.offset, parsed.length);
    },
    get_prompts: (input) => {
      const parsed = promptSchema.parse(input);
      const prompts: Record<string, Record<string, string>> = {
        onb2_01: {
          title: "Inspect an ACS workspace",
          prompt: "Use bounded ACS filesystem and diagnostic tools to inspect a workspace."
        },
        onb2_02: {
          title: "Explain an ACS repository",
          prompt: "Explain the repository using read-only ACS file and agent tools."
        },
        onb2_03: {
          title: "Create governed knowledge",
          prompt: "Propose a knowledge organization plan; writes require explicit approval."
        },
        onb2_04: {
          title: "Analyze a data file",
          prompt: "Read and analyze an allowlisted data file without exposing secrets."
        },
        onb2_05: { title: "Check ACS health", prompt: "Inspect registered diagnostics, service health, and evidence." }
      };
      const prompt = prompts[parsed.promptId];
      if (!prompt)
        throw new ControlStackError("prompt_not_found", "ACS compatibility prompt not found: " + parsed.promptId);
      return { promptId: parsed.promptId, ...prompt, governed: true };
    },
    get_recent_tool_calls: (input) => {
      const parsed = recentCallsSchema.parse(input);
      const calls = options.store
        .readEvents({ limit: parsed.maxResults })
        .filter((event) => event.name === "connector.requested")
        .filter((event) => !parsed.since || Number(event.timeUnixNano) / 1_000_000 >= Date.parse(parsed.since))
        .map((event) => redactConnectorEvent(event));
      return { calls };
    },
    get_usage_stats: (input) => {
      const parsed = actorSchema.parse(input);
      const workItems = options.store.list({ limit: 100 });
      const byStatus = Object.fromEntries(
        [...new Set(workItems.map((item) => item.status))].map((status) => [
          status,
          workItems.filter((item) => item.status === status).length
        ])
      );
      return {
        actor: parsed.actor,
        workItems: { sampled: workItems.length, byStatus },
        auditEvents: options.store.readEvents({ limit: 500 }).length,
        auditChain: options.store.verifyAuditChain(),
        health: options.store.health()
      };
    },
    give_feedback_to_desktop_commander: (input) => {
      const parsed = actorSchema.parse(input);
      return {
        actor: parsed.actor,
        supported: false,
        reason: "ACS does not open external feedback forms or browser sessions.",
        alternative: "Submit feedback through the configured ACS product channel."
      };
    },
    interact_with_process: (input) =>
      createProcessWorkItem(
        input,
        "process.interact",
        "acs.process.interact",
        "Send input to an ACS-started process",
        "high"
      ),
    kill_process: (input) =>
      createProcessWorkItem(input, "process.kill", "acs.process.kill", "Terminate an ACS-started process", "high"),
    list_devices: (input) => {
      const parsed = actorSchema.parse(input);
      return {
        actor: parsed.actor,
        devices: [{ deviceId: "acs-local", online: true, capabilities: [...connectorToolNames] }]
      };
    },
    list_directory: (input) => {
      const parsed = desktopDirectorySchema.parse(input);
      assertRegisteredRoot(parsed.rootId);
      return create(input, {
        title: "List directory " + parsed.path,
        intent: "List an allowlisted ACS directory",
        kind: "fs.list",
        description: "List directory " + parsed.path,
        params: {
          rootId: parsed.rootId,
          relativePath: parsed.path,
          paths: [parsed.path],
          maxDepth: parsed.depth,
          registryActionId: "acs.filesystem.list_directory",
          registryVersion: "1.0"
        },
        risk: "low"
      });
    },
    list_processes: (input) => createReadOnlyCommandWorkItem(input, "process.list", "List bounded local processes"),
    list_searches: (input) => {
      const parsed = actorSchema.parse(input);
      const searches = options.store
        .list({ limit: 100 })
        .filter((item) => item.requestedActions.some((action) => action.kind === "fs.search_name"))
        .map((item) => ({
          sessionId: item.id,
          status: item.status,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt
        }));
      return { actor: parsed.actor, searches };
    },
    list_sessions: (input) => {
      const parsed = actorSchema.parse(input);
      const sessions = options.store
        .list({ status: "running", limit: 100 })
        .map((item) => ({ sessionId: item.id, status: item.status, title: item.title, updatedAt: item.updatedAt }));
      return { actor: parsed.actor, sessions };
    },
    move_file: (input) => {
      const parsed = desktopMoveSchema.parse(input);
      assertRegisteredRoot(parsed.rootId);
      return create(input, {
        title: "Move " + parsed.source,
        intent: "Move an allowlisted ACS path without crossing the registered root",
        kind: "fs.move",
        description: "Move " + parsed.source + " to " + parsed.destination,
        params: {
          rootId: parsed.rootId,
          source: parsed.source,
          destination: parsed.destination,
          overwrite: parsed.overwrite,
          paths: [parsed.source, parsed.destination],
          registryActionId: "acs.filesystem.move_file",
          registryVersion: "1.0"
        },
        risk: "high"
      });
    },
    ping: (input) => {
      const parsed = actorSchema.parse(input);
      return { actor: parsed.actor, pong: true, deviceId: "acs-local", timestamp: new Date().toISOString() };
    },
    read_file: (input) => {
      const parsed = desktopReadSchema.parse(input);
      assertRegisteredRoot(parsed.rootId);
      return create(input, {
        title: "Read file " + parsed.path,
        intent: "Read a bounded redacted file from the registered ACS filesystem root",
        kind: "fs.read",
        description: "Read file " + parsed.path,
        params: {
          rootId: parsed.rootId,
          relativePath: parsed.path,
          paths: [parsed.path],
          offset: parsed.offset,
          length: parsed.length,
          registryActionId: "acs.filesystem.read_text",
          registryVersion: "1.0"
        },
        risk: "low"
      });
    },
    read_multiple_files: (input) => {
      const parsed = desktopMultipleReadSchema.parse(input);
      assertRegisteredRoot(parsed.rootId);
      return create(input, {
        title: "Read multiple files",
        intent: "Read bounded redacted files from the registered ACS filesystem root",
        kind: "fs.read",
        description: "Read multiple allowlisted files",
        params: {
          rootId: parsed.rootId,
          paths: parsed.paths,
          offset: parsed.offset,
          length: parsed.length,
          operation: "read_multiple",
          registryActionId: "acs.filesystem.read_multiple",
          registryVersion: "1.0"
        },
        risk: "low"
      });
    },
    read_process_output: (input) =>
      createProcessWorkItem(
        input,
        "process.output",
        "acs.process.output",
        "Read bounded output from an ACS-started process",
        "low"
      ),
    set_config_value: (input) => {
      const parsed = configValueSchema.parse(input);
      return create(input, {
        title: "Set ACS config " + parsed.key,
        intent: "Apply one allowlisted ACS configuration value",
        target: { cwd: defaultCwd, files: ["acs-connector-settings"] },
        kind: "config.change",
        description: "Set ACS config value " + parsed.key,
        params: {
          targetId: "acs-connector-settings",
          patch: [{ op: "replace", path: "/" + parsed.key, value: parsed.value }],
          reason: parsed.reason,
          registryActionId: "acs.config.change",
          registryVersion: "1.0"
        },
        risk: "high"
      });
    },
    shutdown: (input) =>
      createProcessWorkItem(input, "system.shutdown", "acs.system.shutdown", "Request ACS device shutdown", "critical"),
    start_process: (input) => {
      const parsed = processStartSchema.parse(input);
      assertRegisteredCommand(parsed.command);
      return create(input, {
        title: "Start registered process " + parsed.command,
        intent: "Start one fixed registered ACS command under worker supervision",
        kind: "process.start",
        description: "Start registered process " + parsed.command,
        params: {
          commandId: parsed.command,
          timeoutMs: parsed.timeout_ms,
          shell: parsed.shell,
          verboseTiming: parsed.verbose_timing,
          registryActionId: "acs.process.start",
          registryVersion: "1.0"
        },
        risk: "high"
      });
    },
    start_search: (input) => {
      const parsed = desktopSearchSchema.parse(input);
      assertRegisteredRoot(parsed.rootId);
      return create(input, {
        title: "Search " + parsed.pattern,
        intent: "Search an allowlisted ACS path with bounded results",
        kind: "fs.search_name",
        description: "Search " + parsed.pattern,
        params: {
          rootId: parsed.rootId,
          relativePath: parsed.path,
          paths: [parsed.path],
          pattern: parsed.pattern,
          searchType: parsed.searchType,
          filePattern: parsed.filePattern,
          ignoreCase: parsed.ignoreCase,
          maxResults: parsed.maxResults,
          includeHidden: parsed.includeHidden,
          contextLines: parsed.contextLines,
          timeoutMs: parsed.timeout_ms,
          literalSearch: parsed.literalSearch,
          registryActionId: "acs.filesystem.search",
          registryVersion: "1.0"
        },
        risk: "low"
      });
    },
    stop_search: (input) => {
      const parsed = searchPageSchema.parse(input);
      const envelope = getWorkItemEnvelope(options.store, policy, parsed.sessionId, parsed.actor);
      const workItem = workItemTools.cancel_work_item({ id: envelope.workItem.id, actor: parsed.actor });
      return { sessionId: parsed.sessionId, workItem };
    },
    who_am_i: (input) => {
      const parsed = actorSchema.parse(input);
      const actor = options.store.listActors().find((entry) => entry.id === parsed.actor);
      return {
        actor: parsed.actor,
        registered: Boolean(actor),
        identity: actor ?? { id: parsed.actor, actorType: "MCP" }
      };
    },
    write_file: (input) => {
      const parsed = desktopWriteSchema.parse(input);
      assertRegisteredRoot(parsed.rootId);
      return create(input, {
        title: "Write file " + parsed.path,
        intent: "Write bounded content inside the registered ACS filesystem root",
        kind: "fs.write",
        description: "Write file " + parsed.path,
        params: {
          rootId: parsed.rootId,
          relativePath: parsed.path,
          paths: [parsed.path],
          content: typeof parsed.content === "string" ? parsed.content : JSON.stringify(parsed.content),
          mode: parsed.mode,
          operation: "write_file",
          registryActionId: "acs.filesystem.write_file",
          registryVersion: "1.0"
        },
        risk: "high"
      });
    },
    write_pdf: (input) => {
      const parsed = desktopPdfSchema.parse(input);
      assertRegisteredRoot(parsed.rootId);
      return create(input, {
        title: "Write PDF " + (parsed.outputPath ?? parsed.path),
        intent: "Create a bounded PDF inside the registered ACS filesystem root",
        kind: "fs.write",
        description: "Write PDF " + (parsed.outputPath ?? parsed.path),
        params: {
          rootId: parsed.rootId,
          path: parsed.path,
          outputPath: parsed.outputPath,
          content: typeof parsed.content === "string" ? parsed.content : JSON.stringify(parsed.content),
          operation: "write_pdf",
          paths: [parsed.outputPath ?? parsed.path],
          registryActionId: "acs.filesystem.write_pdf",
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
    model: "qwen2.5-coder:7b",
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

function paginateSearchResult(
  envelope: ReturnType<typeof workItemEnvelope>,
  sessionId: string,
  offset: number,
  length: number
): Record<string, unknown> {
  const rawOutput = envelope.workItem.result?.output;
  if (envelope.workItem.status !== "succeeded" || typeof rawOutput !== "string") {
    return { sessionId, status: envelope.workItem.status, workItem: envelope.workItem };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    return { sessionId, status: envelope.workItem.status, offset, length, results: [], rawOutput };
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as Record<string, unknown>).matches)) {
    return { sessionId, status: envelope.workItem.status, offset, length, results: [] };
  }
  const matches = (parsed as { matches: unknown[] }).matches;
  return {
    sessionId,
    status: envelope.workItem.status,
    offset,
    length,
    total: matches.length,
    results: matches.slice(offset, offset + length)
  };
}

function redactConnectorEvent(event: {
  name: string;
  timeUnixNano: string;
  attributes: Record<string, string | number | boolean>;
  body: unknown;
}): Record<string, unknown> {
  return {
    name: event.name,
    timeUnixNano: event.timeUnixNano,
    attributes: redactValue(event.attributes),
    body: redactValue(event.body)
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

function leaseFromEvents(
  events: Array<{ name: string; body: Record<string, unknown> }>
): Record<string, unknown> | undefined {
  const running = [...events].reverse().find((event) => event.name === "work_item.running");
  if (!running) return undefined;
  const terminal = [...events]
    .reverse()
    .find((event) =>
      ["work_item.succeeded", "work_item.failed", "work_item.blocked", "work_item.cancelled"].includes(event.name)
    );
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
      throw new ControlStackError(
        "action_registry_required",
        "connector actions require a registryActionId and registryVersion"
      );
    }
    if (
      !connectorActionRegistry.some(
        (entry) => entry.id === actionId && entry.version === version && entry.kind === action.kind
      )
    ) {
      throw new ControlStackError(
        "action_registry_mismatch",
        `connector action is not registered: ${actionId}@${version}`
      );
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
