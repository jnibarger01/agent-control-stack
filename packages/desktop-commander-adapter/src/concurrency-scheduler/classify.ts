import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, sep } from "node:path";
import type { NormalizedInvocation } from "../arguments.js";
import type { ContainmentConfig } from "../containment.js";
import type {
  ExecutionEffect,
  ExecutionIntent,
  ExecutionLane,
  ExecutionPriority,
  ResourceClaim
} from "./types.js";

export interface DesktopCommanderIntentInput {
  requestId: string;
  agentId: string;
  sessionId: string;
  invocation: NormalizedInvocation;
  containment?: Pick<ContainmentConfig, "allowedRoots">;
  priority?: ExecutionPriority;
  deadlineAt?: number;
}

export function classifyDesktopCommanderExecution(
  input: DesktopCommanderIntentInput
): ExecutionIntent {
  const { invocation } = input;
  const base = {
    requestId: input.requestId,
    agentId: input.agentId,
    sessionId: input.sessionId,
    tool: invocation.toolName,
    normalizedArguments: invocation.validatedArguments,
    priority: input.priority ?? ("normal" as const),
    deadlineAt: input.deadlineAt,
    executionTimeoutMs: invocation.policy.timeoutMs
  };
  const allowedRoots = input.containment?.allowedRoots;
  const classified =
    invocation.toolName === "start_process"
      ? classifyProcess(invocation.validatedArguments, allowedRoots)
      : classifyTool(invocation, allowedRoots);
  return {
    ...base,
    ...classified,
    resources: dedupeClaims(classified.resources)
  };
}

interface Classification {
  lane: ExecutionLane;
  effects: ExecutionEffect;
  resources: ResourceClaim[];
  cost: { cpu: number; memory: number; io: number };
}

function classifyTool(
  invocation: NormalizedInvocation,
  allowedRoots?: readonly string[]
): Classification {
  const args = invocation.validatedArguments;
  const paths = invocation.canonicalPaths;
  switch (invocation.toolName) {
    case "read_file":
    case "get_file_info":
      return readFiles(paths, allowedRoots);
    case "read_multiple_files":
      return readFiles(paths, allowedRoots);
    case "list_directory":
      return {
        lane: "read",
        effects: "read_only",
        resources: [
          ...repositoryClaims(paths, allowedRoots),
          ...paths.map((path) => ({ key: `dir:${path}`, mode: "shared" as const }))
        ],
        cost: { cpu: 1, memory: 1, io: 1 }
      };
    case "start_search":
    case "search_code":
      return {
        lane: "search",
        effects: "read_only",
        resources: [
          ...repositoryClaims(paths, allowedRoots),
          ...paths.map((path) => ({ key: `dir:${path}`, mode: "shared" as const }))
        ],
        cost: { cpu: 2, memory: 2, io: 2 }
      };
    case "get_more_search_results":
    case "list_searches":
    case "stop_search":
      return {
        lane: "search",
        effects: "read_only",
        resources: [{ key: "host:desktop-commander-search", mode: "shared" }],
        cost: { cpu: 1, memory: 1, io: 1 }
      };
    case "read_process_output": {
      const pid = args.pid;
      return {
        lane: "read",
        effects: "read_only",
        resources:
          typeof pid === "number"
            ? [{ key: `process:${pid}`, mode: "shared" }]
            : [],
        cost: { cpu: 1, memory: 1, io: 1 }
      };
    }
    case "get_config":
    case "get_runtime_identity":
    case "list_sessions":
    case "list_processes":
    case "get_usage_stats":
      return {
        lane: "read",
        effects: "read_only",
        resources: [{ key: "host:desktop-commander", mode: "shared" }],
        cost: { cpu: 1, memory: 1, io: 1 }
      };
    case "create_directory":
      return mutateDirectories(paths, allowedRoots);
    case "write_file":
    case "edit_block":
      return mutateFiles(paths, allowedRoots);
    case "move_file":
      return moveFiles(paths, allowedRoots);
    default:
      return {
        lane: "mutation",
        effects: "host_mutation",
        resources: [{ key: "host:desktop-commander", mode: "exclusive" }],
        cost: { cpu: 3, memory: 3, io: 3 }
      };
  }
}

function readFiles(
  paths: readonly string[],
  allowedRoots?: readonly string[]
): Classification {
  return {
    lane: "read",
    effects: "read_only",
    resources: [
      ...repositoryClaims(paths, allowedRoots),
      ...paths.map((path) => ({ key: `file:${path}`, mode: "shared" as const }))
    ],
    cost: { cpu: 1, memory: 1, io: 1 }
  };
}

function mutateFiles(
  paths: readonly string[],
  allowedRoots?: readonly string[]
): Classification {
  const resources: ResourceClaim[] = [...repositoryClaims(paths, allowedRoots)];
  for (const path of paths) {
    resources.push({ key: `file:${path}`, mode: "exclusive" });
  }
  return {
    lane: "mutation",
    effects: "workspace_mutation",
    resources,
    cost: { cpu: 1, memory: 1, io: 2 }
  };
}

function moveFiles(
  paths: readonly string[],
  allowedRoots?: readonly string[]
): Classification {
  const resources: ResourceClaim[] = [...repositoryClaims(paths, allowedRoots)];
  for (const path of paths) {
    resources.push({ key: `file:${path}`, mode: "exclusive" });
    resources.push({ key: `dir:${dirname(path)}`, mode: "exclusive" });
  }
  return {
    lane: "mutation",
    effects: "workspace_mutation",
    resources,
    cost: { cpu: 1, memory: 1, io: 2 }
  };
}

function mutateDirectories(
  paths: readonly string[],
  allowedRoots?: readonly string[]
): Classification {
  const resources: ResourceClaim[] = [...repositoryClaims(paths, allowedRoots)];
  for (const path of paths) {
    resources.push({ key: `dir:${path}`, mode: "exclusive" });
    resources.push({ key: `dir:${dirname(path)}`, mode: "exclusive" });
  }
  return {
    lane: "mutation",
    effects: "workspace_mutation",
    resources,
    cost: { cpu: 1, memory: 1, io: 2 }
  };
}

function classifyProcess(
  args: Readonly<Record<string, unknown>>,
  allowedRoots?: readonly string[]
): Classification {
  const cwd = typeof args.cwd === "string" ? args.cwd : "<unknown>";
  const command = typeof args.command === "string" ? args.command.trim() : "";
  const tokens = command.split(/\s+/u).filter(Boolean);
  const executable = basename(tokens[0] ?? "");
  const subcommand = tokens[1] ?? "";
  const repositoryRoot = findRepositoryRoot(cwd, allowedRoots) ?? cwd;
  const repo = `repo:${repositoryRoot}`;

  if (executable === "git" && ["status", "diff", "log", "show"].includes(subcommand)) {
    return {
      lane: "read",
      effects: "read_only",
      resources: [{ key: repo, mode: "shared" }],
      cost: { cpu: 1, memory: 1, io: 1 }
    };
  }

  if (
    executable === "git" &&
    ["commit", "push", "merge", "rebase", "checkout", "switch"].includes(subcommand)
  ) {
    return {
      lane: "mutation",
      effects: "workspace_mutation",
      resources: [
        { key: repo, mode: "exclusive" },
        { key: `git:${cwd}`, mode: "exclusive" }
      ],
      cost: { cpu: 2, memory: 1, io: 2 }
    };
  }

  if (
    (executable === "npm" && ["install", "i", "update"].includes(subcommand)) ||
    (executable === "pnpm" && ["add", "install", "update"].includes(subcommand))
  ) {
    return {
      lane: "mutation",
      effects: "workspace_mutation",
      resources: [
        { key: repo, mode: "exclusive" },
        { key: `package-manager:${cwd}`, mode: "exclusive" }
      ],
      cost: { cpu: 3, memory: 3, io: 3 }
    };
  }

  if (
    (executable === "npm" && ["test", "run"].includes(subcommand)) ||
    (executable === "pnpm" && ["test", "run"].includes(subcommand)) ||
    (executable === "bun" && subcommand === "test")
  ) {
    return {
      lane: "process",
      effects: "workspace_mutation",
      resources: [
        { key: repo, mode: "exclusive" },
        { key: `workspace-run:${cwd}`, mode: "exclusive" }
      ],
      cost: { cpu: 3, memory: 3, io: 2 }
    };
  }

  if (executable === "systemctl" && ["restart", "stop", "start"].includes(subcommand)) {
    const service = tokens[2] ?? "<unknown>";
    return {
      lane: "mutation",
      effects: "host_mutation",
      resources: [
        { key: "host:desktop-commander", mode: "exclusive" },
        { key: `service:${service}`, mode: "exclusive" }
      ],
      cost: { cpu: 2, memory: 1, io: 1 }
    };
  }

  if (
    executable === "docker" &&
    ["restart", "stop", "rm", "run", "compose"].includes(subcommand)
  ) {
    return {
      lane: "mutation",
      effects: "host_mutation",
      resources: [{ key: "host:desktop-commander", mode: "exclusive" }],
      cost: { cpu: 3, memory: 3, io: 2 }
    };
  }

  return {
    lane: "process",
    effects: "read_only",
    resources: [
      { key: repo, mode: "shared" },
      { key: "host:desktop-commander", mode: "shared" }
    ],
    cost: { cpu: 1, memory: 1, io: 1 }
  };
}

function repositoryClaims(
  paths: readonly string[],
  allowedRoots?: readonly string[]
): ResourceClaim[] {
  const roots = new Set<string>();
  for (const path of paths) {
    const root = findRepositoryRoot(path, allowedRoots);
    if (root) roots.add(root);
  }
  return [...roots]
    .sort((left, right) => left.localeCompare(right))
    .map((root) => ({ key: `repo:${root}`, mode: "shared" as const }));
}

function findRepositoryRoot(
  path: string,
  allowedRoots?: readonly string[]
): string | undefined {
  const boundary = containingRoot(path, allowedRoots);
  let current = path;
  if (!existsSync(current) || !existsSync(join(current, ".git"))) {
    current = dirname(current);
  }
  const stop = boundary ?? parse(current).root;
  while (containsPath(stop, current)) {
    if (existsSync(join(current, ".git"))) return current;
    if (current === stop) break;
    const parent = dirname(current);
    if (parent === current || !containsPath(stop, parent)) break;
    current = parent;
  }
  return undefined;
}

function containingRoot(
  path: string,
  allowedRoots?: readonly string[]
): string | undefined {
  if (!allowedRoots?.length) return undefined;
  return [...allowedRoots]
    .filter((root) => containsPath(root, path))
    .sort((left, right) => right.length - left.length)[0];
}

function containsPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function dedupeClaims(claims: readonly ResourceClaim[]): ResourceClaim[] {
  const modes = new Map<string, ResourceClaim["mode"]>();
  for (const claim of claims) {
    const current = modes.get(claim.key);
    if (current === "exclusive") continue;
    modes.set(claim.key, claim.mode === "exclusive" ? "exclusive" : current ?? "shared");
  }
  return [...modes.entries()]
    .map(([key, mode]) => ({ key, mode }))
    .sort((left, right) => left.key.localeCompare(right.key));
}
