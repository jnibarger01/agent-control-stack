import {
  classifierEvidenceSchema,
  missionIntakeHash,
  missionIntakeSchema,
  type ClassifierEvidence,
  type MissionIntake,
} from "@agent-control-stack/work-items";

export const MISSION_CLASSIFIER_VERSION = "mission-router-compat@1";

const TASK_RULES = [
  ["system_admin", "task.system_admin.system-control", /\b(systemd|systemctl|daemon|apt(-get)?|dpkg|reboot|kernel|crontab|cron\b|firewall|ufw|nginx|docker|service\s+(re)?start|mount|fstab)\b/i],
  ["browser_scrape", "task.browser_scrape.web-extraction", /\b(scrape|scraping|browser|webpage|web\s*page|crawl|extract\s+from\s+(the\s+)?(site|page|url)|screenshot\s+of\s+http|dom\b)\b/i],
  ["deal_analysis", "task.deal_analysis.market", /\b(deal|listing|comps?\b|resale|flip(ping)?|ebay|craigslist|marketplace|arbitrage|msrp|price\s+(check|compare|history))\b/i],
  ["memory_lookup", "task.memory_lookup.recall", /\b(remember|recall|what\s+was\s+i|last\s+(night|session|week|checkpoint)|working\s+on\s+last|memory\s+(lookup|search))\b/i],
  ["coding", "task.coding.software", /\b(code|coding|implement|bug|fix|refactor|unit\s*test|tests?\b|typecheck|lint|function|class\b|module|compile|merge|commit|pull\s+request|repo(sitory)?)\b/i],
  ["research", "task.research.investigate", /\b(research|investigate|summari[sz]e|survey|compare\s+\w+|look\s*up|find\s+out|read\s+(the\s+)?(paper|docs?|spec)|explain)\b/i],
] as const;

const RISK_RULES = [
  ["destructive", "risk.destructive.irreversible", /\b(rm\s+-rf?|force[-\s]?push|push\s+--force|reset\s+--hard|drop\s+(table|database|schema)|delete\s+(the\s+)?(repo|branch|database|user|account)|wipe|erase|format\s+\S*\s*(disk|drive|partition)|truncate|shred|revoke|uninstall|purge|destroy)\b/i],
  ["write", "risk.write.mutation", /\b(implement|fix|refactor|merge|commit|push|deploy|install|upgrade|migrate|write|create|update|rename|move|patch|apply|modify|edit|configure|enable|disable|restart)\b/i],
  ["draft", "risk.draft.proposal", /\b(draft|propose|design|plan|outline|sketch|spec\s+out)\b/i],
] as const;

const SENSITIVITY_RULES = [
  ["credential", "sensitivity.credential", /password|passphrase|secret(?!ar)|token(?!i[sz])|api[\s_-]?key|credential|ssh[\s_-]?key|private[\s_-]?key|keychain|keyring|\.env\b|\bvault\b|oauth|\b(2fa|mfa|otp)\b|certificate|bearer\b|\bgpg\b|\bpgp\b/i],
  ["financial", "sensitivity.financial", /refund|invoice|\bpayment|payout|wire\s+(transfer|money|funds)|bank\s+(account|transfer)|credit\s*card|debit\s*card|\biban\b|routing\s+number|paypal|venmo|zelle|cash\s?app|\bstripe\b|charge\s+(the\s+)?(card|customer)|billing|\bpurchase|checkout\s+(the\s+)?(page|flow|form|cart)|place\s+(an?\s+)?order|\bcustomer/i],
] as const;

const RISK_RANK = { read_only: 0, draft: 1, write: 2, destructive: 3, unknown: 4 } as const;
type Risk = keyof typeof RISK_RANK;

type ClassifierContext = { evidenceId: string; generatedAt: string };

export function classifyMissionIntake(input: unknown, context: ClassifierContext): ClassifierEvidence {
  const intake = missionIntakeSchema.parse(input);
  const task = firstRule(intake.goal, TASK_RULES, "unknown");
  const inferredRisk = firstRule(intake.goal, RISK_RULES, "read_only");
  const declaredRisk = intake.submittedClaims?.risk ?? "read_only";
  const risk = maxRisk(declaredRisk, inferredRisk.value);
  const sensitivity = allRules(intake.goal, SENSITIVITY_RULES);

  return classifierEvidenceSchema.parse({
    schemaVersion: "acs.classifier-evidence.v1",
    evidenceId: context.evidenceId,
    classifier: { id: "mission-router-compat", version: MISSION_CLASSIFIER_VERSION },
    subjectIntakeHash: missionIntakeHash(intake),
    generatedAt: context.generatedAt,
    taskType: { recommendation: task.value, signals: task.ruleIds.map((ruleId) => ({ ruleId })) },
    risk: { recommendation: risk, signals: inferredRisk.ruleIds.map((ruleId) => ({ ruleId })) },
    sensitivity: { categories: sensitivity.values, signals: sensitivity.ruleIds.map((ruleId) => ({ ruleId })) },
    authoritative: false,
  });
}

function firstRule<T extends string>(goal: string, rules: readonly (readonly [T, string, RegExp])[], fallback: T) {
  for (const [value, ruleId, pattern] of rules) {
    if (pattern.test(goal)) return { value, ruleIds: [ruleId] };
  }
  return { value: fallback, ruleIds: [] as string[] };
}

function allRules<T extends string>(goal: string, rules: readonly (readonly [T, string, RegExp])[]) {
  const values: T[] = [];
  const ruleIds: string[] = [];
  for (const [value, ruleId, pattern] of rules) {
    if (pattern.test(goal)) {
      values.push(value);
      ruleIds.push(ruleId);
    }
  }
  return { values, ruleIds };
}

function maxRisk(left: Risk, right: Risk): Risk {
  return RISK_RANK[left] >= RISK_RANK[right] ? left : right;
}

export function assertMissionIntake(input: unknown): MissionIntake {
  return missionIntakeSchema.parse(input);
}
