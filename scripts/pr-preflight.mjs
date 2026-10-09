#!/usr/bin/env node
// Pre-PR overlap check. Run from the branch you are about to open (or update) a pull request for.
//
// 1. Fetches origin and refuses when the branch is behind origin/main (rebase onto a fresh base first).
// 2. Lists OPEN pull requests (gh) that touch any file this branch changes vs origin/main. Warns by default;
//    --strict turns any overlap into a refusal.
// 3. Refuses when a migration this branch adds reuses a number already on origin/main or in another open PR, or
//    sorts before main's latest migration. Prints the next free migration number (see AGENTS.md "Slice workflow").
//
// Exit codes: 0 ok (warnings possible), 2 usage, 3 behind origin/main, 4 git/gh failure, 5 overlap with --strict,
// 6 migration number collision. When several apply, the first in the order 4, 3, 6, 5 wins.
import { execFileSync } from "node:child_process";

const USAGE = `Usage: node scripts/pr-preflight.mjs [--strict] [--next-migration] [--no-fetch] [--repo owner/name]
                                    [--remote origin] [--base main] [--migrations-dir storage/migrations]

  --strict          Refuse (exit 5) when any open pull request touches a file this branch changes.
  --next-migration  Print only the next free migration number (max of origin/main and open PRs, plus one).
  --no-fetch        Skip 'git fetch' (offline use; the behind check then uses the last fetched state).
  --repo            Passed to gh as --repo when gh cannot infer the repository from the remotes.`;

const EXIT = { usage: 2, behind: 3, failure: 4, overlap: 5, migration: 6 };
const EXIT_PRIORITY = [EXIT.failure, EXIT.behind, EXIT.migration, EXIT.overlap];

function parseArgs(argv) {
  const opts = {
    strict: false,
    nextMigration: false,
    fetch: true,
    repo: undefined,
    remote: "origin",
    base: "main",
    migrationsDir: "storage/migrations"
  };
  const valueFlags = { "--repo": "repo", "--remote": "remote", "--base": "base", "--migrations-dir": "migrationsDir" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--strict") opts.strict = true;
    else if (arg === "--next-migration") opts.nextMigration = true;
    else if (arg === "--no-fetch") opts.fetch = false;
    else if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg in valueFlags) {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) usageError(`${arg} needs a value`);
      opts[valueFlags[arg]] = value;
      i += 1;
    } else usageError(`unknown argument: ${arg}`);
  }
  opts.migrationsDir = opts.migrationsDir.replace(/\/+$/, "");
  return opts;
}

function usageError(message) {
  console.error(`pr-preflight: ${message}\n${USAGE}`);
  process.exit(EXIT.usage);
}

function fatal(message) {
  console.error(`pr-preflight: ${message}`);
  process.exit(EXIT.failure);
}

function run(cmd, args, what) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024
    });
  } catch (error) {
    const detail = String(error.stderr || error.message || "").trim();
    fatal(`${what} failed${detail ? `: ${detail.split("\n").slice(-3).join(" | ")}` : ""}`);
  }
}

const git = (args, what = `git ${args[0]}`) => run("git", args, what);
const lines = (text) => text.split("\n").filter((line) => line.length > 0);

function gh(opts, args, what) {
  const repoArgs = opts.repo ? ["--repo", opts.repo] : [];
  const out = run("gh", [...args, ...repoArgs], what);
  try {
    return JSON.parse(out);
  } catch {
    fatal(`${what} returned non-JSON output`);
  }
}

function migrationNumber(path, migrationsDir) {
  const prefix = `${migrationsDir}/`;
  if (!path.startsWith(prefix)) return undefined;
  const match = /^(\d+)_[^/]+\.sql$/.exec(path.slice(prefix.length));
  return match ? Number(match[1]) : undefined;
}

const pad = (n) => String(n).padStart(3, "0");

function openPullRequests(opts, currentBranch) {
  const fields = "number,title,headRefName,isDraft,url,changedFiles,files";
  const prs = gh(
    opts,
    ["pr", "list", "--state", "open", "--limit", "200", "--json", fields],
    "gh pr list (is gh installed and authenticated?)"
  );
  if (!Array.isArray(prs)) fatal("gh pr list returned an unexpected shape");
  const others = [];
  let own;
  for (const pr of prs) {
    let files = (pr.files ?? []).map((file) => file.path);
    if (typeof pr.changedFiles === "number" && pr.changedFiles > files.length) {
      const full = gh(opts, ["pr", "view", String(pr.number), "--json", "files"], `gh pr view ${pr.number}`);
      files = (full.files ?? []).map((file) => file.path);
      if (pr.changedFiles > files.length) {
        console.warn(`warning: #${pr.number} lists ${files.length} of ${pr.changedFiles} files; overlap may be missed`);
      }
    }
    const entry = { ...pr, files };
    if (pr.headRefName === currentBranch) own = entry;
    else others.push(entry);
  }
  return { others, own };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const baseRef = `${opts.remote}/${opts.base}`;
  const refusals = [];
  const warnings = [];

  git(["rev-parse", "--is-inside-work-tree"], "git rev-parse (not inside a git work tree?)");
  if (opts.fetch) git(["fetch", "--prune", opts.remote], `git fetch ${opts.remote}`);
  git(["rev-parse", "--verify", "--quiet", `refs/remotes/${baseRef}^{commit}`], `resolving ${baseRef}`);
  const currentBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();

  // Migration numbers on main, in other open PRs, and added by this branch.
  const mainFiles = new Set(
    lines(git(["ls-tree", "-r", "--name-only", baseRef, "--", opts.migrationsDir], `listing ${baseRef} migrations`))
  );
  const mainMigrations = new Map();
  for (const path of mainFiles) {
    const n = migrationNumber(path, opts.migrationsDir);
    if (n !== undefined) mainMigrations.set(n, [...(mainMigrations.get(n) ?? []), path]);
  }
  const { others, own } = openPullRequests(opts, currentBranch);
  const prMigrations = new Map();
  for (const pr of others) {
    for (const path of pr.files) {
      const n = migrationNumber(path, opts.migrationsDir);
      if (n === undefined || mainFiles.has(path)) continue;
      prMigrations.set(n, [...(prMigrations.get(n) ?? []), { pr, path }]);
    }
  }
  const maxMain = Math.max(0, ...mainMigrations.keys());
  const nextFree = Math.max(maxMain, ...prMigrations.keys()) + 1;

  if (opts.nextMigration) {
    console.log(pad(nextFree));
    return 0;
  }

  // Staleness.
  const [behind, ahead] = git(["rev-list", "--left-right", "--count", `${baseRef}...HEAD`])
    .trim()
    .split(/\s+/)
    .map(Number);
  console.log(`branch ${currentBranch}: ${ahead} ahead, ${behind} behind ${baseRef}`);
  if (behind > 0) {
    refusals.push({
      code: EXIT.behind,
      message: `branch is ${behind} commit(s) behind ${baseRef}; rebase onto ${baseRef} (or start a fresh slice with scripts/new-slice.sh) first`
    });
  }
  if (git(["status", "--porcelain"]).trim()) {
    warnings.push("working tree has uncommitted changes; they are not part of this check");
  }

  // Files this branch changes.
  const changes = lines(git(["diff", "--name-status", "--no-renames", `${baseRef}...HEAD`])).map((line) => {
    const [status, path] = line.split("\t");
    return { status, path };
  });
  const changed = new Set(changes.map((change) => change.path));
  console.log(`${changed.size} file(s) changed vs ${baseRef}`);
  if (own) console.log(`this branch's open PR: #${own.number}${own.isDraft ? " (draft)" : ""} ${own.url ?? ""}`.trim());

  // Overlap with other open PRs.
  const overlaps = others
    .map((pr) => ({ pr, files: pr.files.filter((path) => changed.has(path)) }))
    .filter((entry) => entry.files.length > 0);
  if (overlaps.length === 0) {
    console.log(`no overlap with ${others.length} other open pull request(s)`);
  } else {
    console.log(`overlap with ${overlaps.length} open pull request(s):`);
    for (const { pr, files } of overlaps) {
      console.log(`  #${pr.number}${pr.isDraft ? " (draft)" : ""} ${pr.headRefName}: ${pr.title}`);
      for (const path of files) console.log(`    ${path}`);
    }
    const message = "open pull requests touch the same files; coordinate or wait for them to land before opening yours";
    if (opts.strict) refusals.push({ code: EXIT.overlap, message });
    else warnings.push(`${message} (rerun with --strict to refuse)`);
  }

  // Migration collisions for migrations this branch adds.
  const added = changes
    .filter((change) => change.status === "A")
    .map((change) => ({ path: change.path, n: migrationNumber(change.path, opts.migrationsDir) }))
    .filter((entry) => entry.n !== undefined);
  const seen = new Map();
  for (const { path, n } of added) {
    const label = `${path} (number ${pad(n)})`;
    if (seen.has(n)) {
      refusals.push({ code: EXIT.migration, message: `${label} reuses the number of ${seen.get(n)} in this branch` });
    }
    seen.set(n, path);
    if (mainMigrations.has(n)) {
      refusals.push({
        code: EXIT.migration,
        message: `${label} collides with ${baseRef}: ${mainMigrations.get(n).join(", ")}`
      });
    } else if (n < maxMain) {
      refusals.push({
        code: EXIT.migration,
        message: `${label} sorts before ${baseRef}'s latest migration ${pad(maxMain)}`
      });
    }
    for (const { pr, path: other } of prMigrations.get(n) ?? []) {
      refusals.push({ code: EXIT.migration, message: `${label} collides with open PR #${pr.number}: ${other}` });
    }
  }
  if (added.length > 0) console.log(`migrations added by this branch: ${added.map((entry) => entry.path).join(", ")}`);
  const prMax = Math.max(0, ...prMigrations.keys());
  console.log(
    `next free migration number: ${pad(nextFree)} (${baseRef} max ${pad(maxMain)}, other open PRs max ${prMax ? pad(prMax) : "none"})`
  );

  for (const warning of warnings) console.warn(`warning: ${warning}`);
  for (const refusal of refusals) console.error(`REFUSED: ${refusal.message}`);
  if (refusals.length === 0) {
    console.log("preflight ok");
    return 0;
  }
  return EXIT_PRIORITY.find((code) => refusals.some((refusal) => refusal.code === code));
}

process.exitCode = main();
