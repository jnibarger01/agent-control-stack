import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { explainPolicy } from "./explain.js";
import { createPolicyEngine } from "./policy.js";
import { previewWorkItemPolicy } from "./preview.js";
import { createWorkItemTools } from "./tools.js";

interface GoldProbe {
  id: string;
  work_item: { target: Record<string, unknown> } & Record<string, unknown>;
  expected: { approval: string; policy_rule: string };
}

const goldFixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "decision-gold.fixture.json"), "utf8")
) as { probes: GoldProbe[] };

const statusToApproval = {
  approved: "auto",
  needs_approval: "require_approval",
  blocked: "deny"
} as const;

describe("decision-test gold probes P01-P15 (approval)", () => {
  let dir = "";
  let cwd = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "acs-policy-gold-"));
    cwd = join(dir, "sandbox");
    mkdirSync(join(cwd, "docs"), { recursive: true });
    mkdirSync(join(cwd, "storage/migrations"), { recursive: true });
    mkdirSync(join(cwd, "config"), { recursive: true });
    mkdirSync(join(cwd, "build"), { recursive: true });
    writeFileSync(join(cwd, "README.md"), "readme\n");
    writeFileSync(join(cwd, "docs/architecture.md"), "arch\n");
    writeFileSync(join(cwd, ".env"), "SECRET=1\n");
    writeFileSync(join(cwd, "config/prod.yaml"), "x: 1\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  for (const probe of goldFixture.probes) {
    it(`${probe.id} approval is ${probe.expected.approval}`, () => {
      const store = new SqliteWorkItemStore(join(dir, `${probe.id}.db`));
      const policy = createPolicyEngine();
      const tools = createWorkItemTools(store, policy);
      try {
        const input = {
          ...probe.work_item,
          target: { ...probe.work_item.target, cwd }
        };
        const created = tools.create_work_item(input);
        const approval = statusToApproval[created.status as keyof typeof statusToApproval] ?? created.status;
        // Gold records a deny for these, taken before argv review existed. Both declare paths inside the
        // workspace, so the old rules auto-approved them; under the admin-mode spec an authorized execution
        // request waits for approval (and admin mode auto-approves it) instead of being hard-denied. The
        // rule id is the new approval rule because the outcome changed. gold.json is deliberately not edited.
        // P11 declares no paths, so the old rules denied it with deny:fail-closed and it stays exactly that.
        const adminSpecApproval: Record<string, string> = {
          P08: "require_approval",
          P10: "require_approval"
        };
        expect(approval, `${probe.id} approval`).toBe(adminSpecApproval[probe.id] ?? probe.expected.approval);

        const evaluations = policy.evaluateWorkItem(created, created.requester, "create");
        const summary = policy.summarize(evaluations);
        if (adminSpecApproval[probe.id]) {
          expect(summary.matchedRules).toContain("approval:command-review");
        } else if (probe.id === "P11") {
          expect(summary.matchedRules).toContain("deny:destructive");
        } else {
          expect(summary.matchedRules).toContain(probe.expected.policy_rule);
        }

        const preview = previewWorkItemPolicy(policy, input);
        const previewApproval =
          preview.outcome === "auto_admitted"
            ? "auto"
            : preview.outcome === "needs_approval"
              ? "require_approval"
              : "deny";
        expect(previewApproval, `${probe.id} preview`).toBe(adminSpecApproval[probe.id] ?? probe.expected.approval);

        for (const evaluation of evaluations) {
          const explained = explainPolicy(evaluation.context);
          expect(explained.decision, `${probe.id} explain`).toBe(evaluation.decision.decision);
          expect(explained.matchedRules).toEqual(evaluation.decision.matchedRules);
        }
      } finally {
        store.close();
      }
    });
  }
});
