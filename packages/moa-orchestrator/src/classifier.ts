import type { RiskLevel } from "./types.js";

export type MoaMode = "off" | "cheap" | "fast" | "security";

export interface RoutableTask {
  risk: RiskLevel;
  kind: string;
  files?: string[];
  asksForReview?: boolean;
}

export const SECURITY_PATH_PATTERN =
  /(^|\/)(auth|oauth|mcp|gateway|policy|approval|lease|sandbox|secret|token|\.env|systemd|sudo|acl|permission|audit)/i;

const reviewKinds = new Set(["architecture", "debugging", "test_failure", "code_review", "implementation_plan"]);
const rank: Record<MoaMode, number> = { off: 0, cheap: 1, fast: 2, security: 3 };

export function chooseMoaMode(task: RoutableTask): MoaMode {
  if (task.risk === "high" || task.files?.some((file) => SECURITY_PATH_PATTERN.test(file))) {
    return "security";
  }
  if (reviewKinds.has(task.kind) || task.asksForReview) {
    return "fast";
  }
  return "off";
}

export function effectiveMode(requested: MoaMode | undefined, routed: MoaMode): MoaMode {
  if (!requested) return routed;
  return rank[requested] > rank[routed] ? requested : routed;
}
