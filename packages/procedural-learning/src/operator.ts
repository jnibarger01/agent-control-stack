import { FIRST_CLASS_TARGETS, ProceduralLearning } from "./learning.js";

export interface SkillsCliIo {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
}

export function defaultLearningDbPath(): string {
  return process.env.ACS_LEARNING_DB_PATH ?? process.env.ACS_DB_PATH ?? "storage/local.db";
}

export function runSkillsCommand(
  args: string[],
  io: SkillsCliIo,
  open: (dbPath: string) => ProceduralLearning = (dbPath) => new ProceduralLearning(dbPath)
): number {
  const dbIndex = args.indexOf("--db");
  const dbPath = dbIndex >= 0 ? args[dbIndex + 1] : defaultLearningDbPath();
  if (dbIndex >= 0 && !dbPath) {
    io.stderr.write("acs skills --db requires a path\n");
    return 1;
  }
  const commandArgs = args.filter((arg, index) => arg !== "--db" && index !== dbIndex + 1);
  const [command, ...rest] = commandArgs;
  const learning = open(dbPath);
  try {
    switch (command) {
      case "list":
        io.stdout.write(`${JSON.stringify(learning.listSkills(), null, 2)}\n`);
        return 0;
      case "show":
        if (!rest[0]) {
          io.stderr.write("Usage: acs skills show <skill>\n");
          return 1;
        }
        io.stdout.write(`${JSON.stringify(learning.showSkill(rest[0]), null, 2)}\n`);
        return 0;
      case "history":
        if (!rest[0]) {
          io.stderr.write("Usage: acs skills history <skill>\n");
          return 1;
        }
        io.stdout.write(`${JSON.stringify(learning.skillHistory(rest[0]), null, 2)}\n`);
        return 0;
      case "candidates":
        io.stdout.write(`${JSON.stringify(learning.listCandidates(), null, 2)}\n`);
        return 0;
      case "usages":
        if (!rest[0]) {
          io.stderr.write("Usage: acs skills usages <skill>\n");
          return 1;
        }
        io.stdout.write(`${JSON.stringify(learning.listUsages(rest[0]), null, 2)}\n`);
        return 0;
      case "quarantine":
        if (!rest[0]) {
          io.stderr.write("Usage: acs skills quarantine <skill>\n");
          return 1;
        }
        learning.quarantineSkill(rest[0]);
        io.stdout.write(`${JSON.stringify({ name: rest[0], status: "quarantined" })}\n`);
        return 0;
      case "retrieve": {
        const problem = takeFlag(rest, "--problem") ?? rest.join(" ");
        if (!problem.trim()) {
          io.stderr.write("Usage: acs skills retrieve --problem <text>\n");
          return 1;
        }
        const brief = learning.prepareEngineeringWork({
          problemSummary: problem,
          errorMessages: flagValues(rest, "--error"),
          technologies: flagValues(rest, "--tech"),
          taskType: takeFlag(rest, "--type"),
          repository: takeFlag(rest, "--repo")
        });
        io.stdout.write(`${JSON.stringify(brief, null, 2)}\n`);
        return 0;
      }
      case "targets":
        io.stdout.write(
          `${JSON.stringify(
            FIRST_CLASS_TARGETS.map((name) => learning.getTarget(name)),
            null,
            2
          )}\n`
        );
        return 0;
      default:
        io.stderr.write(
          "Usage: acs skills <list|show|history|candidates|usages|quarantine|retrieve|targets> [args]\n"
        );
        return 1;
    }
  } finally {
    learning.close();
  }
}

function takeFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function flagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1]) {
      values.push(args[index + 1] ?? "");
      index += 1;
    }
  }
  return values;
}
