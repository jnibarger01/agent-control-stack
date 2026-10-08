/**
 * Pure argv classification for policy (P0-1).
 *
 * Two questions are answered from the command itself rather than from caller-asserted flags:
 *
 * 1. `inferCommandEffects`: does the argv (including anything it chains, wraps or embeds) look
 *    destructive, networked, exfiltrating or obfuscated, and is the program off the read-only
 *    allowlist? The tags annotate the decision. They never infer `write`, and they never turn a
 *    deny the old rules already produced into an approval.
 *
 * 2. `classifyReadOnlyArgv`: is the argv one of a small set of exact read-only shapes? Anything not
 *    explicitly recognised (interpreters, wrappers, absolute or relative binary paths, unknown flags,
 *    quoting or shell syntax inside a token) is not read-only. Modelled on the executor-side
 *    allowlist in packages/machine-controller/src/readonly-rules.ts, but with no filesystem access,
 *    because policy runs on the gateway and not on the execution host.
 *
 * Nothing here executes or reads anything.
 */

/**
 * Why a command needs review, for the decision reason and the flight recorder:
 * - destructive: deletes or discards state (rm, shred, git reset --hard, git push --force, ...)
 * - network: reaches another host (scp, curl, git push/fetch/clone, ...)
 * - exfil: sends local data out (curl -T, scp/sftp of a local file, ...)
 * - obfuscated: the command is not what it looks like (sh -c, $()/backticks, subshells, quoted or
 *   escaped program names)
 * - outside_workspace: an operand resolves outside the project root
 * - unknown_command: the program is not on the read-only allowlist
 */
export const COMMAND_EFFECT_TAGS = [
  "destructive",
  "network",
  "exfil",
  "obfuscated",
  "outside_workspace",
  "unknown_command"
] as const;
export type CommandEffectTag = (typeof COMMAND_EFFECT_TAGS)[number];

export interface CommandEffects {
  destructive: boolean;
  network: boolean;
  tags: CommandEffectTag[];
  reasons: string[];
}

export type ReadOnlyArgvVerdict = { ok: true; operands: string[] } | { ok: false; reason: string };

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "busybox"]);
/** Programs that run another program given later in their argv. */
const WRAPPERS = new Set([
  "env",
  "nohup",
  "nice",
  "ionice",
  "timeout",
  "stdbuf",
  "time",
  "command",
  "exec",
  "builtin",
  "xargs",
  "sudo",
  "doas",
  "su",
  "setsid",
  "chroot",
  "unshare",
  "nsenter",
  "flock",
  "watch",
  "strace",
  "ltrace",
  "script"
]);
const NETWORK_PROGRAMS = new Set([
  "scp",
  "sftp",
  "ssh",
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "telnet",
  "ftp",
  "socat",
  "aria2c",
  "httpie",
  "http"
]);
const DESTRUCTIVE_PROGRAMS = new Set([
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "wipefs",
  "truncate",
  "mkswap",
  "fdisk",
  "sfdisk",
  "parted"
]);
const GIT_NETWORK_SUBCOMMANDS = new Set(["push", "fetch", "pull", "clone", "ls-remote", "remote", "submodule"]);
const FIND_DESTRUCTIVE_PREDICATES = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls"
]);
/** Token separators a shell would treat as command boundaries. */
const SEPARATOR_TOKEN = /^(;|&&|\|\||\||&|\(|\)|\{|\})$/;
const SCRIPT_SPLIT = /[;&|()\n\r`{}]+|\$\(/;

/** Strips quoting and escapes the way a shell would before looking a program up. */
function unquote(token: string): string {
  return token.replace(/\\(.)/g, "$1").replace(/["']/g, "");
}

function programName(token: string): string {
  const bare = unquote(token);
  const slash = bare.lastIndexOf("/");
  return slash >= 0 ? bare.slice(slash + 1) : bare;
}

function tokenizeScript(script: string): string[] {
  return script
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Splits an argv into the command segments a shell could run: explicit separator tokens, tokens
 * that end in a separator (`README.md;`), and anything embedded in `$(...)`, backticks or a
 * `sh -c` script are all examined.
 */
function commandSegments(argv: readonly string[], depth = 0): string[][] {
  if (depth > 4) return [];
  const segments: string[][] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) segments.push(current);
    current = [];
  };
  for (const raw of argv) {
    if (SEPARATOR_TOKEN.test(raw)) {
      flush();
      continue;
    }
    if (/[`]|\$\(|[\n\r]/.test(raw)) {
      // Embedded command substitution or a multi-line token: examine every piece as its own script.
      for (const piece of raw.split(SCRIPT_SPLIT)) {
        segments.push(...commandSegments(tokenizeScript(piece), depth + 1));
      }
      continue;
    }
    const trailing = /^(.*?)(;|&&|\|\||\||&)+$/.exec(raw);
    if (trailing && trailing[1] !== undefined) {
      if (trailing[1].length > 0) current.push(trailing[1]);
      flush();
      continue;
    }
    current.push(raw);
  }
  flush();

  const expanded: string[][] = [];
  for (const segment of segments) {
    expanded.push(...unwrapSegment(segment, depth));
  }
  return expanded;
}

/** Removes env-var prefixes and wrapper programs, and expands `sh -c <script>`. */
function unwrapSegment(segment: readonly string[], depth: number): string[][] {
  let index = 0;
  while (index < segment.length) {
    const token = segment[index] ?? "";
    if (ENV_ASSIGNMENT.test(unquote(token))) {
      index += 1;
      continue;
    }
    const name = programName(token);
    if (WRAPPERS.has(name)) {
      index += 1;
      // Skip the wrapper's own options, assignments and leading numeric arguments (timeout 10, nice -n 5).
      while (index < segment.length) {
        const next = unquote(segment[index] ?? "");
        if (next.startsWith("-") || ENV_ASSIGNMENT.test(next) || /^\d+(\.\d+)?[smhd]?$/.test(next)) {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    break;
  }
  const rest = segment.slice(index);
  const head = rest[0];
  if (head === undefined) return [];
  const name = programName(head);
  if (SHELLS.has(name)) {
    const scriptIndex = rest.findIndex((token, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(unquote(token)));
    const script = scriptIndex >= 0 ? rest[scriptIndex + 1] : undefined;
    if (script !== undefined) {
      const nested: string[][] = [];
      for (const piece of unquote(script).split(SCRIPT_SPLIT)) {
        nested.push(...commandSegments(tokenizeScript(piece), depth + 1));
      }
      return [rest, ...nested];
    }
  }
  return [rest];
}

function hasShortFlag(args: readonly string[], letters: string): boolean {
  return args.some((arg) => /^-[^-]/.test(arg) && [...arg.slice(1)].some((letter) => letters.includes(letter)));
}

/** Index of the git subcommand, skipping git's own global options. */
function gitSubcommandIndex(args: readonly string[]): number {
  let index = 0;
  while (index < args.length) {
    const arg = args[index] ?? "";
    if (arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree" || arg === "--namespace") {
      index += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      index += 1;
      continue;
    }
    return index;
  }
  return -1;
}

function segmentEffects(segment: readonly string[], effects: CommandEffects): void {
  const head = segment[0];
  if (head === undefined) return;
  const name = programName(head);
  const args = segment.slice(1).map(unquote);

  if (DESTRUCTIVE_PROGRAMS.has(name) || /^mkfs(\..+)?$/.test(name) || name === "mke2fs") {
    effects.destructive = true;
    effects.reasons.push(`${name} removes or overwrites data`);
  }
  if (name === "dd" && args.some((arg) => arg.startsWith("of="))) {
    effects.destructive = true;
    effects.reasons.push("dd writes to an output target");
  }
  if (name === "find" && args.some((arg) => FIND_DESTRUCTIVE_PREDICATES.has(arg))) {
    effects.destructive = true;
    effects.reasons.push("find with an action predicate can delete or execute");
  }
  if (NETWORK_PROGRAMS.has(name)) {
    effects.network = true;
    effects.reasons.push(`${name} uses the network`);
  }
  if (name === "rsync" && args.some((arg) => /^[^/\s]+:/.test(arg) || arg.startsWith("rsync://"))) {
    effects.network = true;
    effects.reasons.push("rsync to a remote host uses the network");
  }
  if (name === "git") {
    const subIndex = gitSubcommandIndex(args);
    const sub = subIndex >= 0 ? args[subIndex] : undefined;
    const subArgs = subIndex >= 0 ? args.slice(subIndex + 1) : [];
    if (sub !== undefined && GIT_NETWORK_SUBCOMMANDS.has(sub)) {
      effects.network = true;
      effects.reasons.push(`git ${sub} uses the network`);
    }
    if (
      sub === "push" &&
      (subArgs.some((arg) => /^--(force|force-with-lease|force-if-includes|mirror|delete|prune)(=|$)/.test(arg)) ||
        hasShortFlag(subArgs, "fd") ||
        subArgs.some((arg) => arg.startsWith("+") || arg.startsWith(":")))
    ) {
      effects.destructive = true;
      effects.reasons.push("git push rewrites or deletes remote history");
    }
    if (sub === "reset" && subArgs.some((arg) => arg === "--hard" || arg === "--merge" || arg === "--keep")) {
      effects.destructive = true;
      effects.reasons.push("git reset discards work");
    }
    if (sub === "clean" && (hasShortFlag(subArgs, "f") || subArgs.includes("--force"))) {
      effects.destructive = true;
      effects.reasons.push("git clean deletes untracked files");
    }
    if (sub === "checkout" && subArgs.some((arg) => arg === "--" || arg === "-f" || arg === "--force")) {
      effects.destructive = true;
      effects.reasons.push("git checkout can discard work");
    }
  }
}

/** Effects implied by the argv itself. Monotonic: only ever reports more risk, never less. */
export function inferCommandEffects(command: readonly string[] | undefined): CommandEffects {
  const effects: CommandEffects = { destructive: false, network: false, tags: [], reasons: [] };
  if (!command || command.length === 0) return effects;
  for (const segment of commandSegments(command)) {
    segmentEffects(segment, effects);
  }
  if (isObfuscated(command)) {
    effects.reasons.push("command hides its program (shell wrapper, substitution, subshell, quoting or escapes)");
  }
  if (commandPathOperands(command).some(operandOutsideWorkspace)) {
    effects.reasons.push("an operand resolves outside the workspace");
  }
  const verdict = classifyReadOnlyArgv(command);
  if (!verdict.ok) {
    effects.reasons.push(`not an allowlisted read-only command: ${verdict.reason}`);
  }
  effects.tags = effectTags(effects, command);
  return effects;
}

/** A tag applies when its condition holds, in a fixed order so the audit record is stable. */
function effectTags(effects: CommandEffects, command: readonly string[]): CommandEffectTag[] {
  const tags: CommandEffectTag[] = [];
  if (effects.destructive) tags.push("destructive");
  if (effects.network) tags.push("network");
  if (isExfiltration(command)) tags.push("exfil");
  if (isObfuscated(command)) tags.push("obfuscated");
  if (commandPathOperands(command).some(operandOutsideWorkspace)) tags.push("outside_workspace");
  if (!classifyReadOnlyArgv(command).ok) tags.push("unknown_command");
  return tags;
}

/** Sends local content to another host: an upload, or a copy/transfer of a local path. */
function isExfiltration(command: readonly string[]): boolean {
  return commandSegments(command).some((segment) => {
    const name = programName(segment[0] ?? "");
    const args = segment.slice(1);
    if (
      name === "curl" &&
      args.some(
        (arg) => /^-[A-Za-z]*T[A-Za-z]*$/.test(arg) || arg === "--upload-file" || arg.startsWith("--upload-file=")
      )
    ) {
      return true;
    }
    if (name === "scp" || name === "sftp") {
      return true;
    }
    return name === "rsync" && args.some((arg) => /^[A-Za-z0-9._-]*:/.test(arg) || arg.startsWith("rsync://"));
  });
}

/**
 * The argv is not the plain command it appears to be: a shell runs a script, a wrapper hides the real
 * program, a token carries command substitution or a subshell, or the program name is quoted or escaped
 * so it only matches after a shell sees it.
 */
function isObfuscated(command: readonly string[]): boolean {
  if (command.some((token) => /[$()\n\r]/.test(token) || token.includes("`"))) return true;
  if (command.some((token) => token !== unquote(token))) return true;
  return commandSegments(command).some((segment) => {
    const head = programName(segment[0] ?? "");
    if (WRAPPERS.has(head)) return true;
    if (SHELLS.has(head)) {
      const flag = segment.slice(1).find((token) => token.startsWith("-"));
      return flag !== undefined && flag.includes("c");
    }
    return false;
  });
}

function operandOutsideWorkspace(operand: string): boolean {
  return operand.startsWith("/") || operand.startsWith("~") || operand.split("/").includes("..");
}

/**
 * Path-like operands an argv names (excluding the program itself), for the credential-path and
 * path-escape checks. `--opt=value` and `key=value` operands contribute their value. A leading `~`
 * expands to the home directory, which is outside any project root, so it is reported as an
 * absolute path.
 */
export function commandPathOperands(command: readonly string[] | undefined): string[] {
  if (!command || command.length < 2) return [];
  const operands: string[] = [];
  for (const raw of command.slice(1)) {
    const token = unquote(raw);
    if (token.length === 0 || SEPARATOR_TOKEN.test(token)) continue;
    const equals = token.indexOf("=");
    const value = token.startsWith("-")
      ? equals >= 0
        ? token.slice(equals + 1)
        : ""
      : equals > 0 && /^[A-Za-z_]+=/.test(token)
        ? token.slice(equals + 1)
        : token;
    if (value.length === 0) continue;
    if (value.startsWith("~")) {
      operands.push(`/${value}`);
      continue;
    }
    if (value.includes("/") || value.startsWith(".")) operands.push(value);
  }
  return operands;
}

/** Every token of a read-only argv must be plain: no quoting, escapes, globbing or shell syntax. */
const PLAIN_TOKEN = /^[A-Za-z0-9._/@:+,=%^-][A-Za-z0-9._/@:+,=%^~{}-]*$/;
/** Search patterns may hold regex syntax, but never quotes, escapes-of-quotes, newlines or shell syntax. */
const PATTERN_TOKEN = /^[^\s'"`$;&|<>\\]+$|^[A-Za-z0-9._ -]+$/;
const GLOB_TOKEN = /^[A-Za-z0-9._/*?[\]-]+$/;
const COUNT_TOKEN = /^\+?\d{1,6}$/;

const ok = (operands: string[]): ReadOnlyArgvVerdict => ({ ok: true, operands });
const refuse = (reason: string): ReadOnlyArgvVerdict => ({ ok: false, reason });

interface FlagSpec {
  /** Single-letter flags that may be combined (`-la`). */
  letters?: string;
  /** Exact flags. */
  exact?: readonly string[];
  /** Flags taking a value in the next token or after `=` (value validated by the predicate). */
  values?: Readonly<Record<string, (value: string) => boolean>>;
}

/**
 * Parses an argv tail against a flag spec. Returns the positional operands, or a refusal for any
 * unrecognised flag. `--` ends flag parsing.
 */
function parseFlags(
  args: readonly string[],
  spec: FlagSpec
): { ok: true; positionals: string[] } | { ok: false; reason: string } {
  const positionals: string[] = [];
  let index = 0;
  let flagsDone = false;
  while (index < args.length) {
    const arg = args[index] ?? "";
    if (flagsDone || !arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      index += 1;
      continue;
    }
    if (arg === "--") {
      flagsDone = true;
      index += 1;
      continue;
    }
    const equals = arg.indexOf("=");
    const flag = equals >= 0 ? arg.slice(0, equals) : arg;
    const valuePredicate = spec.values?.[flag];
    if (valuePredicate) {
      const value = equals >= 0 ? arg.slice(equals + 1) : args[index + 1];
      if (value === undefined || !valuePredicate(value)) return { ok: false, reason: `invalid value for ${flag}` };
      index += equals >= 0 ? 1 : 2;
      continue;
    }
    // Attached short value: -n20
    const attached = /^(-[A-Za-z])(.+)$/.exec(arg);
    if (attached && spec.values?.[attached[1] ?? ""]?.(attached[2] ?? "")) {
      index += 1;
      continue;
    }
    if (equals < 0 && spec.exact?.includes(arg)) {
      index += 1;
      continue;
    }
    if (
      equals < 0 &&
      spec.letters &&
      /^-[A-Za-z0-9]+$/.test(arg) &&
      [...arg.slice(1)].every((letter) => spec.letters?.includes(letter))
    ) {
      index += 1;
      continue;
    }
    return { ok: false, reason: `flag ${arg} is not on the read-only allowlist` };
  }
  return { ok: true, positionals };
}

const isCount = (value: string) => COUNT_TOKEN.test(value);
const isPattern = (value: string) => value.length > 0 && PATTERN_TOKEN.test(value);

function pathOperands(positionals: string[], min: number): ReadOnlyArgvVerdict {
  if (positionals.length < min) return refuse(`at least ${min} path operand(s) required`);
  for (const operand of positionals) {
    if (!PLAIN_TOKEN.test(operand)) return refuse(`operand ${JSON.stringify(operand)} is not a plain path`);
  }
  return ok(positionals);
}

function gitReadOnly(args: readonly string[]): ReadOnlyArgvVerdict {
  const sub = args[0];
  const rest = args.slice(1);
  const common: FlagSpec = {
    exact: [
      "--stat",
      "--shortstat",
      "--numstat",
      "--name-only",
      "--name-status",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--cached",
      "--staged",
      "--patch",
      "--oneline",
      "--graph",
      "--decorate",
      "--no-decorate",
      "--abbrev-commit",
      "--summary"
    ],
    letters: "p",
    values: { "-n": isCount, "--max-count": isCount, "-U": isCount, "--unified": isCount }
  };
  let parsed;
  switch (sub) {
    case "status":
      parsed = parseFlags(rest, {
        exact: ["--short", "--branch", "--porcelain", "--porcelain=v1", "--porcelain=v2", "--no-renames"],
        letters: "sb"
      });
      break;
    case "diff":
    case "log":
    case "show":
      parsed = parseFlags(rest, common);
      break;
    default:
      return refuse(`git ${sub ?? ""} is not a read-only allowlisted subcommand`);
  }
  if (!parsed.ok) return refuse(parsed.reason);
  // Revisions and pathspecs are both plain tokens; both are reported for the containment checks.
  return pathOperands(parsed.positionals, 0);
}

function rgReadOnly(args: readonly string[]): ReadOnlyArgvVerdict {
  // rg skips hidden and ignored files by default; flags that would undo that, follow links,
  // decompress, or run a preprocessor are not allowlisted.
  const parsed = parseFlags(args, {
    letters: "nilcFwSHsvx",
    exact: ["--no-heading", "--line-number", "--ignore-case", "--fixed-strings", "--count", "--files-with-matches"],
    values: {
      "-e": isPattern,
      "--regexp": isPattern,
      "-m": isCount,
      "--max-count": isCount,
      "-A": isCount,
      "-B": isCount,
      "-C": isCount
    }
  });
  if (!parsed.ok) return refuse(parsed.reason);
  const usesFlagPattern = args.some((arg) => arg === "-e" || arg.startsWith("--regexp") || /^-e./.test(arg));
  const pattern = usesFlagPattern ? undefined : parsed.positionals[0];
  const paths = usesFlagPattern ? parsed.positionals : parsed.positionals.slice(1);
  if (!usesFlagPattern && (pattern === undefined || !isPattern(pattern)))
    return refuse("rg needs a plain search pattern");
  return pathOperands(paths, 1);
}

function grepReadOnly(args: readonly string[]): ReadOnlyArgvVerdict {
  // Recursive grep reads hidden and ignored files (for example .env), so only file operands are allowed.
  const parsed = parseFlags(args, {
    letters: "nilcFwHhEsvx",
    values: { "-e": isPattern, "-m": isCount, "-A": isCount, "-B": isCount, "-C": isCount }
  });
  if (!parsed.ok) return refuse(parsed.reason);
  const usesFlagPattern = args.some((arg) => arg === "-e" || /^-e./.test(arg));
  const pattern = usesFlagPattern ? undefined : parsed.positionals[0];
  const paths = usesFlagPattern ? parsed.positionals : parsed.positionals.slice(1);
  if (!usesFlagPattern && (pattern === undefined || !isPattern(pattern)))
    return refuse("grep needs a plain search pattern");
  return pathOperands(paths, 1);
}

function findReadOnly(args: readonly string[]): ReadOnlyArgvVerdict {
  const starts: string[] = [];
  let index = 0;
  while (index < args.length && !(args[index] ?? "").startsWith("-")) {
    starts.push(args[index] ?? "");
    index += 1;
  }
  const globValue = (value: string | undefined) => value !== undefined && GLOB_TOKEN.test(value);
  while (index < args.length) {
    const predicate = args[index] ?? "";
    const value = args[index + 1];
    switch (predicate) {
      case "-name":
      case "-iname":
      case "-path":
      case "-ipath":
        if (!globValue(value)) return refuse(`find ${predicate} needs a plain glob`);
        index += 2;
        break;
      case "-type":
        if (value === undefined || !/^[fdl]$/.test(value)) return refuse("find -type must be f, d or l");
        index += 2;
        break;
      case "-maxdepth":
      case "-mindepth":
        if (value === undefined || !isCount(value)) return refuse(`find ${predicate} needs a count`);
        index += 2;
        break;
      case "-print":
      case "-empty":
        index += 1;
        break;
      default:
        return refuse(`find predicate ${predicate} is not on the read-only allowlist`);
    }
  }
  return pathOperands(starts, 1);
}

type ReadOnlyRule = (args: readonly string[]) => ReadOnlyArgvVerdict;

const READ_ONLY_RULES: Readonly<Record<string, ReadOnlyRule>> = {
  git: gitReadOnly,
  ls: (args) => {
    const parsed = parseFlags(args, { letters: "laAh1trSdF" });
    return parsed.ok ? pathOperands(parsed.positionals, 0) : refuse(parsed.reason);
  },
  cat: (args) => {
    const parsed = parseFlags(args, { letters: "nbs" });
    return parsed.ok ? pathOperands(parsed.positionals, 1) : refuse(parsed.reason);
  },
  head: (args) => {
    const parsed = parseFlags(args, { letters: "q", values: { "-n": isCount, "-c": isCount } });
    return parsed.ok ? pathOperands(parsed.positionals, 1) : refuse(parsed.reason);
  },
  tail: (args) => {
    // No -f/-F/--follow/--pid: those never exit.
    const parsed = parseFlags(args, { letters: "q", values: { "-n": isCount, "-c": isCount } });
    return parsed.ok ? pathOperands(parsed.positionals, 1) : refuse(parsed.reason);
  },
  wc: (args) => {
    const parsed = parseFlags(args, { letters: "lwcm" });
    return parsed.ok ? pathOperands(parsed.positionals, 1) : refuse(parsed.reason);
  },
  stat: (args) => {
    const parsed = parseFlags(args, {});
    return parsed.ok ? pathOperands(parsed.positionals, 1) : refuse(parsed.reason);
  },
  pwd: (args) => (args.length === 0 ? ok([]) : refuse("pwd takes no arguments")),
  rg: rgReadOnly,
  grep: grepReadOnly,
  find: findReadOnly
};

/**
 * Whether `command` is an exact, allowlisted read-only shape. The program must be a bare name
 * (no path), and every token must be plain. Returns the operands that name files or revisions so the
 * caller can check they stay inside the project root.
 */
export function classifyReadOnlyArgv(command: readonly string[] | undefined): ReadOnlyArgvVerdict {
  if (!command || command.length === 0) return refuse("no command");
  const [program, ...args] = command;
  if (program === undefined || !/^[a-z][a-z0-9-]*$/.test(program)) {
    return refuse("program must be a bare allowlisted name");
  }
  const rule = Object.prototype.hasOwnProperty.call(READ_ONLY_RULES, program) ? READ_ONLY_RULES[program] : undefined;
  if (!rule) return refuse(`${program} is not on the read-only allowlist`);
  if (args.some((arg) => /[\s'"`\\$;&|<>()]/.test(arg))) {
    return refuse("argument contains quoting, whitespace or shell syntax");
  }
  return rule(args);
}
