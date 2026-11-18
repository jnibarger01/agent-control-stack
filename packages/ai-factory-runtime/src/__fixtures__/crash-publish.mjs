// Test fixture: run the real F8 publisher and SIGKILL this process at a chosen crash window.
// Also exports a file-backed fake GitHub remote so state survives the process boundary.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function createFileRemote(file, onStep = () => undefined) {
  const load = () => {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return { branches: {}, pulls: [], creates: 0 };
    }
  };
  const save = (state) => writeFileSync(file, JSON.stringify(state));
  return {
    async branchHead(branch) {
      onStep("branchHead");
      return load().branches[branch];
    },
    async pushFactoryBranch(branch, sha) {
      onStep("before_push");
      const state = load();
      if (state.branches[branch] && state.branches[branch] !== sha) throw new Error("non-fast-forward");
      state.branches[branch] = sha;
      save(state);
      onStep("after_push");
    },
    async findOpenPull(head) {
      return load().pulls.find((pull) => pull.head === head)?.pull;
    },
    async createDraftPull(input) {
      const state = load();
      state.creates += 1;
      const pull = { number: state.pulls.length + 1, url: "https://github.test/pull/" + (state.pulls.length + 1), headSha: state.branches[input.headBranch], draft: true };
      state.pulls.push({ head: input.headBranch, pull });
      save(state);
      onStep("after_create");
      return pull;
    }
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dbPath, repoDir, remoteFile, checkpoint, approvalJson, inputJson] = process.argv.slice(2);
  const { CodingMissionStore } = await import("@agent-control-stack/coding-mission");
  const { publishFactoryDraft, createFactoryGitReader } = await import("@agent-control-stack/ai-factory-runtime");
  const store = new CodingMissionStore(dbPath);
  const approval = JSON.parse(approvalJson);
  const remote = createFileRemote(remoteFile, (step) => {
    if (step === checkpoint) process.kill(process.pid, "SIGKILL");
  });
  const result = await publishFactoryDraft(
    { store, approvals: { get: () => approval }, remote, git: createFactoryGitReader(repoDir) },
    JSON.parse(inputJson)
  );
  process.stdout.write(JSON.stringify(result));
  store.close();
}
