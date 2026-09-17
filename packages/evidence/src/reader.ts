import { execFile } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { redactValue } from "@agent-control-stack/shared";
import type {
  AuditExcerptInput,
  EvidenceReadSurface,
  ListDirectoryInput,
  ReadFileInput,
  SearchWorkspaceInput
} from "./read-surface.js";

const execFileAsync = promisify(execFile);

const MAX_READ_BYTES = 256 * 1024;
const restrictedPathPattern =
  /(^|\/)(\.env(\.|$)|\.git\/config$|id_rsa$|id_ed25519$|\.ssh(\/|$)|\.aws\/credentials$|\.npmrc$|\.netrc$|credentials(\.json)?$|token(\.json)?$)/i;

/** Narrow READ-ONLY view of ACS state the reader needs. No mutators. */
export interface EvidenceStoreReader {
  getWorkItemSummary(workItemId: string): unknown;
  getAttemptSummary(attemptId: string): unknown;
  getWorkspaceAllocationSummary(attemptId: string): unknown;
  getValidationRunSummary(attemptId: string): unknown;
  getExecutionPlanSummary(workItemId: string): unknown;
  getExecutionSummary(workItemId: string): unknown;
  getSandboxSummary(attemptId: string): unknown;
  getPolicyDecisions(workItemId: string): unknown;
  getApprovalSummary(workItemId: string): unknown;
  getAuditExcerpt(workItemId: string, options: { limit?: number; afterSequence?: number }): unknown;
  getEvidenceManifest(attemptId: string): unknown;
}

export interface EvidenceReaderContext {
  workItemId: string;
  attemptId: string;
  workspaceHostPath: string;
  gitPath?: string;
  store: EvidenceStoreReader;
}

function containWithin(root: string, requested: string): string {
  if (typeof requested !== "string" || requested.length === 0 || requested.includes("\0")) {
    throw new Error("evidence_read_path_invalid");
  }
  if (requested.split(/[/\\]/).includes("..")) throw new Error("evidence_read_path_escape");
  const canonicalRoot = realpathSync(root);
  const absolute = isAbsolute(requested) ? resolve(requested) : resolve(canonicalRoot, requested);
  let canonical: string;
  try {
    canonical = realpathSync(absolute);
  } catch {
    canonical = absolute;
  }
  if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${sep}`)) {
    throw new Error("evidence_read_path_outside_workspace");
  }
  if (restrictedPathPattern.test(requested) || restrictedPathPattern.test(canonical)) {
    throw new Error("evidence_read_path_restricted");
  }
  return canonical;
}

/**
 * Attempt-scoped, read-only evidence reader. Implements exactly
 * `EvidenceReadSurface` — every method observes, none acts.
 */
export class EvidenceReader implements EvidenceReadSurface {
  private readonly gitPath: string;

  constructor(private readonly ctx: EvidenceReaderContext) {
    this.gitPath = ctx.gitPath ?? "git";
  }

  work_item_info = async (): Promise<unknown> =>
    redactValue(this.ctx.store.getWorkItemSummary(this.ctx.workItemId));

  attempt_info = async (): Promise<unknown> =>
    redactValue(this.ctx.store.getAttemptSummary(this.ctx.attemptId));

  workspace_info = async (): Promise<unknown> =>
    redactValue(this.ctx.store.getWorkspaceAllocationSummary(this.ctx.attemptId));

  read_file = async (input: ReadFileInput): Promise<unknown> => {
    const path = containWithin(this.ctx.workspaceHostPath, input.path);
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error("evidence_read_not_a_file");
    const buffer = readFileSync(path);
    if (buffer.includes(0)) return { path: input.path, binary: true, sizeBytes: stat.size };
    const text = buffer.toString("utf8");
    const offset = Math.max(0, input.offset ?? 0);
    const length = Math.min(input.length ?? text.length, MAX_READ_BYTES);
    const slice = text.slice(offset, offset + length);
    return {
      path: input.path,
      sizeBytes: stat.size,
      offset,
      length: slice.length,
      truncated: offset + slice.length < text.length,
      content: redactValue(slice)
    };
  };

  list_directory = async (input: ListDirectoryInput): Promise<unknown> => {
    const root = containWithin(this.ctx.workspaceHostPath, input.path);
    const depth = Math.min(Math.max(1, input.depth ?? 1), 4);
    const entries: Array<{ path: string; kind: string; sizeBytes: number }> = [];
    const walk = (dir: string, level: number): void => {
      for (const name of readdirSync(dir).sort()) {
        if (name === ".git") continue;
        const full = join(dir, name);
        let s;
        try {
          s = statSync(full);
        } catch {
          continue;
        }
        entries.push({
          path: full.slice(realpathSync(this.ctx.workspaceHostPath).length + 1),
          kind: s.isDirectory() ? "directory" : s.isFile() ? "file" : "other",
          sizeBytes: s.size
        });
        if (s.isDirectory() && level < depth) walk(full, level + 1);
        if (entries.length >= 5_000) return;
      }
    };
    walk(root, 1);
    return { path: input.path, entries };
  };

  search_workspace = async (input: SearchWorkspaceInput): Promise<unknown> => {
    const base = input.path ? containWithin(this.ctx.workspaceHostPath, input.path) : this.ctx.workspaceHostPath;
    const max = Math.min(Math.max(1, input.maxResults ?? 100), 500);
    const needle = input.query.toLowerCase();
    const matches: Array<{ path: string; line: number; text: string }> = [];
    const root = realpathSync(this.ctx.workspaceHostPath);
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        if (name === ".git" || name === "node_modules" || name === "dist") continue;
        const full = join(dir, name);
        let s;
        try {
          s = statSync(full);
        } catch {
          continue;
        }
        if (s.isDirectory()) {
          walk(full);
          continue;
        }
        if (!s.isFile() || s.size > MAX_READ_BYTES) continue;
        const buffer = readFileSync(full);
        if (buffer.includes(0)) continue;
        buffer
          .toString("utf8")
          .split("\n")
          .forEach((line, index) => {
            if (matches.length < max && line.toLowerCase().includes(needle)) {
              matches.push({
                path: full.slice(root.length + 1),
                line: index + 1,
                text: String(redactValue(line.slice(0, 400)))
              });
            }
          });
        if (matches.length >= max) return;
      }
    };
    walk(base);
    return { query: input.query, matches };
  };

  git_status = async (): Promise<unknown> => ({
    porcelain: await this.git(["status", "--porcelain=v1", "--untracked-files=all"])
  });

  git_diff = async (): Promise<unknown> => {
    const diff = await this.git(["--no-pager", "diff", "--stat", "HEAD"]);
    const full = await this.git(["--no-pager", "diff", "HEAD"]);
    return { stat: diff, patch: full.slice(0, MAX_READ_BYTES), truncated: full.length > MAX_READ_BYTES };
  };

  git_changed_files = async (): Promise<unknown> => {
    const out = await this.git(["--no-pager", "diff", "--name-only", "HEAD"]);
    return { files: out.split("\n").map((f) => f.trim()).filter(Boolean) };
  };

  test_runs = async (): Promise<unknown> =>
    redactValue(this.ctx.store.getValidationRunSummary(this.ctx.attemptId));

  test_output = async (): Promise<unknown> =>
    redactValue(this.ctx.store.getValidationRunSummary(this.ctx.attemptId));

  execution_summary = async (): Promise<unknown> =>
    redactValue(this.ctx.store.getExecutionSummary(this.ctx.workItemId));

  sandbox_summary = async (): Promise<unknown> =>
    redactValue(this.ctx.store.getSandboxSummary(this.ctx.attemptId));

  policy_decision = async (): Promise<unknown> =>
    redactValue(this.ctx.store.getPolicyDecisions(this.ctx.workItemId));

  approval_summary = async (): Promise<unknown> =>
    redactValue(this.ctx.store.getApprovalSummary(this.ctx.workItemId));

  audit_excerpt = async (input: AuditExcerptInput): Promise<unknown> =>
    redactValue(
      this.ctx.store.getAuditExcerpt(this.ctx.workItemId, {
        limit: Math.min(Math.max(1, input.limit ?? 50), 200),
        ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence })
      })
    );

  evidence_manifest = async (): Promise<unknown> =>
    redactValue(this.ctx.store.getEvidenceManifest(this.ctx.attemptId));

  private async git(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync(this.gitPath, args, {
        cwd: this.ctx.workspaceHostPath,
        maxBuffer: 16 * 1024 * 1024
      });
      return stdout;
    } catch (error) {
      const failure = error as { stdout?: string };
      return failure.stdout ?? "";
    }
  }
}
