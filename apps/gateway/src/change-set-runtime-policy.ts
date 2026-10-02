import { ControlStackError } from "@agent-control-stack/shared";
import {
  normalizeInvocation,
  desktopCommanderInvocationFingerprint,
  desktopCommanderRequiredScopes,
  validateJaceCommanderInvocation,
  containJaceCommanderInvocation,
  containPath,
  validateProcessCommand,
  type ContainmentConfig,
  type DesktopCommanderToolPolicy
} from "@agent-control-stack/desktop-commander-adapter";
import { changeSetPrivilegeSchema, type ChangeSetDefinition, type WorkItem } from "@agent-control-stack/work-items";
import type { CanonicalChangeSetOperation } from "@agent-control-stack/policy-gate";

export function dcWorkItemActionKind(policy: DesktopCommanderToolPolicy) {
  if (policy.commandArgs.length > 0 || (policy.argvArgs?.length ?? 0) > 0) return "cmd.run";
  if (policy.name === "list_directory") return "fs.list";
  if (policy.name === "get_file_info") return "fs.stat";
  if (policy.name === "edit_block") return "fs.patch";
  if (policy.name === "move_file") return "fs.move";
  if (policy.mutating) return "fs.write";
  return "fs.read";
}

export function resolveChangeSetRuntimePolicy(input: {
  operation: ChangeSetDefinition["operations"][number];
  mission: WorkItem;
  actorId: string;
  dcContainment?: ContainmentConfig;
  jcContainment?: ContainmentConfig;
}): CanonicalChangeSetOperation {
  const { operation, mission, actorId } = input;
  const base = {
    workItemId: mission.id,
    actor: actorId,
    operation: "create" as const,
    requester: mission.requester,
    ...(mission.requesterSubject ? { requesterSubject: mission.requesterSubject } : {})
  };
  if (operation.runtime === "desktop_commander") {
    if (!input.dcContainment)
      throw new ControlStackError("desktop_commander_containment_unconfigured", "DC containment missing");
    const invocation = normalizeInvocation(operation.toolName, operation.action.params, input.dcContainment);
    const policy = invocation.policy;
    const privileges = desktopCommanderRequiredScopes(operation.toolName).map((scope) =>
      changeSetPrivilegeSchema.parse(scope)
    );
    const cwd =
      typeof invocation.validatedArguments.cwd === "string"
        ? invocation.validatedArguments.cwd
        : input.dcContainment.allowedRoots[0];
    const commandKey = policy.commandArgs[0];
    const argvKey = policy.argvArgs?.[0];
    const rawCommand = commandKey ? operation.action.params[commandKey] : undefined;
    const rawArgv = argvKey ? operation.action.params[argvKey] : undefined;
    // normalizeInvocation validates the original input and resolves executables
    // to absolute paths. Evaluate the original named command with the same
    // validator rather than treating that resolved path as new user input.
    // It also rejects argv entries containing whitespace before this join.
    const commandLine =
      typeof rawCommand === "string" ? rawCommand : Array.isArray(rawArgv) ? rawArgv.join(" ") : undefined;
    const command =
      commandLine !== undefined ? validateProcessCommand(commandLine, input.dcContainment, cwd) : undefined;
    const invocationHash = desktopCommanderInvocationFingerprint(invocation);
    return {
      invocationHash,
      privileges,
      resources: invocation.canonicalPaths.map((id) => ({ kind: "path", id })),
      effect: policy.destructive ? "privileged" : policy.mutating ? "mutation" : "read_only",
      context: {
        ...base,
        risk: (
          { read_only: "low", safe_mutation: "medium", requires_approval: "high", destructive: "critical" } as const
        )[policy.riskClass],
        action: {
          kind: dcWorkItemActionKind(policy),
          description: `Desktop Commander tool ${operation.toolName}`,
          params: { invocationHash }
        },
        ...(cwd ? { cwd } : {}),
        paths: invocation.canonicalPaths,
        write: policy.mutating,
        network: policy.network,
        destructive: policy.destructive,
        ...(command ? { command: [command.executable, ...command.args] } : {})
      }
    };
  }
  if (operation.runtime === "jace_commander") {
    const invocation = validateJaceCommanderInvocation(operation.toolName, operation.action.params);
    const privileged = invocation.policy.scopes.includes("process.privileged");
    if (invocation.policy.pathArguments.length > 0) {
      if (!input.jcContainment)
        throw new ControlStackError("jace_commander_containment_unconfigured", "JC containment missing");
      containJaceCommanderInvocation(invocation, input.jcContainment);
    }
    const resources = invocation.policy.pathArguments.flatMap((key) => {
      const value = invocation.arguments[key];
      const paths = Array.isArray(value) ? value : [value];
      return paths.map((requested) => ({
        kind: "path" as const,
        id: containPath(input.jcContainment!, requested as string).canonical
      }));
    });
    // The privileged helper defaults cwd to /. Include that implicit resource
    // even though its manifest permits execution beyond ordinary filesystem tools.
    if (privileged) {
      if (!input.jcContainment)
        throw new ControlStackError("jace_commander_containment_unconfigured", "JC containment missing");
      const cwd = typeof invocation.arguments.cwd === "string" ? invocation.arguments.cwd : "/";
      const canonical = containPath(input.jcContainment, cwd).canonical;
      if (!resources.some((resource) => resource.id === canonical)) resources.push({ kind: "path", id: canonical });
    }
    const mutation =
      privileged || invocation.policy.requiresApproval || invocation.policy.scopes.includes("integration.write");
    return {
      invocationHash: invocation.invocationHash,
      resources,
      privileges: invocation.policy.scopes.map((scope) => changeSetPrivilegeSchema.parse(scope)),
      effect: privileged ? "privileged" : mutation ? "mutation" : "read_only",
      context: {
        ...base,
        risk: invocation.policy.risk,
        action: {
          kind: invocation.policy.actionKind,
          description: `Jace Commander tool ${operation.toolName}`,
          params: { invocationHash: invocation.invocationHash }
        },
        write: privileged || invocation.policy.actionKind === "jc.integration.write",
        network: false
      }
    };
  }
  throw new ControlStackError("change_set_runtime_unsupported", "runtime has no canonical Change Set policy adapter");
}
