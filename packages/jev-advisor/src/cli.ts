#!/usr/bin/env node
/**
 * acs-jev — CLI for the advisory Jev classifier.
 *
 * Usage:
 *   acs-jev classify --state-file <path> --signal <name>="<instructions>" ... [--json] [--strict]
 *
 * Prints the JevResult JSON with an explicit machine-readable `decision`
 * field ("skip" | "continue" | "duplicate_check_required" | "degraded").
 * Degrade-never-fail: exits 0 with a degraded:true + decision:"degraded"
 * result on any Jev failure. `--strict` may exit nonzero (testing only) and
 * must never gate a caller decision.
 */

import { readFile } from "node:fs/promises";
import { classifyJev, deriveJevDecision, isJevEnabled } from "./index.js";
import { formatJevTelemetry, buildJevTelemetryEvent } from "./telemetry.js";

type CliArgs = {
  stateFile: string | null;
  signals: Record<string, string>;
  strict: boolean;
};

function usage(): string {
  return 'usage: acs-jev classify --state-file <path> --signal <name>="<instructions>" ... [--json] [--strict]';
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { stateFile: null, signals: {}, strict: false };
  let i = 0;
  if (argv[0] === "classify") i = 1;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--json") {
      // JSON is the only output format; --json is accepted and ignored.
      i += 1;
      continue;
    }
    if (arg === "--strict") {
      args.strict = true;
      i += 1;
      continue;
    }
    if (arg === "--state-file") {
      args.stateFile = argv[i + 1] ?? null;
      i += 2;
      continue;
    }
    if (arg === "--signal") {
      const spec = argv[i + 1];
      if (typeof spec !== "string" || !spec.includes("=")) {
        throw new Error(`invalid --signal argument: ${String(spec)}`);
      }
      const eq = spec.indexOf("=");
      const name = spec.slice(0, eq);
      const instructions = spec.slice(eq + 1);
      if (!name || !instructions) throw new Error(`invalid --signal argument: ${spec}`);
      args.signals[name] = instructions;
      i += 2;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.stateFile) throw new Error(usage());
  if (Object.keys(args.signals).length === 0) throw new Error("at least one --signal is required");
  return args;
}

export async function runCli(argv: readonly string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (!args.stateFile) throw new Error("at least one --state-file path is required");
  const state = await readFile(args.stateFile, "utf8");
  const result = await classifyJev(state, args.signals);
  // The decision field is machine-readable: consumers must never infer
  // behavior from prose or telemetry fields.
  process.stdout.write(`${JSON.stringify({ ...result, decision: deriveJevDecision(result) })}\n`);
  if (result.degraded) {
    process.stdout.write(`${formatJevTelemetry(buildJevTelemetryEvent({ result, consumer: "acs-jev-cli" }))}\n`);
  }
  if (!isJevEnabled()) {
    process.stderr.write("note: ACS_JEV_ENABLED is not 1; adapter is inert and degraded\n");
  }
  return args.strict && result.degraded ? 2 : 0;
}

const invokedDirectly = process.argv[1]?.endsWith("cli.js") === true;
if (invokedDirectly) {
  process.exitCode = await runCli(process.argv.slice(2));
}
