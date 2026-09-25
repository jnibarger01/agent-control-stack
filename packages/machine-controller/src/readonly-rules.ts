import { statSync } from "node:fs";
import type { MachineControllerConfig } from "./config.js";
import { isInside, resolveSafePath } from "./path.js";

/**
 * Exact-shape read-only rules for `cmd.run`.
 *
 * Every rule is an allowlist over subcommands, flags, and positional
 * arguments: anything not explicitly recognised is refused. Program-name
 * matching alone is never enough, because most "read-only" tools have a flag
 * that writes, executes, or never exits (`find -exec`, `rg --pre`,
 * `tail -f`, `git diff --output`, `git branch <name>`).
 *
 * Path positionals are resolved through `resolveSafePath` and rewritten to
 * their canonical real path, so the command that runs is the command that was
 * checked. Traversing commands (`find`, `du`) are additionally refused when a
 * configured deny root sits inside the start path, because the traversal
 * would otherwise walk into it. Content readers (`rg`, `grep`, `head`, ...)
 * accept regular files only, never directories, so they cannot read denied
 * or credential-like files by recursing.
 */

export type ReadonlyVerdict = { ok: true; args: string[] } | { ok: false; reason: string };

interface RuleContext {
  config: MachineControllerConfig;
  cwd: string;
}

type Rule = (ctx: RuleContext, args: string[]) => ReadonlyVerdict;

interface FlagSpec {
  booleans?: readonly string[];
  values?: Readonly<Record<string, (value: string) => boolean>>;
}

interface ParsedArgs {
  flags: Array<{ flag: string; value?: string }>;
  positionals: Array<{ index: number; value: string }>;
}

const MAX_COUNT = 100_000;
const isCount = (value: string) => /^\d{1,6}$/.test(value) && Number(value) <= MAX_COUNT;
const isNonEmpty = (value: string) => value.length > 0;
const gitRefPattern = /^[A-Za-z0-9._/@^~{}-]+$/;
const containerNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const psColumns = new Set([
  "pid",
  "ppid",
  "user",
  "stat",
  "etime",
  "start",
  "comm",
  "%cpu",
  "%mem",
  "rss",
  "vsz",
  "nlwp"
]);

const ok = (args: string[]): ReadonlyVerdict => ({ ok: true, args });
const refuse = (reason: string): ReadonlyVerdict => ({ ok: false, reason });

export function classifyReadonlyCommand(
  config: MachineControllerConfig,
  cwd: string,
  command: string,
  args: string[]
): ReadonlyVerdict {
  const rule = own(rules, command);
  if (!rule) return refuse("no read-only allow rule matched");
  return rule({ config, cwd }, args);
}

const rules: Readonly<Record<string, Rule>> = {
  git: gitRule,
  bun: (_ctx, args) =>
    args.length === 1 && args[0] === "--version" ? ok(args) : refuse("bun: only --version is read-only"),
  node: (_ctx, args) =>
    args.length === 1 && ["--version", "-v"].includes(args[0] ?? "")
      ? ok(args)
      : refuse("node: only --version is read-only"),
  python3: (_ctx, args) =>
    args.length === 1 && ["--version", "-V"].includes(args[0] ?? "")
      ? ok(args)
      : refuse("python3: only --version is read-only"),
  df: legacyFirstArgRule("df", ["", "-h"]),
  free: legacyFirstArgRule("free", ["", "-h"]),
  docker: dockerRule,

  ls: (ctx, args) =>
    withPaths(ctx, args, parse(args, { booleans: ["-l", "-a", "-A", "-h", "-1", "-t", "-r", "-S", "-d", "-F"] }), {
      minPaths: 0
    }),
  wc: (ctx, args) =>
    withPaths(ctx, args, parse(args, { booleans: ["-l", "-w", "-c", "-m"] }), { minPaths: 1, filesOnly: true }),
  head: (ctx, args) =>
    withPaths(ctx, args, parse(args, { booleans: ["-q"], values: { "-n": isCount, "-c": isCount } }), {
      minPaths: 1,
      filesOnly: true
    }),
  tail: (ctx, args) =>
    withPaths(ctx, args, parse(args, { booleans: ["-q"], values: { "-n": isCount, "-c": isCount } }), {
      minPaths: 1,
      filesOnly: true
    }),
  rg: (ctx, args) =>
    contentSearch(
      ctx,
      args,
      parse(args, {
        booleans: ["-n", "-i", "-l", "-c", "-F", "-w", "-S", "-H", "--no-heading"],
        values: { "-e": isNonEmpty, "-m": isCount, "--max-count": isCount, "-A": isCount, "-B": isCount, "-C": isCount }
      })
    ),
  grep: (ctx, args) =>
    contentSearch(
      ctx,
      args,
      parse(args, {
        booleans: ["-n", "-i", "-l", "-c", "-F", "-E", "-w", "-H", "-h", "-v"],
        values: { "-e": isNonEmpty, "-m": isCount, "-A": isCount, "-B": isCount, "-C": isCount }
      })
    ),
  find: findRule,
  du: (ctx, args) =>
    withPaths(
      ctx,
      args,
      parse(args, { booleans: ["-s", "-h", "-c", "-k"], values: { "-d": isCount, "--max-depth": isCount } }),
      {
        minPaths: 0,
        traverses: true
      }
    ),
  ps: psRule,
  ss: (_ctx, args) =>
    args.length === 1 && ["-ltn", "-lun", "-ltnp", "-lunp", "-s"].includes(args[0] ?? "")
      ? ok(args)
      : refuse("ss: only -ltn, -lun, -ltnp, -lunp, or -s"),
  uname: (_ctx, args) =>
    args.length === 0 || (args.length === 1 && ["-a", "-r", "-s", "-m", "-n"].includes(args[0] ?? ""))
      ? ok(args)
      : refuse("uname: only one of -a, -r, -s, -m, -n"),
  uptime: (_ctx, args) =>
    args.length === 0 || (args.length === 1 && ["-p", "-s"].includes(args[0] ?? ""))
      ? ok(args)
      : refuse("uptime: only -p or -s"),
  whoami: noArgs("whoami"),
  id: noArgs("id"),
  // `hostname NAME` sets the hostname, so only the bare form is read-only.
  hostname: noArgs("hostname"),
  systemctl: systemctlRule,
  journalctl: journalctlRule,
  which: (_ctx, args) =>
    args.length === 1 && /^[A-Za-z0-9._+][A-Za-z0-9._+-]*$/.test(args[0] ?? "")
      ? ok(args)
      : refuse("which: exactly one command name")
};

function parse(args: string[], spec: FlagSpec): ParsedArgs | string {
  const booleans = new Set(spec.booleans ?? []);
  const values = spec.values ?? {};
  const parsed: ParsedArgs = { flags: [], positionals: [] };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--" || arg === "-") return `unsupported argument: ${arg}`;
    if (!arg.startsWith("-")) {
      parsed.positionals.push({ index: i, value: arg });
      continue;
    }
    if (arg.startsWith("--") && arg.includes("=")) {
      const flag = arg.slice(0, arg.indexOf("="));
      const value = arg.slice(arg.indexOf("=") + 1);
      const validate = own(values, flag);
      if (!validate || !validate(value)) return `flag not allowed: ${flag}`;
      parsed.flags.push({ flag, value });
      continue;
    }
    if (booleans.has(arg)) {
      parsed.flags.push({ flag: arg });
      continue;
    }
    const validate = own(values, arg);
    if (validate) {
      const value = args[i + 1];
      if (value === undefined || !validate(value)) return `invalid value for ${arg}`;
      parsed.flags.push({ flag: arg, value });
      i += 1;
      continue;
    }
    // Clustered short booleans such as `-la`; every letter must be allowed on its own.
    if (/^-[A-Za-z0-9]{2,}$/.test(arg) && [...arg.slice(1)].every((letter) => booleans.has(`-${letter}`))) {
      for (const letter of arg.slice(1)) parsed.flags.push({ flag: `-${letter}` });
      continue;
    }
    return `flag not allowed: ${arg}`;
  }
  return parsed;
}

interface PathOptions {
  minPaths: number;
  filesOnly?: boolean;
  traverses?: boolean;
}

function withPaths(
  ctx: RuleContext,
  args: string[],
  parsed: ParsedArgs | string,
  options: PathOptions
): ReadonlyVerdict {
  if (typeof parsed === "string") return refuse(parsed);
  return checkPathPositionals(ctx, args, parsed.positionals, options);
}

function checkPathPositionals(
  ctx: RuleContext,
  args: string[],
  positionals: ParsedArgs["positionals"],
  options: PathOptions
): ReadonlyVerdict {
  if (positionals.length < options.minPaths) return refuse(`at least ${options.minPaths} path argument(s) required`);
  const rewritten = [...args];
  for (const { index, value } of positionals) {
    const checked = checkPath(ctx, value, options);
    if (!checked.ok) return checked;
    rewritten[index] = checked.realPath;
  }
  if (positionals.length === 0 && options.traverses) {
    const denied = denyRootInside(ctx.config, ctx.cwd);
    if (denied) return refuse(`traversal would enter a denied path under ${ctx.cwd}`);
  }
  return ok(rewritten);
}

function checkPath(
  ctx: RuleContext,
  requested: string,
  options: Pick<PathOptions, "filesOnly" | "traverses">
): { ok: true; realPath: string } | { ok: false; reason: string } {
  let realPath: string;
  try {
    realPath = resolveSafePath(ctx.config, requested, { cwd: ctx.cwd }).realPath;
  } catch (error) {
    return { ok: false, reason: `path refused: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (options.filesOnly && !statSync(realPath).isFile()) {
    return { ok: false, reason: `only regular files are allowed: ${requested}` };
  }
  if (options.traverses && denyRootInside(ctx.config, realPath)) {
    return { ok: false, reason: `traversal would enter a denied path under ${requested}` };
  }
  return { ok: true, realPath };
}

function denyRootInside(config: MachineControllerConfig, start: string): boolean {
  return config.paths.deny.some((denied) => isInside(start, denied));
}

function contentSearch(ctx: RuleContext, args: string[], parsed: ParsedArgs | string): ReadonlyVerdict {
  if (typeof parsed === "string") return refuse(parsed);
  const hasExplicitPattern = parsed.flags.some(({ flag }) => flag === "-e");
  const pathPositionals = hasExplicitPattern ? parsed.positionals : parsed.positionals.slice(1);
  if (!hasExplicitPattern && parsed.positionals.length === 0) return refuse("a search pattern is required");
  return checkPathPositionals(ctx, args, pathPositionals, { minPaths: 1, filesOnly: true });
}

function findRule(ctx: RuleContext, args: string[]): ReadonlyVerdict {
  const firstExpression = args.findIndex((arg) => arg.startsWith("-"));
  const startCount = firstExpression === -1 ? args.length : firstExpression;
  const expression = args.slice(startCount);
  const valuePredicates: Record<string, (value: string) => boolean> = {
    "-name": isNonEmpty,
    "-iname": isNonEmpty,
    "-path": isNonEmpty,
    "-type": (value) => ["f", "d", "l"].includes(value),
    "-maxdepth": isCount,
    "-mindepth": isCount
  };
  for (let i = 0; i < expression.length; i += 2) {
    const predicate = expression[i] ?? "";
    const validate = own(valuePredicates, predicate);
    const value = expression[i + 1];
    if (!validate) return refuse(`find: predicate not allowed: ${predicate}`);
    if (value === undefined || !validate(value)) return refuse(`find: invalid value for ${predicate}`);
  }
  const starts = args.slice(0, startCount).map((value, index) => ({ index, value }));
  return checkPathPositionals(ctx, args, starts, { minPaths: 0, traverses: true });
}

function psRule(_ctx: RuleContext, args: string[]): ReadonlyVerdict {
  // Fixed columns only: `args`/`cmd`/`command` would expose other processes' argv, which routinely carries secrets.
  if (args.length !== 2 || args[0] !== "-eo") return refuse("ps: only -eo <columns> is allowed");
  const columns = (args[1] ?? "").split(",");
  const disallowed = columns.find((column) => !psColumns.has(column));
  return disallowed === undefined ? ok(args) : refuse(`ps: column not allowed: ${disallowed}`);
}

function gitRule(ctx: RuleContext, args: string[]): ReadonlyVerdict {
  const subcommand = args[0] ?? "";
  const rest = args.slice(1);
  switch (subcommand) {
    case "status":
    case "diff":
    case "log":
    case "show": {
      // `--output` writes a file and `--ext-diff` runs a configured program; neither is read-only.
      const bad = rest.find((arg) => arg.startsWith("--output") || arg === "--ext-diff");
      return bad ? refuse(`git ${subcommand}: flag not allowed: ${bad}`) : ok(args);
    }
    case "rev-parse": {
      const parsed = parse(rest, {
        booleans: ["--abbrev-ref", "--show-toplevel", "--verify", "--short", "--symbolic-full-name", "--git-dir"]
      });
      if (typeof parsed === "string") return refuse(`git rev-parse: ${parsed}`);
      const bad = parsed.positionals.find(({ value }) => !gitRefPattern.test(value));
      return bad ? refuse(`git rev-parse: invalid ref: ${bad.value}`) : ok(args);
    }
    case "branch": {
      // Any positional would create, rename, or delete a branch.
      const parsed = parse(rest, { booleans: ["-a", "-r", "-v", "-vv", "--list", "--show-current", "--no-color"] });
      if (typeof parsed === "string") return refuse(`git branch: ${parsed}`);
      return parsed.positionals.length === 0 ? ok(args) : refuse("git branch: positional arguments are not allowed");
    }
    case "remote":
      return rest.length === 0 || (rest.length === 1 && rest[0] === "-v")
        ? ok(args)
        : refuse("git remote: only bare or -v");
    case "describe": {
      // `--dirty` refreshes the index, which writes to .git.
      const parsed = parse(rest, { booleans: ["--tags", "--always", "--long"] });
      if (typeof parsed === "string") return refuse(`git describe: ${parsed}`);
      const bad = parsed.positionals.find(({ value }) => !gitRefPattern.test(value));
      return bad ? refuse(`git describe: invalid ref: ${bad.value}`) : ok(args);
    }
    case "blame": {
      const parsed = parse(rest, { booleans: ["-w", "-s"], values: { "-L": (value) => /^\d+,\d+$/.test(value) } });
      if (typeof parsed === "string") return refuse(`git blame: ${parsed}`);
      if (parsed.positionals.length !== 1) return refuse("git blame: exactly one file path");
      return prefixed(args, checkPathPositionals(ctx, rest, parsed.positionals, { minPaths: 1, filesOnly: true }));
    }
    case "ls-files": {
      const parsed = parse(rest, { booleans: ["-c", "-m", "-o", "-d", "-s", "--exclude-standard"] });
      if (typeof parsed === "string") return refuse(`git ls-files: ${parsed}`);
      return prefixed(args, checkPathPositionals(ctx, rest, parsed.positionals, { minPaths: 0 }));
    }
    default:
      return refuse(`git: subcommand is not read-only: ${subcommand}`);
  }
}

function dockerRule(_ctx: RuleContext, args: string[]): ReadonlyVerdict {
  const subcommand = args[0] ?? "";
  const rest = args.slice(1);
  switch (subcommand) {
    case "ps":
      return ok(args);
    case "images": {
      const parsed = parse(rest, { booleans: ["-a", "-q"] });
      if (typeof parsed === "string") return refuse(`docker images: ${parsed}`);
      return parsed.positionals.length === 0 ? ok(args) : refuse("docker images: positional arguments are not allowed");
    }
    case "logs": {
      // `--tail` is mandatory so output is bounded; `-f` is not recognised, so it cannot stream forever.
      const parsed = parse(rest, { booleans: ["-t", "--timestamps"], values: { "--tail": isCount } });
      if (typeof parsed === "string") return refuse(`docker logs: ${parsed}`);
      if (!parsed.flags.some(({ flag }) => flag === "--tail")) return refuse("docker logs: --tail N is required");
      const [container, ...extra] = parsed.positionals;
      if (!container || extra.length > 0 || !containerNamePattern.test(container.value)) {
        return refuse("docker logs: exactly one container name");
      }
      return ok(args);
    }
    case "stats": {
      const parsed = parse(rest, { booleans: ["--no-stream"] });
      if (typeof parsed === "string") return refuse(`docker stats: ${parsed}`);
      if (!parsed.flags.some(({ flag }) => flag === "--no-stream"))
        return refuse("docker stats: --no-stream is required");
      const bad = parsed.positionals.find(({ value }) => !containerNamePattern.test(value));
      return bad ? refuse(`docker stats: invalid container name: ${bad.value}`) : ok(args);
    }
    default:
      return refuse(`docker: subcommand is not read-only: ${subcommand}`);
  }
}

function systemctlRule(ctx: RuleContext, args: string[]): ReadonlyVerdict {
  const subcommand = args[0] ?? "";
  const rest = args.slice(1);
  switch (subcommand) {
    case "status":
    case "is-active":
    case "is-enabled": {
      const parsed = parse(rest, { booleans: ["--no-pager", "--user"] });
      if (typeof parsed === "string") return refuse(`systemctl ${subcommand}: ${parsed}`);
      if (parsed.positionals.length === 0) return refuse(`systemctl ${subcommand}: at least one unit is required`);
      const bad = parsed.positionals.find(({ value }) => !unitAllowed(ctx.config, value));
      return bad ? refuse(`systemctl ${subcommand}: unit is not in commands.allowed_units: ${bad.value}`) : ok(args);
    }
    case "list-timers": {
      const parsed = parse(rest, { booleans: ["--no-pager", "--user", "--all"] });
      if (typeof parsed === "string") return refuse(`systemctl list-timers: ${parsed}`);
      return parsed.positionals.length === 0
        ? ok(args)
        : refuse("systemctl list-timers: positional arguments are not allowed");
    }
    default:
      return refuse(`systemctl: subcommand is not read-only: ${subcommand}`);
  }
}

function journalctlRule(ctx: RuleContext, args: string[]): ReadonlyVerdict {
  // `-f` is not recognised, so it cannot follow forever; `-u` and `-n` are both mandatory.
  const parsed = parse(args, {
    booleans: ["--no-pager", "--user"],
    values: {
      "-u": (value) => unitAllowed(ctx.config, value),
      "-n": isCount,
      "-o": (value) => ["short", "short-iso", "cat"].includes(value)
    }
  });
  if (typeof parsed === "string") return refuse(`journalctl: ${parsed}`);
  if (parsed.positionals.length > 0) return refuse("journalctl: positional arguments are not allowed");
  if (!parsed.flags.some(({ flag }) => flag === "-u")) return refuse("journalctl: -u UNIT is required");
  if (!parsed.flags.some(({ flag }) => flag === "-n")) return refuse("journalctl: -n N is required");
  return ok(args);
}

function unitAllowed(config: MachineControllerConfig, unit: string): boolean {
  return (config.commands.allowedUnits ?? []).includes(unit);
}

function prefixed(args: string[], verdict: ReadonlyVerdict): ReadonlyVerdict {
  return verdict.ok ? ok([args[0] ?? "", ...verdict.args]) : verdict;
}

function legacyFirstArgRule(command: string, allowed: readonly string[]): Rule {
  return (_ctx, args) =>
    allowed.includes(args[0] ?? "")
      ? ok(args)
      : refuse(`${command}: only ${allowed.filter(Boolean).join(", ")} allowed`);
}

/** Own-property lookup, so names like `constructor` or `toString` never resolve to prototype members. */
function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

function noArgs(command: string): Rule {
  return (_ctx, args) => (args.length === 0 ? ok(args) : refuse(`${command}: no arguments allowed`));
}
