export const ACS_CLI_VERSION = "0.1.0-alpha";

export const ACS_HELP = `Usage: acs [--version] [--help] <command> [args]

Commands:
  actor list --available [--json]
  worker [run]
  scheduler [run]
  mcp [serve] [--config <path>]
  gateway [serve]

Legacy binaries remain available: acs-worker, acs-scheduler, acs-mcp, acs-gateway.
`;

export type AcsCommand =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "actor-list-available"; json: boolean }
  | { kind: "worker"; forwarded: string[] }
  | { kind: "scheduler"; forwarded: string[] }
  | { kind: "mcp"; forwarded: string[] }
  | { kind: "gateway"; forwarded: string[] };

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
    default:
      throw new AcsUsageError(`unknown command: ${command}`);
  }
}
