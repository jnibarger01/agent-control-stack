export const ACS_CLI_VERSION = "0.1.0-alpha";

export const ACS_HELP = `Usage: acs [--version] [--help] <command> [args]

Commands:
  actor list --available [--json]
  worker [run]
  scheduler [run]
  mcp [serve] [--config <path>]
  gateway [serve]
  skills list
  skills show <skill>
  skills history <skill>
  skills candidates
  skills usages <skill>
  skills quarantine <skill>
  skills retrieve --problem <text>
  skills targets
  status [--json]
  doctor [--json]
  publication list [--json]
  audit export [--db <path>] [-o <file>]
  audit verify (--file <jsonl> | [--db <path>])

Legacy binaries remain available: acs-worker, acs-scheduler, acs-mcp, acs-gateway.
`;

export type AcsCommand =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "actor-list-available"; json: boolean }
  | { kind: "worker"; forwarded: string[] }
  | { kind: "scheduler"; forwarded: string[] }
  | { kind: "mcp"; forwarded: string[] }
  | { kind: "gateway"; forwarded: string[] }
  | { kind: "status"; json: boolean }
  | { kind: "doctor"; json: boolean }
  | { kind: "publication-list"; json: boolean }
  | { kind: "audit-export"; dbPath?: string; outputPath?: string }
  | { kind: "audit-verify"; dbPath?: string; filePath?: string }
  | { kind: "skills"; args: string[] };

export class AcsUsageError extends Error {
  readonly usage = true;
}

function takeOptionalRun(args: string[], command: string): string[] {
  if (args[0] === "run") {
    return args.slice(1);
  }
  if (args[0] === "serve") {
    throw new AcsUsageError(`acs ${command} does not accept "serve"; use acs ${command} [run]`);
  }
  return args;
}

function takeOptionalServe(args: string[], command: string): string[] {
  if (args[0] === "serve") {
    return args.slice(1);
  }
  if (args[0] === "run") {
    throw new AcsUsageError(`acs ${command} does not accept "run"; use acs ${command} [serve]`);
  }
  return args;
}

function parseActorArgs(args: string[]): AcsCommand {
  if (args[0] !== "list") {
    throw new AcsUsageError("Usage: acs actor list --available [--json]");
  }
  let available = false;
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--available") {
      available = true;
    } else if (flag === "--json") {
      json = true;
    } else {
      throw new AcsUsageError(`invalid actor argument: ${flag}`);
    }
  }
  if (!available) {
    throw new AcsUsageError("acs actor list requires --available");
  }
  return { kind: "actor-list-available", json };
}

function parseMcpArgs(args: string[]): AcsCommand {
  const forwarded = takeOptionalServe(args, "mcp");
  for (let index = 0; index < forwarded.length; index += 1) {
    const flag = forwarded[index];
    if (flag === "--config") {
      if (!forwarded[index + 1]) {
        throw new AcsUsageError("acs mcp --config requires a path");
      }
      index += 1;
      continue;
    }
    throw new AcsUsageError(`invalid mcp argument: ${flag}`);
  }
  return { kind: "mcp", forwarded };
}

function rejectUnexpectedArgs(command: string, args: string[]): string[] {
  if (args.length > 0) {
    throw new AcsUsageError(`invalid ${command} argument: ${args[0]}`);
  }
  return args;
}

function parseStatusArgs(command: "status" | "doctor", args: string[]): AcsCommand {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--json"))
    throw new AcsUsageError(`Usage: acs ${command} [--json]`);
  return { kind: command, json: args[0] === "--json" };
}

function parsePublicationArgs(args: string[]): AcsCommand {
  if (args[0] !== "list" || args.length > 2 || (args[1] && args[1] !== "--json"))
    throw new AcsUsageError("Usage: acs publication list [--json]");
  return { kind: "publication-list", json: args[1] === "--json" };
}

function parseAuditArgs(args: string[]): AcsCommand {
  const sub = args[0];
  if (sub === "export") {
    let dbPath: string | undefined;
    let outputPath: string | undefined;
    for (let index = 1; index < args.length; index += 1) {
      const flag = args[index];
      if (flag === "--db") {
        const value = args[index + 1];
        if (!value) throw new AcsUsageError("acs audit export --db requires a path");
        dbPath = value;
        index += 1;
      } else if (flag === "-o" || flag === "--output") {
        const value = args[index + 1];
        if (!value) throw new AcsUsageError(`acs audit export ${flag} requires a path`);
        outputPath = value;
        index += 1;
      } else {
        throw new AcsUsageError(`invalid audit export argument: ${flag}`);
      }
    }
    return { kind: "audit-export", dbPath, outputPath };
  }
  if (sub === "verify") {
    let dbPath: string | undefined;
    let filePath: string | undefined;
    for (let index = 1; index < args.length; index += 1) {
      const flag = args[index];
      if (flag === "--db") {
        const value = args[index + 1];
        if (!value) throw new AcsUsageError("acs audit verify --db requires a path");
        dbPath = value;
        index += 1;
      } else if (flag === "--file") {
        const value = args[index + 1];
        if (!value) throw new AcsUsageError("acs audit verify --file requires a path");
        filePath = value;
        index += 1;
      } else {
        throw new AcsUsageError(`invalid audit verify argument: ${flag}`);
      }
    }
    if (dbPath && filePath) {
      throw new AcsUsageError("acs audit verify accepts either --file or --db, not both");
    }
    return { kind: "audit-verify", dbPath, filePath };
  }
  throw new AcsUsageError(
    "Usage: acs audit export [--db <path>] [-o <file>] | acs audit verify (--file <jsonl> | [--db <path>])"
  );
}

export function parseAcsArgs(args: string[]): AcsCommand {
  if (args.length === 0 || args.includes("--help") || args.includes("-h") || args[0] === "help") {
    return { kind: "help" };
  }
  if (args[0] === "--version" || args[0] === "-V" || args[0] === "version") {
    return { kind: "version" };
  }

  const [command, ...rest] = args;
  switch (command) {
    case "actor":
      return parseActorArgs(rest);
    case "worker":
      return { kind: "worker", forwarded: rejectUnexpectedArgs("worker", takeOptionalRun(rest, "worker")) };
    case "scheduler":
      return { kind: "scheduler", forwarded: rejectUnexpectedArgs("scheduler", takeOptionalRun(rest, "scheduler")) };
    case "mcp":
      return parseMcpArgs(rest);
    case "gateway":
      return { kind: "gateway", forwarded: rejectUnexpectedArgs("gateway", takeOptionalServe(rest, "gateway")) };
    case "status":
      return parseStatusArgs("status", rest);
    case "doctor":
      return parseStatusArgs("doctor", rest);
    case "publication":
      return parsePublicationArgs(rest);
    case "audit":
      return parseAuditArgs(rest);
    case "skills":
      return { kind: "skills", args: rest };
    default:
      throw new AcsUsageError(`unknown command: ${command}`);
  }
}
