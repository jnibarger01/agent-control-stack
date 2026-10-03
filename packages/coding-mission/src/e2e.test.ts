import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NIMBLE_ROUTING_ALGORITHM_VERSION } from "@agent-control-stack/actor-router";
import { afterEach, describe, expect, it } from "vitest";
import { CodingMissionController, type ExternalOutcome } from "./index.js";

const NOW = "2026-10-02T15:00:00.000Z";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "ACS",
      GIT_AUTHOR_EMAIL: "acs@example.test",
      GIT_COMMITTER_NAME: "ACS",
      GIT_COMMITTER_EMAIL: "acs@example.test"
    }
  }).trim();
}

function ok<T>(value: T): ExternalOutcome<T> {
  return { status: "succeeded", value };
}

describe("coding mission end to end", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("prepares, approves once, merges, restarts, and does not repeat side effects", async () => {
    root = mkdtempSync(join(tmpdir(), "acs-coding-e2e-"));
    const repo = join(root, "repo");
    execFileSync("git", ["init", "-b", "main", repo]);
    writeFileSync(join(repo, "README.md"), "base\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "base"]);
    const baseSha = git(repo, ["rev-parse", "HEAD"]);
    const calls = { execute: 0, prCreates: 0, merge: 0, deploy: 0, verify: 0, completionReads: 0 };
    let pull: { prNumber: number; prUrl: string; headSha: string } | undefined;
    let mergeSha = "";
    const dbPath = join(root, "control.db");
    const ports = {
      now: () => NOW,
      deploymentPolicy: { requirement: () => ({ required: true, action: "restart", impact: "gateway restart" }) },
      planner: {
        decompose: () => [{ operationId: "edit-readme", dependsOn: [], title: "document the change" }]
      },
      router: {
        route: async () => ({
          workerId: "semantic-winner",
          algorithm: NIMBLE_ROUTING_ALGORITHM_VERSION,
          decision: { algorithm: NIMBLE_ROUTING_ALGORITHM_VERSION, selected: "semantic-winner" }
        })
      },
      coder: {
        execute: async () => {
          calls.execute += 1;
          writeFileSync(join(repo, "README.md"), "base\nprepared\n");
          return ok({ resultHash: "readme-prepared", files: ["README.md"] });
        },
        observe: async () => ({ status: "absent" as const })
      },
      reconciler: {
        reconcile: async () => {
          git(repo, ["checkout", "-B", "acs/mission/mission-e2e"]);
          git(repo, ["add", "README.md"]);
          git(repo, ["commit", "-m", "prepare change set"]);
          return ok({ headSha: git(repo, ["rev-parse", "HEAD"]), conflicts: [] });
        }
      },
      validator: {
        validate: async () =>
          ok({
            checks: {
              tests: "PASS" as const,
              typecheck: "PASS" as const,
              lint: "PASS" as const,
              format: "PASS" as const,
              repository: "PASS" as const,
              review: "PASS" as const
            },
            risks: ["touches the gateway readme"]
          })
      },
      publisher: {
        publish: async () => {
          if (!pull) {
            calls.prCreates += 1;
            pull = { prNumber: 123, prUrl: "https://example.test/pull/123", headSha: git(repo, ["rev-parse", "HEAD"]) };
          }
          return ok(pull);
        },
        observe: async () => (pull ? ok(pull) : { status: "absent" as const })
      },
      baseObserver: { currentBaseSha: async () => baseSha },
      admission: { acquire: async () => ({ permitId: "permit-e2e" }) },
      merger: {
        merge: async () => {
          calls.merge += 1;
          git(repo, ["checkout", "main"]);
          git(repo, ["merge", "--no-ff", "acs/mission/mission-e2e", "-m", "merge change set"]);
          mergeSha = git(repo, ["rev-parse", "HEAD"]);
          return ok({ mergeSha });
        },
        observe: async () => (mergeSha ? ok({ mergeSha }) : { status: "absent" as const })
      },
      deployer: {
        deploy: async ({ mergeSha: deployed }: { mergeSha: string }) => {
          calls.deploy += 1;
          writeFileSync(join(repo, "release-id"), `${deployed}\n`);
          return ok({ deploymentId: "restart-1" });
        },
        observe: async () => ({ status: "absent" as const })
      },
      verifier: {
        verify: async ({ mission }: { mission: { mergeSha?: string } }) => {
          calls.verify += 1;
          const head = git(repo, ["rev-parse", "HEAD"]);
          const release = readFileSync(join(repo, "release-id"), "utf8").trim();
          return { passed: head === mission.mergeSha && release === mission.mergeSha, checks: { release: "PASS" } };
        }
      }
    };
    const mission = new CodingMissionController(dbPath, ports);
    mission.create({
      missionId: "mission-e2e",
      repository: "example/repo",
      baseRef: "main",
      baseSha,
      summary: "Document the release"
    });
    const waiting = await mission.runUntilStable("mission-e2e");
    expect(waiting.state).toBe("WAITING_FOR_APPROVAL");
    expect(calls.merge).toBe(0);
    expect(calls.deploy).toBe(0);
    expect(calls.prCreates).toBe(1);
    expect(git(repo, ["rev-parse", "HEAD"])).not.toBe(baseSha);
    const view = mission.approvalView("mission-e2e");
    expect(view.pullRequest?.number).toBe(123);
    expect(view.approvalAction).toBe("APPROVE_CHANGE_SET");
    const completed = await mission.approve("mission-e2e", {
      approverId: "human",
      expectedChangeSetHash: waiting.changeSetHash!
    });
    expect(completed.state).toBe("COMPLETED");
    expect(calls).toMatchObject({ execute: 1, prCreates: 1, merge: 1, deploy: 1, verify: 1 });
    expect(readFileSync(join(repo, "release-id"), "utf8").trim()).toBe(mergeSha);
    mission.close();

    const restarted = new CodingMissionController(dbPath, ports);
    calls.completionReads = restarted.store
      .events("mission-e2e")
      .filter((event) => event.name === "coding_mission.completed").length;
    const replay = await restarted.runUntilStable("mission-e2e");
    expect(replay.state).toBe("COMPLETED");
    expect(calls).toMatchObject({ execute: 1, prCreates: 1, merge: 1, deploy: 1, verify: 1, completionReads: 1 });
    expect(
      restarted.store.events("mission-e2e").filter((event) => event.name === "coding_mission.completed")
    ).toHaveLength(1);
    restarted.close();
  });
});
