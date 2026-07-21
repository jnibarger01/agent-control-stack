import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  applyRegisteredConfigChange,
  createDirectory,
  editTextBlock,
  executeRegisteredServiceRestart,
  listFiles,
  movePath,
  previewRegisteredCommand,
  previewRegisteredConfigChange,
  previewRegisteredServiceRestart,
  readMultipleTextFiles,
  readTextFile,
  resolveRegisteredRoot,
  runReadonlyCommand,
  runRegisteredCommand,
  searchFiles,
  statPath,
  writePdfFile,
  writeTextFile,
  type MachineControllerConfig
} from "@agent-control-stack/machine-controller";
import { executeAgentSandboxed, executeSandboxed } from "@agent-control-stack/sandbox";
import { redactValue } from "@agent-control-stack/shared";
import { type ActionRequest, type EvidenceRecord, type WorkItem } from "@agent-control-stack/work-items";
import {
  interactWithManagedProcess,
  listManagedProcesses,
  readManagedProcessOutput,
  shutdownManagedDevice,
  startManagedProcess,
  terminateManagedProcess
} from "./process-sessions.js";

export interface WorkerActionResult {
  ok: boolean;
  executionMode: "dry_run" | "controlled_action" | "sandboxed_agent" | "not_started";
  output: string;
  error?: string;
  stderr?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  agent?: string;
  provider?: string;
  model?: string;
  workspaceBeforeHash?: string;
  workspaceAfterHash?: string;
  changedPaths?: string[];
  sandboxIdentity?: string;
  repositoryCommit?: string;
  repositoryWorktreeState?: string;
  evidence?: EvidenceRecord[];
}

export async function executeWorkerAction(
  workItem: WorkItem,
  config: MachineControllerConfig,
  executorId: string
): Promise<WorkerActionResult> {
  if (workItem.requestedActions.length !== 1) {
    return failed("not_started", "worker execution requires exactly one registered action", executorId);
  }
  const action = workItem.requestedActions[0];
  if (!action) {
    return failed("not_started", "work item has no action", executorId);
  }

  try {
    return await dispatchAction(workItem, action, config, executorId);
  } catch (error) {
    return failed(
      "not_started",
      error instanceof Error ? error.message : "registered worker action failed",
      executorId,
      action.kind
    );
  }
}

async function dispatchAction(
  workItem: WorkItem,
  action: ActionRequest,
  config: MachineControllerConfig,
  executorId: string
): Promise<WorkerActionResult> {
  const params = action.params;
  switch (action.kind) {
    case "cmd.preview": {
      const preview = previewRegisteredCommand(config, {
        commandId: stringParam(params, "commandId"),
        rootId: optionalStringParam(params, "rootId") ?? "acs-repo"
      });
      return success("dry_run", JSON.stringify(preview), executorId, "command", preview);
    }
    case "cmd.run": {
      const result = await runRegisteredCommand(config, {
        commandId: stringParam(params, "commandId"),
        rootId: optionalStringParam(params, "rootId") ?? "acs-repo"
      });
      const output = JSON.stringify(result);
      return {
        ...success("controlled_action", output, executorId, "command", result),
        exitCode: result.result.exitCode,
        stderr: result.result.stderr
      };
    }
    case "fs.read": {
      const root = resolveRegisteredRoot(config, optionalStringParam(params, "rootId") ?? "acs-repo");
      const result =
        Array.isArray(params.paths) && params.operation === "read_multiple"
          ? readMultipleTextFiles(config, {
              paths: params.paths.map((path) => join(root, stringParamValue(path))),
              offset: numberParam(params, "offset") ?? 0,
              length: numberParam(params, "length") ?? 1_000
            })
          : readTextFile(config, {
              path: join(root, stringParam(params, "relativePath") || firstPath(params)),
              start_line: numberParam(params, "startLine") ?? 1,
              ...(numberParam(params, "endLine") === undefined ? {} : { end_line: numberParam(params, "endLine") }),
              ...(numberParam(params, "offset") === undefined ? {} : { offset: numberParam(params, "offset") }),
              ...(numberParam(params, "length") === undefined ? {} : { length: numberParam(params, "length") })
            });
      return success(
        "controlled_action",
        result && typeof result === "object" && "text" in result && typeof result.text === "string"
          ? result.text
          : JSON.stringify(result),
        executorId,
        "filesystem",
        result
      );
    }
    case "fs.list": {
      const root = resolveRegisteredRoot(config, optionalStringParam(params, "rootId") ?? "acs-repo");
      const result = listFiles(config, {
        path: join(root, stringParam(params, "relativePath")),
        max_depth: numberParam(params, "maxDepth") ?? 2
      });
      return success("controlled_action", JSON.stringify(result), executorId, "filesystem", result);
    }
    case "fs.stat": {
      const root = resolveRegisteredRoot(config, optionalStringParam(params, "rootId") ?? "acs-repo");
      const relativePath = stringParam(params, "relativePath") || firstPath(params);
      const result = statPath(config, { path: join(root, relativePath) });
      return success("controlled_action", JSON.stringify(result), executorId, "filesystem", result);
    }
    case "fs.write": {
      const root = resolveRegisteredRoot(config, optionalStringParam(params, "rootId") ?? "acs-repo");
      const operation = optionalStringParam(params, "operation") ?? "write_file";
      const result =
        operation === "create_directory"
          ? createDirectory(config, { path: join(root, stringParam(params, "relativePath")) })
          : operation === "write_pdf"
            ? writePdfFile(config, {
                path: join(root, stringParam(params, "path")),
                ...(optionalStringParam(params, "outputPath")
                  ? { outputPath: join(root, stringParam(params, "outputPath")) }
                  : {}),
                content: stringParam(params, "content")
              })
            : writeTextFile(config, {
                path: join(root, stringParam(params, "relativePath")),
                content: stringParam(params, "content"),
                mode: (optionalStringParam(params, "mode") as "rewrite" | "append" | undefined) ?? "rewrite"
              });
      return success("controlled_action", JSON.stringify(result), executorId, "filesystem", result);
    }
    case "fs.patch": {
      const root = resolveRegisteredRoot(config, optionalStringParam(params, "rootId") ?? "acs-repo");
      const result = editTextBlock(config, {
        path: join(root, stringParam(params, "relativePath")),
        old_string: stringParam(params, "oldString"),
        new_string: stringParam(params, "newString"),
        expected_replacements: numberParam(params, "expectedReplacements") ?? 1
      });
      return success("controlled_action", JSON.stringify(result), executorId, "filesystem", result);
    }
    case "fs.move": {
      const root = resolveRegisteredRoot(config, optionalStringParam(params, "rootId") ?? "acs-repo");
      const result = movePath(config, {
        source: join(root, stringParam(params, "source")),
        destination: join(root, stringParam(params, "destination")),
        overwrite: params.overwrite === true
      });
      return success("controlled_action", JSON.stringify(result), executorId, "filesystem", result);
    }
    case "fs.search_name": {
      const root = resolveRegisteredRoot(config, optionalStringParam(params, "rootId") ?? "acs-repo");
      const result = searchFiles(config, {
        path: join(root, stringParam(params, "relativePath")),
        pattern: stringParam(params, "pattern"),
        searchType: optionalStringParam(params, "searchType") ?? "files",
        ...(optionalStringParam(params, "filePattern") ? { filePattern: stringParam(params, "filePattern") } : {}),
        ignoreCase: params.ignoreCase !== false,
        maxResults: numberParam(params, "maxResults") ?? 100,
        includeHidden: params.includeHidden === true,
        contextLines: numberParam(params, "contextLines") ?? 5,
        literalSearch: params.literalSearch === true,
        maxDepth: numberParam(params, "maxDepth") ?? 3
      });
      return success("controlled_action", JSON.stringify(result), executorId, "filesystem", result);
    }
    case "process.start": {
      const result = startManagedProcess(config, { commandId: stringParam(params, "commandId") });
      return success("controlled_action", JSON.stringify(result), executorId, "command", result);
    }
    case "process.interact": {
      const result = await interactWithManagedProcess(
        {
          pid: numberParam(params, "pid") ?? 0,
          input: stringParam(params, "input"),
          timeoutMs: numberParam(params, "timeout_ms") ?? 8_000
        },
        config
      );
      return success("controlled_action", JSON.stringify(result), executorId, "command", result);
    }
    case "process.output": {
      const result = await readManagedProcessOutput(
        {
          pid: numberParam(params, "pid") ?? 0,
          offset: numberParam(params, "offset") ?? 0,
          length: numberParam(params, "length") ?? 1_000,
          timeoutMs: numberParam(params, "timeout_ms") ?? 8_000
        },
        config
      );
      return success("controlled_action", JSON.stringify(result), executorId, "command", result);
    }
    case "process.kill":
    case "process.force_terminate": {
      const result = terminateManagedProcess({
        pid: numberParam(params, "pid") ?? 0,
        force: action.kind === "process.force_terminate"
      });
      return success("controlled_action", JSON.stringify(result), executorId, "command", result);
    }
    case "process.sessions": {
      const result = listManagedProcesses();
      return success("controlled_action", JSON.stringify(result), executorId, "command", result);
    }
    case "system.shutdown": {
      return shutdownManagedDevice();
    }
    case "agent.preview": {
      const prompt = stringParam(params, "prompt");
      const output = JSON.stringify({
        agent: "codex",
        provider: "codex-cli",
        permissionMode: "read-only",
        networkAccess: "none",
        timeoutMs: numberParam(params, "timeoutMs") ?? 900_000,
        promptHash: hashText(prompt)
      });
      return success("dry_run", `Codex preview: ${output}`, executorId, "agent", { promptHash: hashText(prompt) });
    }
    case "agent.prompt": {
      const root = resolveRegisteredRoot(config, optionalStringParam(params, "rootId") ?? "acs-repo");
      const executionParams: Record<string, unknown> = {
        agent: "codex",
        provider: params.provider,
        prompt: params.prompt,
        cwd: root,
        permissionMode: "read-only",
        timeoutMs: params.timeoutMs ?? 900_000,
        networkAccess: "none",
        expectedOutputs: params.expectedOutputs ?? []
      };
      if (params.model !== undefined) {
        executionParams.model = params.model;
      }
      const executionWorkItem: WorkItem = {
        ...workItem,
        target: { ...workItem.target, cwd: root },
        requestedActions: [{ ...action, params: executionParams }]
      };
      const result = await executeAgentSandboxed(executionWorkItem, {
        enabled: process.env.ACS_AGENT_EXECUTION_MODE === "codex-bubblewrap"
      });
      const repository = await repositoryEvidence(config, root);
      const output = result.output ?? "";
      return {
        ok: result.ok,
        executionMode: result.executionMode,
        output,
        ...(result.error ? { error: result.error } : {}),
        ...(result.stderr ? { stderr: result.stderr } : {}),
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        ...(result.timedOut !== undefined ? { timedOut: result.timedOut } : {}),
        ...(result.agent ? { agent: result.agent } : {}),
        ...(result.provider ? { provider: result.provider } : {}),
        ...(result.model ? { model: result.model } : {}),
        ...(result.workspaceBeforeHash ? { workspaceBeforeHash: result.workspaceBeforeHash } : {}),
        ...(result.workspaceAfterHash ? { workspaceAfterHash: result.workspaceAfterHash } : {}),
        ...(result.changedPaths ? { changedPaths: result.changedPaths } : {}),
        ...(result.sandboxIdentity ? { sandboxIdentity: result.sandboxIdentity } : {}),
        ...(repository.commit ? { repositoryCommit: repository.commit } : {}),
        ...(repository.worktreeState !== undefined ? { repositoryWorktreeState: repository.worktreeState } : {}),
        evidence: [
          makeEvidence("agent", "Codex response", output, executorId, { provider: result.provider ?? "codex-cli" })
        ]
      };
    }
    case "service.restart.preview": {
      const preview = previewRegisteredServiceRestart(config, { serviceId: stringParam(params, "serviceId") });
      return success("dry_run", JSON.stringify(preview), executorId, "service", preview);
    }
    case "service.restart": {
      const result = await executeRegisteredServiceRestart(config, { serviceId: stringParam(params, "serviceId") });
      const output = JSON.stringify(result);
      const base = success(result.ok ? "controlled_action" : "not_started", output, executorId, "service", result);
      return {
        ...base,
        ok: result.ok,
        ...(result.ok ? {} : { error: "service health check failed after restart" }),
        exitCode: result.exitCode
      };
    }
    case "config.change.preview": {
      const preview = previewRegisteredConfigChange(config, {
        targetId: stringParam(params, "targetId"),
        patch: params.patch
      });
      return success("dry_run", JSON.stringify(preview), executorId, "config", preview);
    }
    case "config.change": {
      const result = applyRegisteredConfigChange(config, {
        targetId: stringParam(params, "targetId"),
        patch: params.patch,
        ...(typeof params.expectedCurrentHash === "string" ? { expectedCurrentHash: params.expectedCurrentHash } : {})
      });
      return success("controlled_action", JSON.stringify(result), executorId, "config", result);
    }
    default: {
      const result = await executeSandboxed(workItem);
      return {
        ok: result.ok,
        executionMode: result.executionMode,
        output: result.output,
        ...(result.error ? { error: result.error } : {}),
        ...(result.sandboxIdentity ? { sandboxIdentity: result.sandboxIdentity } : {}),
        evidence: [makeEvidence("summary", "Dry-run result", result.output, executorId, { action: action.kind })]
      };
    }
  }
}

function success(
  executionMode: "dry_run" | "controlled_action" | "sandboxed_agent" | "not_started",
  output: string,
  executorId: string,
  evidenceType: EvidenceRecord["evidence_type"],
  metadata: unknown
): WorkerActionResult {
  return {
    ok: true,
    executionMode,
    output,
    sandboxIdentity: ["dry_run", "controlled_action"].includes(executionMode)
      ? "acs-worker-registered-action"
      : undefined,
    evidence: [makeEvidence(evidenceType, `${evidenceType} result`, output, executorId, metadata)]
  };
}

function failed(
  executionMode: "dry_run" | "controlled_action" | "sandboxed_agent" | "not_started",
  error: string,
  executorId: string,
  evidenceType = "summary"
): WorkerActionResult {
  const type = ["command", "filesystem", "agent", "service", "config", "verification", "summary"].includes(evidenceType)
    ? (evidenceType as EvidenceRecord["evidence_type"])
    : "summary";
  return {
    ok: false,
    executionMode,
    output: "",
    error,
    evidence: [makeEvidence(type, "worker error", error, executorId, {})]
  };
}

function makeEvidence(
  evidenceType: EvidenceRecord["evidence_type"],
  label: string,
  rawContent: string,
  executorId: string,
  metadata: unknown
): EvidenceRecord {
  const safe = redactValue(rawContent);
  const unbounded = typeof safe === "string" ? safe : JSON.stringify(safe);
  const content = unbounded.slice(0, 20_000);
  return {
    evidence_id: `ev_${hashText(`${executorId}:${label}:${content}`).slice(0, 24)}`,
    evidence_type: evidenceType,
    label,
    content,
    content_hash: hashText(content),
    size_bytes: Buffer.byteLength(content, "utf8"),
    redacted: content !== rawContent,
    truncated: content.length < unbounded.length,
    executor_id: executorId,
    created_at: new Date().toISOString(),
    metadata: metadata && typeof metadata === "object" ? (redactValue(metadata) as Record<string, unknown>) : {}
  };
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`worker action parameter is required: ${key}`);
  }
  return value;
}

function stringParamValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("worker filesystem action paths must be non-empty strings");
  }
  return value;
}

function optionalStringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberParam(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function firstPath(params: Record<string, unknown>): string {
  const paths = params.paths;
  if (Array.isArray(paths) && typeof paths[0] === "string") return paths[0];
  throw new Error("worker filesystem action requires relativePath");
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function repositoryEvidence(
  config: MachineControllerConfig,
  root: string
): Promise<{ commit?: string; worktreeState?: string }> {
  try {
    const commit = await runReadonlyCommand(config, { cwd: root, command: "git", args: ["rev-parse", "HEAD"] });
    const state = await runReadonlyCommand(config, {
      cwd: root,
      command: "git",
      args: ["status", "--porcelain", "--untracked-files=no"]
    });
    return {
      ...(commit.exitCode === 0 ? { commit: commit.stdout.trim() } : {}),
      worktreeState: state.exitCode === 0 ? state.stdout.trim() : `git status failed (${state.exitCode ?? "unknown"})`
    };
  } catch {
    return {};
  }
}
