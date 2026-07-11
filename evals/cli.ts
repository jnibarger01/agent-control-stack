import { resolve } from "node:path";
import { ClaudeCliProvider } from "../harness/claude-cli-provider.js";
import { FixtureProvider } from "./fixture-provider.js";
import { runEvals } from "./runner.js";
import { loadEvalTaskCorpus } from "./task-schema.js";

interface CliOptions {
  provider: "claude-cli" | "fixture";
  output?: string;
  maxCallBudgetUsd: number;
  timeoutMs: number;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return;

  const root = process.cwd();
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const runId = `${options.provider}-${now.toISOString().replace(/[:.]/g, "-")}`;
  const output = resolve(options.output ?? `runs/${date}-eval-${runId}.json`);
  const tasks = loadEvalTaskCorpus(resolve("evals/tasks"));
  const provider =
    options.provider === "claude-cli"
      ? new ClaudeCliProvider({ cwd: root })
      : new FixtureProvider();

  if (options.provider === "fixture") {
    console.log("FIXTURE TEST RUN — this output is not baseline evidence.");
  }

  await runEvals({
    tasks,
    provider,
    providerName: options.provider === "fixture" ? "fixture-test-only" : "claude-cli",
    pricingDate: date,
    runId,
    outputPath: output,
    maxCallBudgetUsd: options.maxCallBudgetUsd,
    timeoutMs: options.timeoutMs
  });
}

function parseArgs(args: string[]): CliOptions | null {
  if (args.length === 0 || args.includes("--help")) {
    console.log(
      "Usage: scripts/run-evals --provider <claude-cli|fixture> [--output <path>] [--max-call-usd <amount>] [--timeout-ms <ms>]"
    );
    return null;
  }

  let provider: CliOptions["provider"] | undefined;
  let output: string | undefined;
  let maxCallBudgetUsd = 0.05;
  let timeoutMs = 120_000;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--provider" && (value === "claude-cli" || value === "fixture")) {
      provider = value;
      index += 1;
    } else if (flag === "--output" && value) {
      output = value;
      index += 1;
    } else if (flag === "--max-call-usd" && value && Number(value) > 0) {
      maxCallBudgetUsd = Number(value);
      index += 1;
    } else if (flag === "--timeout-ms" && value && Number.isInteger(Number(value)) && Number(value) > 0) {
      timeoutMs = Number(value);
      index += 1;
    } else {
      throw new Error(`invalid eval argument: ${flag}${value ? ` ${value}` : ""}`);
    }
  }
  if (!provider) throw new Error("--provider must be claude-cli or fixture");
  return { provider, ...(output ? { output } : {}), maxCallBudgetUsd, timeoutMs };
}

await main();
