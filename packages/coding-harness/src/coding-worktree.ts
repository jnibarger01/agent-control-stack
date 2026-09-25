import path from "node:path";

export interface CodingWorkspace {
  taskId: string;
  root: string;
  worktree: string;
  baseCommit: string;
  branch: string;
}
export interface WorkspaceAuthority {
  provision(input: { taskId: string; repoRoot: string; baseCommit: string }): Promise<CodingWorkspace>;
}
export class CodingWorktreeManager {
  constructor(private readonly authority: WorkspaceAuthority) {}
  async provision(taskId: string, repoRoot: string, baseCommit: string): Promise<CodingWorkspace> {
    if (!/^[A-Za-z0-9._:-]{6,128}$/.test(taskId)) throw new TypeError("task id is invalid");
    if (path.resolve(repoRoot) !== repoRoot || path.sep !== "/")
      throw new TypeError("repository root must be absolute");
    if (!/^[a-f0-9]{7,64}$/.test(baseCommit)) throw new TypeError("base commit is invalid");
    const workspace = await this.authority.provision({ taskId, repoRoot, baseCommit });
    const root = path.resolve(workspace.worktree);
    if (root !== path.resolve(repoRoot) && !root.startsWith(`${path.resolve(repoRoot)}${path.sep}`))
      throw new Error("worktree escapes repository root");
    return workspace;
  }
}
